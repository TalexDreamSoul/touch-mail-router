import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { verifySignature } from "./crypto.js";
import { AppDb, verifyPassword, type ApiKeyScope, type User, type UserRole } from "./db.js";
import { createAiNativeApp } from "./ai-native.js";
import { createDuckMailApp } from "./duckmail.js";
import { parseRawEmail } from "./parse.js";
import { buildWorkerSnippet } from "./worker-snippet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

const config = loadConfig();
const db = new AppDb(config.DATA_DIR);
await db.init();

// seed API keys from env (dk_xxx,...)
if (config.API_KEYS) {
  for (const k of config.API_KEYS.split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      await db.addApiKey(k);
    } catch {
      /* ignore invalid */
    }
  }
}

type Vars = { user: User };

const app = new Hono<{ Variables: Vars }>();
app.use("*", logger());

// Allow Next.js admin (dev + same origin production via reverse proxy)
app.use(
  "/api/*",
  cors({
    origin: (origin) => origin || "*",
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// AI-native + DuckMail public APIs also need CORS for agent tools
app.use(
  "/ai/*",
  cors({
    origin: (origin) => origin || "*",
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// AI-native agent API (/ai/v1/*)
const aiApp = createAiNativeApp(db, config);
app.route("/", aiApp);

// DuckMail-compatible public API (paths match api.duckmail.sbs)
// Only intercept DuckMail paths so the legacy SPA can still serve other routes.
const duck = createDuckMailApp(db, config);
const duckPrefixes = [
  "/domains",
  "/accounts",
  "/token",
  "/me",
  "/messages",
  "/sources",
  "/dm",
];
app.use("*", async (c, next) => {
  const p = c.req.path;
  // let AI-native handle its own paths (already routed)
  if (p === "/ai" || p.startsWith("/ai/")) return next();
  const hit = duckPrefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));
  if (!hit) return next();
  // /dm/* → /* so the same handler works under an explicit prefix
  if (p === "/dm" || p.startsWith("/dm/")) {
    const url = new URL(c.req.url);
    url.pathname = p === "/dm" ? "/" : p.slice(3);
    return duck.fetch(new Request(url.toString(), c.req.raw));
  }
  return duck.fetch(c.req.raw);
});

const SESSION_COOKIE = "tm_session";

function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    tenant: u.tenant,
    displayName: u.displayName,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    inboundAddress: `${u.tenant}@${config.INBOUND_DOMAIN}`,
  };
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    ""
  );
}

function setSessionCookie(c: Parameters<typeof setCookie>[0], sessionId: string) {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    path: "/",
    sameSite: "Lax",
    secure: config.COOKIE_SECURE,
    maxAge: 30 * 24 * 3600,
  });
}

async function requireUser(c: Context<{ Variables: Vars }>, next: Next) {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return c.json({ error: "未登录" }, 401);
  const session = db.getSession(sid);
  if (!session) return c.json({ error: "会话已失效" }, 401);
  const user = db.findUserById(session.userId);
  if (!user) return c.json({ error: "用户不存在" }, 401);
  if (user.status === "disabled") return c.json({ error: "账号已禁用" }, 403);
  c.set("user", user);
  await next();
}

async function requireAdmin(c: Context<{ Variables: Vars }>, next: Next) {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return c.json({ error: "未登录" }, 401);
  const session = db.getSession(sid);
  if (!session) return c.json({ error: "会话已失效" }, 401);
  const user = db.findUserById(session.userId);
  if (!user) return c.json({ error: "用户不存在" }, 401);
  if (user.status === "disabled") return c.json({ error: "账号已禁用" }, 403);
  if (user.role !== "admin") return c.json({ error: "需要管理员权限" }, 403);
  c.set("user", user);
  await next();
}

function pageParams(c: { req: { query: (k: string) => string | undefined } }) {
  return {
    q: c.req.query("q") || undefined,
    page: Number(c.req.query("page") || 1),
    pageSize: Number(c.req.query("pageSize") || 20),
  };
}

// ---------- public config ----------
app.get("/api/config", (c) =>
  c.json({
    appName: config.APP_NAME,
    publicUrl: config.PUBLIC_URL,
    inboundDomain: config.INBOUND_DOMAIN,
    webhookPath: "/v1/inbound",
  }),
);

app.get("/health", (c) =>
  c.json({ ok: true, service: "touch-mail-router", time: new Date().toISOString() }),
);

// ---------- auth ----------
app.post("/api/auth/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || "");
  const password = String(body.password || "");
  const displayName = String(body.displayName || "");
  try {
    const user = await db.createUser({ username, password, displayName });
    const session = await db.createSession(user.id);
    setSessionCookie(c, session.id);
    await db.addAudit({
      actorId: user.id,
      actorUsername: user.username,
      action: "register",
      resource: "user",
      resourceId: user.id,
      ip: clientIp(c),
    });
    return c.json({ ok: true, user: publicUser(user) }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "注册失败" }, 400);
  }
});

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = String(body.username || "").toLowerCase().trim();
  const password = String(body.password || "");
  const user = db.findUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    await db.addAudit({
      actorUsername: username || null,
      action: "login_failed",
      resource: "auth",
      detail: "invalid credentials",
      ip: clientIp(c),
    });
    return c.json({ error: "用户名或密码错误" }, 401);
  }
  if (user.status === "disabled") {
    return c.json({ error: "账号已禁用" }, 403);
  }
  const session = await db.createSession(user.id);
  setSessionCookie(c, session.id);
  await db.addAudit({
    actorId: user.id,
    actorUsername: user.username,
    action: "login",
    resource: "auth",
    ip: clientIp(c),
  });
  return c.json({ ok: true, user: publicUser(user) });
});

app.post("/api/auth/logout", async (c) => {
  const sid = getCookie(c, SESSION_COOKIE);
  const session = sid ? db.getSession(sid) : undefined;
  const user = session ? db.findUserById(session.userId) : undefined;
  if (sid) await db.deleteSession(sid);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  if (user) {
    await db.addAudit({
      actorId: user.id,
      actorUsername: user.username,
      action: "logout",
      resource: "auth",
      ip: clientIp(c),
    });
  }
  return c.json({ ok: true });
});

app.get("/api/auth/me", async (c) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return c.json({ user: null });
  const session = db.getSession(sid);
  if (!session) return c.json({ user: null });
  const user = db.findUserById(session.userId);
  if (!user || user.status === "disabled") return c.json({ user: null });
  return c.json({ user: publicUser(user) });
});

// ---------- dashboard ----------
app.get("/api/dashboard", requireUser, async (c) => {
  const user = c.get("user");
  const mailPage = await db.listMails(user.tenant, { pageSize: 8 });
  const domains = db.listDomains(user.id);
  const global = user.role === "admin" ? db.globalStats() : null;
  return c.json({
    user: publicUser(user),
    inboundAddress: `${user.tenant}@${config.INBOUND_DOMAIN}`,
    inboundDomain: config.INBOUND_DOMAIN,
    domainCount: domains.length,
    mailCount: mailPage.total,
    lastMailAt: mailPage.items[0]?.receivedAt || null,
    recentMails: mailPage.items,
    domains,
    global,
  });
});

// ---------- domains (tenant) ----------
app.get("/api/domains", requireUser, (c) => {
  const user = c.get("user");
  const { q, page, pageSize } = pageParams(c);
  let items = db.listDomains(user.id);
  if (q) {
    const qq = q.toLowerCase();
    items = items.filter(
      (d) => d.domain.includes(qq) || (d.note || "").toLowerCase().includes(qq),
    );
  }
  const total = items.length;
  const start = (page - 1) * pageSize;
  return c.json({
    items: items.slice(start, start + pageSize),
    total,
    page,
    pageSize,
  });
});

app.post("/api/domains", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const visibility =
      body.visibility === "public" || body.visibility === "private"
        ? body.visibility
        : "private";
    const domain = await db.addDomain(
      user.id,
      String(body.domain || ""),
      String(body.note || ""),
      visibility,
    );
    await db.addAudit({
      actorId: user.id,
      actorUsername: user.username,
      action: "create",
      resource: "domain",
      resourceId: domain.id,
      detail: `${domain.domain} (${domain.visibility})`,
      ip: clientIp(c),
    });
    return c.json({ ok: true, domain }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "添加失败" }, 400);
  }
});

app.patch("/api/domains/:id", requireUser, async (c) => {
  const user = c.get("user");
  const domainId = c.req.param("id") || "";
  const body = await c.req.json().catch(() => ({}));
  const domain = await db.updateDomain(user.id, domainId, {
    note: body.note !== undefined ? String(body.note) : undefined,
    visibility:
      body.visibility === "public" || body.visibility === "private"
        ? body.visibility
        : undefined,
  });
  if (!domain) return c.json({ error: "未找到域名" }, 404);
  await db.addAudit({
    actorId: user.id,
    actorUsername: user.username,
    action: "update",
    resource: "domain",
    resourceId: domain.id,
    detail: `${domain.domain} visibility=${domain.visibility}`,
    ip: clientIp(c),
  });
  return c.json({ ok: true, domain });
});

app.delete("/api/domains/:id", requireUser, async (c) => {
  const user = c.get("user");
  const domainId = c.req.param("id") || "";
  const ok = await db.removeDomain(user.id, domainId);
  if (!ok) return c.json({ error: "未找到域名" }, 404);
  await db.addAudit({
    actorId: user.id,
    actorUsername: user.username,
    action: "delete",
    resource: "domain",
    resourceId: domainId,
    ip: clientIp(c),
  });
  return c.json({ ok: true });
});

// ---------- personal: API keys + call history + docs ----------
function parseScopes(raw: unknown): ApiKeyScope[] {
  if (!Array.isArray(raw)) return ["read", "write"];
  const out: ApiKeyScope[] = [];
  for (const s of raw) {
    if (s === "read" || s === "write") out.push(s);
  }
  return out.length ? [...new Set(out)] : ["read", "write"];
}

app.get("/api/settings/api-keys", requireUser, (c) => {
  // legacy path — same as /api/me/api-keys
  const user = c.get("user");
  return c.json({ items: db.listUserApiKeys(user.id) });
});

app.get("/api/me/api-keys", requireUser, (c) => {
  const user = c.get("user");
  return c.json({ items: db.listUserApiKeys(user.id) });
});

app.post("/api/me/api-keys", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const created = await db.createUserApiKey(
      user.id,
      String(body.name || ""),
      parseScopes(body.scopes),
    );
    await db.addAudit({
      actorId: user.id,
      actorUsername: user.username,
      action: "create",
      resource: "api_key",
      resourceId: created.id,
      detail: `${created.name} scopes=${created.scopes.join(",")}`,
      ip: clientIp(c),
    });
    return c.json({ ok: true, key: created }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "创建失败" }, 400);
  }
});

// keep legacy create path
app.post("/api/settings/api-keys", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const created = await db.createUserApiKey(
      user.id,
      String(body.name || ""),
      parseScopes(body.scopes),
    );
    return c.json({ ok: true, key: created }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "创建失败" }, 400);
  }
});

app.patch("/api/me/api-keys/:id", requireUser, async (c) => {
  const user = c.get("user");
  const keyId = c.req.param("id") || "";
  const body = await c.req.json().catch(() => ({}));
  try {
    const item = await db.updateUserApiKey(user.id, keyId, {
      name: body.name !== undefined ? String(body.name) : undefined,
      scopes: body.scopes !== undefined ? parseScopes(body.scopes) : undefined,
      status: body.status === "active" || body.status === "revoked" ? body.status : undefined,
    });
    if (!item) return c.json({ error: "未找到 API Key" }, 404);
    return c.json({
      ok: true,
      key: {
        id: item.id,
        name: item.name,
        scopes: item.scopes,
        status: item.status,
        keyPreview: `${item.key.slice(0, 6)}…${item.key.slice(-4)}`,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
      },
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "更新失败" }, 400);
  }
});

app.delete("/api/me/api-keys/:id", requireUser, async (c) => {
  const user = c.get("user");
  const keyId = c.req.param("id") || "";
  const ok = await db.deleteUserApiKey(user.id, keyId);
  if (!ok) return c.json({ error: "未找到 API Key" }, 404);
  await db.addAudit({
    actorId: user.id,
    actorUsername: user.username,
    action: "delete",
    resource: "api_key",
    resourceId: keyId,
    ip: clientIp(c),
  });
  return c.json({ ok: true });
});

app.delete("/api/settings/api-keys/:id", requireUser, async (c) => {
  const user = c.get("user");
  const keyId = c.req.param("id") || "";
  const ok = await db.deleteUserApiKey(user.id, keyId);
  if (!ok) return c.json({ error: "未找到 API Key" }, 404);
  return c.json({ ok: true });
});

app.get("/api/me/api-history", requireUser, (c) => {
  const user = c.get("user");
  const { q, page, pageSize } = pageParams(c);
  return c.json(db.listApiCallLogs(user.id, { q, page, pageSize }));
});

app.get("/api/me/api-docs", requireUser, (c) => {
  const base = config.PUBLIC_URL.replace(/\/$/, "");
  return c.json({
    openapiUrl: `${base}/ai/v1/openapi.json`,
    skillUrl: `${base}/ai/v1/skill`,
    docsUrl: `${base}/ai/v1/docs`,
    baseUrl: base,
    auth: "Authorization: Bearer dk_…",
    scopes: {
      read: "GET /ai/v1/me, domains, mails, inbound, history",
      write: "POST/PATCH/DELETE mutating routes under /ai/v1",
    },
    endpoints: {
      me: `${base}/ai/v1/me`,
      domains: `${base}/ai/v1/domains`,
      mails: `${base}/ai/v1/mails`,
      inbound: `${base}/ai/v1/inbound`,
      history: `${base}/ai/v1/history`,
      skill: `${base}/ai/v1/skill`,
      openapi: `${base}/ai/v1/openapi.json`,
    },
    duckmail: {
      domains: `${base}/domains`,
      accounts: `${base}/accounts`,
      token: `${base}/token`,
      messages: `${base}/messages`,
    },
  });
});

// ---------- mails (tenant) ----------
app.get("/api/mails", requireUser, async (c) => {
  const user = c.get("user");
  const { q, page, pageSize } = pageParams(c);
  const result = await db.listMails(user.tenant, { q, page, pageSize });
  return c.json(result);
});

app.get("/api/mails/:id", requireUser, async (c) => {
  const user = c.get("user");
  const mailId = c.req.param("id") || "";
  const item = await db.getMail(user.tenant, mailId);
  if (!item) return c.json({ error: "未找到邮件" }, 404);
  return c.json({ mail: item });
});

// ---------- worker snippet ----------
app.get("/api/worker-snippet", requireUser, (c) => {
  const user = c.get("user");
  const webhookUrl = `${config.PUBLIC_URL.replace(/\/$/, "")}/v1/inbound`;
  const snippet = buildWorkerSnippet({
    webhookUrl,
    webhookSecret: config.WEBHOOK_SECRET,
    inboundDomain: config.INBOUND_DOMAIN,
    tenant: user.tenant,
  });
  return c.json({
    tenant: user.tenant,
    inboundAddress: `${user.tenant}@${config.INBOUND_DOMAIN}`,
    webhookUrl,
    ...snippet,
  });
});

// ---------- admin: users ----------
app.get("/api/admin/users", requireAdmin, (c) => {
  const { q, page, pageSize } = pageParams(c);
  const role = c.req.query("role") || undefined;
  const status = c.req.query("status") || undefined;
  const result = db.listUsers({ q, role, status, page, pageSize });
  return c.json({
    ...result,
    items: result.items.map(publicUser),
  });
});

app.post("/api/admin/users", requireAdmin, async (c) => {
  const actor = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  try {
    const user = await db.createUser({
      username: String(body.username || ""),
      password: String(body.password || ""),
      displayName: String(body.displayName || ""),
      role: (body.role === "admin" ? "admin" : "user") as UserRole,
    });
    await db.addAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "create",
      resource: "user",
      resourceId: user.id,
      detail: `created ${user.username} role=${user.role}`,
      ip: clientIp(c),
    });
    return c.json({ ok: true, user: publicUser(user) }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "创建失败" }, 400);
  }
});

app.patch("/api/admin/users/:id", requireAdmin, async (c) => {
  const actor = c.get("user");
  const userId = c.req.param("id") || "";
  const body = await c.req.json().catch(() => ({}));
  try {
    const patch: {
      displayName?: string;
      role?: UserRole;
      status?: "active" | "disabled";
      password?: string;
    } = {};
    if (body.displayName !== undefined) patch.displayName = String(body.displayName);
    if (body.role === "admin" || body.role === "user") patch.role = body.role;
    if (body.status === "active" || body.status === "disabled") patch.status = body.status;
    if (body.password) patch.password = String(body.password);
    const user = await db.updateUser(userId, patch);
    await db.addAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "update",
      resource: "user",
      resourceId: user.id,
      detail: JSON.stringify({
        displayName: patch.displayName,
        role: patch.role,
        status: patch.status,
        passwordChanged: Boolean(patch.password),
      }),
      ip: clientIp(c),
    });
    return c.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "更新失败" }, 400);
  }
});

app.delete("/api/admin/users/:id", requireAdmin, async (c) => {
  const actor = c.get("user");
  const userId = c.req.param("id") || "";
  if (userId === actor.id) return c.json({ error: "不能删除自己" }, 400);
  try {
    const target = db.findUserById(userId);
    const ok = await db.deleteUser(userId);
    if (!ok) return c.json({ error: "用户不存在" }, 404);
    await db.addAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "delete",
      resource: "user",
      resourceId: userId,
      detail: target?.username,
      ip: clientIp(c),
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "删除失败" }, 400);
  }
});

// ---------- admin: domains ----------
app.get("/api/admin/domains", requireAdmin, (c) => {
  const { q, page, pageSize } = pageParams(c);
  return c.json(db.listAllDomains({ q, page, pageSize }));
});

app.delete("/api/admin/domains/:id", requireAdmin, async (c) => {
  const actor = c.get("user");
  const domainId = c.req.param("id") || "";
  const ok = await db.adminRemoveDomain(domainId);
  if (!ok) return c.json({ error: "未找到域名" }, 404);
  await db.addAudit({
    actorId: actor.id,
    actorUsername: actor.username,
    action: "delete",
    resource: "domain",
    resourceId: domainId,
    detail: "admin delete",
    ip: clientIp(c),
  });
  return c.json({ ok: true });
});

// ---------- admin: mails ----------
app.get("/api/admin/mails", requireAdmin, async (c) => {
  const { q, page, pageSize } = pageParams(c);
  const tenant = c.req.query("tenant") || undefined;
  return c.json(await db.listAllMails({ q, tenant, page, pageSize }));
});

// ---------- admin: audit logs ----------
app.get("/api/admin/audit-logs", requireAdmin, (c) => {
  const { q, page, pageSize } = pageParams(c);
  const action = c.req.query("action") || undefined;
  const resource = c.req.query("resource") || undefined;
  return c.json(db.listAuditLogs({ q, action, resource, page, pageSize }));
});

// ---------- admin: feishu settings ----------
app.get("/api/admin/settings/feishu", requireAdmin, (c) => {
  return c.json({ settings: db.getFeishuSettingsPublic() });
});

app.put("/api/admin/settings/feishu", requireAdmin, async (c) => {
  const actor = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const settings = await db.updateFeishuSettings(
    {
      enabled: Boolean(body.enabled),
      appId: body.appId !== undefined ? String(body.appId) : undefined,
      appSecret: body.appSecret !== undefined ? String(body.appSecret) : undefined,
      encryptKey: body.encryptKey !== undefined ? String(body.encryptKey) : undefined,
      verificationToken:
        body.verificationToken !== undefined ? String(body.verificationToken) : undefined,
      notifyChatId: body.notifyChatId !== undefined ? String(body.notifyChatId) : undefined,
      notifyOnInbound: body.notifyOnInbound !== undefined ? Boolean(body.notifyOnInbound) : undefined,
      oauthRedirectUri:
        body.oauthRedirectUri !== undefined ? String(body.oauthRedirectUri) : undefined,
    },
    actor.username,
  );
  await db.addAudit({
    actorId: actor.id,
    actorUsername: actor.username,
    action: "update",
    resource: "settings.feishu",
    detail: `enabled=${settings.enabled} appId=${settings.appId}`,
    ip: clientIp(c),
  });
  return c.json({ ok: true, settings: db.getFeishuSettingsPublic() });
});

// ---------- admin: overview ----------
app.get("/api/admin/overview", requireAdmin, async (c) => {
  const global = db.globalStats();
  const mails = await db.listAllMails({ pageSize: 5 });
  const audits = db.listAuditLogs({ pageSize: 8 });
  const feishu = db.getFeishuSettingsPublic();
  return c.json({
    global,
    recentMails: mails.items,
    recentAudits: audits.items,
    feishu: {
      enabled: feishu.enabled,
      appId: feishu.appId,
      notifyOnInbound: feishu.notifyOnInbound,
    },
  });
});

// ---------- inbound webhook (from CF Worker) ----------
function decodeMaybeB64(value: string): string {
  if (!value.startsWith("b64:")) return value;
  try {
    const b64 = value.slice(4).replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    return Buffer.from(b64 + pad, "base64").toString("utf8");
  } catch {
    return value;
  }
}

app.post(
  "/v1/inbound",
  bodyLimit({
    maxSize: config.MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "payload too large" }, 413),
  }),
  async (c) => {
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.byteLength === 0) return c.json({ error: "empty body" }, 400);

    const check = verifySignature({
      secret: config.WEBHOOK_SECRET,
      timestamp: c.req.header("x-timestamp") || "",
      signatureHeader: c.req.header("x-signature") || "",
      body: raw,
      skewSeconds: config.SIGNATURE_SKEW_SECONDS,
    });
    if (!check.ok) {
      console.warn("signature failed", check.reason);
      return c.json({ error: "unauthorized", reason: check.reason }, 401);
    }

    const tenant = (c.req.header("x-tenant") || "").toLowerCase().trim();
    const channel = (c.req.header("x-channel") || "default").toLowerCase().trim();
    if (!tenant) return c.json({ error: "missing x-tenant" }, 400);

    // Accept SaaS dashboard users OR DuckMail-compatible mailbox accounts
    if (!db.isKnownTenant(tenant)) {
      return c.json({ error: "unknown tenant", tenant }, 403);
    }

    let parsed;
    try {
      parsed = await parseRawEmail(raw);
    } catch (err) {
      console.error("parse failed", err);
      return c.json({ error: "invalid mime" }, 400);
    }

    const from = c.req.header("x-email-from") || parsed.from;
    const to = c.req.header("x-email-to") || parsed.to[0] || "";
    const subject = decodeMaybeB64(c.req.header("x-email-subject") || "") || parsed.subject;
    const messageId = c.req.header("x-message-id") || parsed.messageId;

    const { meta, duplicate } = await db.saveMail({
      tenant,
      channel,
      from,
      to,
      subject,
      messageId,
      raw,
      parsed: {
        text: parsed.text,
        html: parsed.html,
        attachments: parsed.attachments,
        date: parsed.date,
        headers: parsed.headers,
      },
    });

    if (!duplicate) {
      await db.addAudit({
        action: "inbound",
        resource: "mail",
        resourceId: meta.id,
        detail: `tenant=${tenant} from=${from} subject=${subject.slice(0, 80)}`,
        ip: clientIp(c),
      });
    }

    if (duplicate) {
      return c.json({ ok: true, duplicate: true, id: meta.id, tenant, channel });
    }

    console.log(
      JSON.stringify({
        event: "mail.stored",
        id: meta.id,
        tenant,
        channel,
        from,
        subject,
        size: meta.size,
      }),
    );

    return c.json(
      { ok: true, duplicate: false, id: meta.id, tenant, channel, receivedAt: meta.receivedAt },
      201,
    );
  },
);

// static SPA (legacy public UI kept for API host)
app.use("/*", serveStatic({ root: publicDir }));
app.get("*", serveStatic({ path: path.join(publicDir, "index.html") }));

console.log(
  JSON.stringify({
    event: "server.start",
    host: config.HOST,
    port: config.PORT,
    publicUrl: config.PUBLIC_URL,
    inboundDomain: config.INBOUND_DOMAIN,
    dataDir: config.DATA_DIR,
  }),
);

serve({
  fetch: app.fetch,
  hostname: config.HOST,
  port: config.PORT,
});
