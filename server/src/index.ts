import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { deriveDomainWebhookSecret, verifySignature } from "./crypto.js";
import { AppDb, verifyPassword, type ApiKeyScope, type User, type UserRole } from "./db.js";
import { createAiNativeApp } from "./ai-native.js";
import { createDuckMailApp } from "./duckmail.js";
import {
  FeishuTestError,
  listFeishuChats,
  sendFeishuNotification,
  testFeishuConnection,
} from "./feishu.js";
import { parseRawEmail } from "./parse.js";
import { buildWorkerSnippet } from "./worker-snippet.js";
import {
  ingestApiMail,
  startDoneMailScheduler,
  syncDoneMailChannel,
  testDoneMailConnection,
  type InboundMailNotifier,
} from "./inbound-adapters.js";
import { sendSmtpMail, verifySmtpSettings } from "./smtp.js";

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

const notifyInboundMail: InboundMailNotifier = async (mail) => {
  const feishu = db.getFeishuSettings();
  if (
    !feishu.enabled ||
    !feishu.notifyOnInbound ||
    !feishu.appId ||
    !feishu.appSecret ||
    !feishu.notifyChatId
  ) {
    return;
  }
  const text = [
    "TouchMail 收到新邮件",
    `主题：${mail.subject || "（无主题）"}`,
    `发件人：${mail.from || "未知"}`,
    `收件人：${mail.to || "未知"}`,
    `租户：${mail.tenant}`,
    `渠道：${mail.channel}`,
    `查看：${config.PUBLIC_URL.replace(/\/$/, "")}/mails`,
  ].join("\n");
  try {
    await sendFeishuNotification(
      {
        appId: feishu.appId,
        appSecret: feishu.appSecret,
        notifyChatId: feishu.notifyChatId,
      },
      text,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "feishu.inbound_notification_failed",
        mailId: mail.id,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
  }
};

startDoneMailScheduler(db, config.MAX_BODY_BYTES, notifyInboundMail);

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
    domainCount: domains.length,
    mailCount: mailPage.total,
    lastMailAt: mailPage.items[0]?.receivedAt || null,
    recentMails: mailPage.items,
    domains,
    global,
  });
});

// ---------- receive channels + domains (tenant) ----------
app.get("/api/receive-channels", requireUser, (c) => {
  return c.json({
    items: db.listReceiveChannelsPublic(false).map((channel) => ({
      ...channel,
      adminKey: "",
      pushToken: "",
      adminKeySet: false,
      pushTokenSet: false,
    })),
  });
});

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
      String(body.receiveChannelId || ""),
      String(body.workerName || ""),
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
    receiveChannelId:
      body.receiveChannelId !== undefined ? String(body.receiveChannelId) : undefined,
    workerName: body.workerName !== undefined ? String(body.workerName) : undefined,
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

// ---------- SMTP status, outbound mail, and domain test ----------
app.get("/api/smtp/status", requireUser, (c) => {
  const smtp = db.getSmtpSettingsPublic();
  return c.json({
    enabled: smtp.enabled,
    fromAddress: smtp.fromAddress,
    fromName: smtp.fromName,
  });
});

app.post("/api/outbound", requireAdmin, async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const to = String(body.to || "").trim();
  const subject = String(body.subject || "").trim().slice(0, 300);
  const text = String(body.text || "");
  const html = body.html !== undefined ? String(body.html) : undefined;
  if (!to.includes("@")) return c.json({ error: "收件邮箱格式不正确" }, 400);
  if (!subject) return c.json({ error: "请填写邮件主题" }, 400);
  if (!text && !html) return c.json({ error: "请填写邮件正文" }, 400);
  try {
    const result = await sendSmtpMail(db.getSmtpSettings(), { to, subject, text, html });
    await db.addAudit({
      actorId: user.id,
      actorUsername: user.username,
      action: "send",
      resource: "outbound_mail",
      resourceId: result.messageId,
      detail: `to=${to} subject=${subject.slice(0, 80)}`,
      ip: clientIp(c),
    });
    return c.json({ ok: true, ...result }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "邮件发送失败" }, 502);
  }
});

app.post("/api/domains/:id/test", requireAdmin, async (c) => {
  const user = c.get("user");
  const domain = db.listDomains(user.id).find((item) => item.id === c.req.param("id"));
  if (!domain) return c.json({ error: "未找到域名" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const recipient = String(body.recipient || `test@${domain.domain}`).trim().toLowerCase();
  if (db.findDomainByAddress(recipient)?.id !== domain.id) {
    return c.json({ error: `测试收件地址必须属于 ${domain.domain}` }, 400);
  }
  const token = randomBytes(6).toString("hex");
  const subject = `Touch Mail 域名接入测试 [${token}]`;
  try {
    const result = await sendSmtpMail(db.getSmtpSettings(), {
      to: recipient,
      subject,
      text: `这是一封 Touch Mail 自动接入测试邮件。\n域名：${domain.domain}\n测试标识：${token}\n如果后台自动显示接收成功，说明收件渠道已经接通。`,
      headers: { "X-Touch-Mail-Domain-Test": token },
    });
    await db.addAudit({
      actorId: user.id,
      actorUsername: user.username,
      action: "test",
      resource: "domain_inbound",
      resourceId: domain.id,
      detail: `recipient=${recipient} token=${token}`,
      ip: clientIp(c),
    });
    return c.json({ ok: true, token, recipient, messageId: result.messageId }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "测试邮件发送失败" }, 502);
  }
});

app.get("/api/domains/:id/test/:token", requireUser, async (c) => {
  const user = c.get("user");
  const domain = db.listDomains(user.id).find((item) => item.id === c.req.param("id"));
  if (!domain) return c.json({ error: "未找到域名" }, 404);
  const token = c.req.param("token") || "";
  if (!/^[a-f0-9]{12}$/.test(token)) return c.json({ error: "测试标识无效" }, 400);
  const result = await db.listMails(user.tenant, { q: token, pageSize: 1 });
  return c.json({ received: result.total > 0, mail: result.items[0] || null });
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
      domainSetupGuide: `${base}/ai/v1/domains/{id}/setup-guide`,
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
app.get("/api/domains/:id/worker-snippet", requireUser, (c) => {
  const user = c.get("user");
  const domain = db.listDomains(user.id).find((item) => item.id === c.req.param("id"));
  if (!domain) return c.json({ error: "未找到域名" }, 404);
  const channel = db.getReceiveChannel(domain.receiveChannelId);
  if (!channel || channel.type !== "worker") {
    return c.json({ error: "该域名未选择 Cloudflare Worker 渠道" }, 400);
  }
  if (!domain.workerName) return c.json({ error: "请先配置 Worker Name" }, 400);
  const webhookUrl = `${config.PUBLIC_URL.replace(/\/$/, "")}/v1/inbound`;
  const webhookSecret = deriveDomainWebhookSecret(config.WEBHOOK_SECRET, domain.id);
  const snippet = buildWorkerSnippet({
    webhookUrl,
    webhookSecret,
    domain: domain.domain,
    workerName: domain.workerName,
  });
  return c.json({
    domainId: domain.id,
    domain: domain.domain,
    workerName: domain.workerName,
    webhookUrl,
    webhookSecret,
    ...snippet,
  });
});

app.get("/api/domains/:id/setup-guide", requireUser, (c) => {
  const user = c.get("user");
  const domain = db.listDomains(user.id).find((item) => item.id === c.req.param("id"));
  if (!domain) return c.json({ error: "未找到域名" }, 404);
  const channel = db.getReceiveChannel(domain.receiveChannelId);
  if (!channel || !channel.enabled) return c.json({ error: "该域名未绑定可用收件渠道" }, 400);

  const scope = c.req.query("scope") === "specific" ? "specific" : "all";
  const address = (c.req.query("address") || "").trim().toLowerCase();
  const addressParts = address.split("@");
  const validSpecific =
    scope === "specific" &&
    addressParts.length === 2 &&
    Boolean(addressParts[0]) &&
    addressParts[1] === domain.domain;
  if (scope === "specific" && !validSpecific) {
    return c.json({ error: `特定邮箱必须是 ${domain.domain} 下的完整地址` }, 400);
  }
  const testRecipient = scope === "specific" ? address : `test@${domain.domain}`;

  if (channel.type === "worker") {
    if (!domain.workerName) return c.json({ error: "请先配置 Worker Name" }, 400);
    const webhookUrl = `${config.PUBLIC_URL.replace(/\/$/, "")}/v1/inbound`;
    const webhookSecret = deriveDomainWebhookSecret(config.WEBHOOK_SECRET, domain.id);
    const snippet = buildWorkerSnippet({
      webhookUrl,
      webhookSecret,
      domain: domain.domain,
      workerName: domain.workerName,
    });
    return c.json({
      domainId: domain.id,
      domain: domain.domain,
      channel: { id: channel.id, name: channel.name, type: channel.type },
      scope,
      testRecipient,
      steps: [
        {
          id: "worker-create",
          title: "创建并部署 Worker",
          fields: [{ name: "Worker Name", value: domain.workerName, copyable: true }],
          instructions: [
            "Cloudflare → Workers & Pages → Create Worker",
            "Worker Name 使用本步骤给出的精确值",
            "用生成代码替换默认代码并 Deploy",
          ],
          code: { javascript: snippet.js, wranglerToml: snippet.wranglerToml },
        },
        {
          id: "worker-variables",
          title: "配置 Worker 变量",
          instructions: ["Worker → Settings → Variables and Secrets", "保存变量后重新部署"],
          fields: [
            { name: "WEBHOOK_URL", value: webhookUrl, kind: "text", copyable: true },
            { name: "WEBHOOK_SECRET", value: webhookSecret, kind: "secret", copyable: true },
            { name: "EMAIL_DOMAIN", value: domain.domain, kind: "text", copyable: true },
          ],
        },
        {
          id: "email-routing",
          title: scope === "all" ? "配置 Catch-all 路由" : "配置特定邮箱路由",
          warning:
            scope === "all"
              ? "不要在 Custom address 中填写 *、*@域名或任何值；请编辑 Catch-all address。"
              : undefined,
          fields:
            scope === "all"
              ? [
                  { name: "Rule", value: "Catch-all address" },
                  { name: "Custom address", value: "不填写" },
                  { name: "Action", value: "Send to a Worker" },
                  { name: "Worker", value: domain.workerName, copyable: true },
                ]
              : [
                  { name: "Custom address", value: addressParts[0], copyable: true },
                  { name: "Action", value: "Send to a Worker" },
                  { name: "Worker", value: domain.workerName, copyable: true },
                ],
          instructions:
            scope === "all"
              ? [
                  "退出 Add custom address",
                  "在 Routing rules 找到 Catch-all address 并点击 Edit",
                  "保存并确认规则状态为 Active",
                ]
              : ["点击 Add custom address", "Custom address 只填写 @ 前面的部分", "保存并确认规则状态为 Active"],
        },
      ],
    });
  }

  if (channel.type === "email_forward") {
    const target = db.renderForwardingAddress(domain, user.tenant) || "";
    return c.json({
      domainId: domain.id,
      domain: domain.domain,
      channel: {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        collectorType: channel.collectorType,
      },
      scope,
      testRecipient,
      steps: [
        {
          id: "forward-scope",
          title: scope === "all" ? "配置整个域名转发" : "配置特定邮箱转发",
          warning:
            scope === "all"
              ? "邮件服务商必须支持 Catch-all、全域转发或邮件流规则；不要把 * 当成普通邮箱地址。"
              : undefined,
          fields: [
            { name: "Source", value: scope === "all" ? `*@${domain.domain} / Catch-all` : address },
            { name: "Action", value: "Forward / 转发" },
            { name: "Target", value: target, copyable: true },
          ],
        },
        {
          id: "collector",
          title: channel.collectorType === "donemail" ? "由 DoneMail API 收集" : "由 Webhook Worker 推送",
          fields: [
            { name: "Collector", value: channel.collectorType },
            { name: "Configured", value: channel.collectorType === "donemail" ? Boolean(channel.adminKey) : Boolean(channel.pushToken) },
          ],
          instructions: ["收集凭据由管理员配置，域名用户无需填写 Token。"],
        },
      ],
    });
  }

  return c.json({
    domainId: domain.id,
    domain: domain.domain,
    channel: { id: channel.id, name: channel.name, type: channel.type },
    scope,
    testRecipient,
    steps: [{ id: "collector", title: "按管理员配置的收集方式接入" }],
  });
});

// ---------- admin: receive channels ----------
app.get("/api/admin/receive-channels", requireAdmin, (c) => {
  return c.json({ items: db.listReceiveChannelsPublic(true) });
});

app.post("/api/admin/receive-channels", requireAdmin, async (c) => {
  const actor = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const type = ["worker", "email_forward", "donemail", "api_push"].includes(body.type)
    ? body.type
    : "";
  try {
    const channel = await db.createReceiveChannel(
      {
        name: String(body.name || ""),
        description: String(body.description || ""),
        type,
        collectorType:
          body.collectorType === "donemail" || body.collectorType === "webhook"
            ? body.collectorType
            : undefined,
        enabled: body.enabled !== false,
        forwardingAddressTemplate: String(body.forwardingAddressTemplate || ""),
        baseUrl: String(body.baseUrl || ""),
        adminKey: String(body.adminKey || ""),
        pushToken: String(body.pushToken || ""),
        pollIntervalSeconds: Number(body.pollIntervalSeconds || 60),
      },
      actor.username,
    );
    await db.addAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "create",
      resource: "receive_channel",
      resourceId: channel.id,
      detail: `${channel.name} type=${channel.type}`,
      ip: clientIp(c),
    });
    return c.json(
      {
        ok: true,
        channel: db.getReceiveChannelPublic(channel.id),
        pushToken:
          channel.type === "api_push" ||
          (channel.type === "email_forward" && channel.collectorType === "webhook")
            ? channel.pushToken
            : undefined,
      },
      201,
    );
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "创建失败" }, 400);
  }
});

app.get("/api/admin/receive-channels/:id/impact", requireAdmin, (c) => {
  const channelId = c.req.param("id") || "";
  if (!db.getReceiveChannel(channelId)) return c.json({ error: "未找到收件渠道" }, 404);
  return c.json({ impact: db.getReceiveChannelImpact(channelId) });
});

app.patch("/api/admin/receive-channels/:id", requireAdmin, async (c) => {
  const actor = c.get("user");
  const channelId = c.req.param("id") || "";
  const body = await c.req.json().catch(() => ({}));
  const existing = db.getReceiveChannel(channelId);
  if (!existing) return c.json({ error: "未找到收件渠道" }, 404);
  const impact = db.getReceiveChannelImpact(channelId);
  const hadPushToken = Boolean(existing.pushToken);
  if (impact.domainCount > 0 && body.confirmImpact !== true) {
    return c.json(
      {
        error: `该变更将影响 ${impact.userCount} 个用户、${impact.domainCount} 个域名，需要二次确认`,
        code: "RECEIVE_CHANNEL_IMPACT_CONFIRMATION_REQUIRED",
        impact,
      },
      409,
    );
  }
  try {
    const channel = await db.updateReceiveChannel(
      channelId,
      {
        name: body.name !== undefined ? String(body.name) : undefined,
        description: body.description !== undefined ? String(body.description) : undefined,
        type: ["worker", "email_forward", "donemail", "api_push"].includes(body.type)
          ? body.type
          : undefined,
        collectorType:
          body.collectorType === "donemail" || body.collectorType === "webhook"
            ? body.collectorType
            : undefined,
        enabled: body.enabled !== undefined ? Boolean(body.enabled) : undefined,
        forwardingAddressTemplate:
          body.forwardingAddressTemplate !== undefined
            ? String(body.forwardingAddressTemplate)
            : undefined,
        baseUrl: body.baseUrl !== undefined ? String(body.baseUrl) : undefined,
        adminKey: body.adminKey !== undefined ? String(body.adminKey) : undefined,
        pushToken: body.pushToken !== undefined ? String(body.pushToken) : undefined,
        pollIntervalSeconds:
          body.pollIntervalSeconds !== undefined ? Number(body.pollIntervalSeconds) : undefined,
      },
      actor.username,
    );
    if (!channel) return c.json({ error: "未找到收件渠道" }, 404);
    await db.addAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "update",
      resource: "receive_channel",
      resourceId: channel.id,
      detail: `${channel.name} enabled=${channel.enabled}`,
      ip: clientIp(c),
    });
    return c.json({
      ok: true,
      channel: db.getReceiveChannelPublic(channel.id),
      pushToken: !hadPushToken && channel.pushToken ? channel.pushToken : undefined,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "更新失败" }, 400);
  }
});

app.delete("/api/admin/receive-channels/:id", requireAdmin, async (c) => {
  const actor = c.get("user");
  const channelId = c.req.param("id") || "";
  const impact = db.getReceiveChannelImpact(channelId);
  if (impact.domainCount > 0) {
    return c.json(
      {
        error: "该收件渠道仍被域名使用，不能删除；请先迁移绑定域名",
        code: "RECEIVE_CHANNEL_IN_USE",
        impact,
      },
      409,
    );
  }
  try {
    const deleted = await db.deleteReceiveChannel(channelId);
    if (!deleted) return c.json({ error: "未找到收件渠道" }, 404);
    await db.addAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "delete",
      resource: "receive_channel",
      resourceId: channelId,
      ip: clientIp(c),
    });
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "删除失败" }, 400);
  }
});

app.get("/api/admin/receive-channels/:id/setup-guide", requireAdmin, (c) => {
  const channel = db.getReceiveChannel(c.req.param("id"));
  if (!channel) return c.json({ error: "未找到收件渠道" }, 404);
  const impact = db.getReceiveChannelImpact(channel.id);
  const publicUrl = config.PUBLIC_URL.replace(/\/$/, "");

  if (channel.type === "email_forward") {
    const collector =
      channel.collectorType === "donemail"
        ? {
            type: "donemail",
            title: "DoneMail API 定时拉取",
            secretConfigured: Boolean(channel.adminKey),
            fields: [
              { name: "Forward target template", value: channel.forwardingAddressTemplate },
              { name: "DoneMail Base URL", value: channel.baseUrl },
              { name: "X-Admin-Key", value: channel.adminKey ? "已配置" : "未配置" },
              { name: "Poll interval seconds", value: channel.pollIntervalSeconds },
            ],
            instructions: [
              "先确保转发目标域名由 DoneMail 接收",
              "业务邮箱转发到按用户渲染的目标地址",
              "Touch Mail 使用 X-Admin-Key 定时读取 /api/mails 和附件",
              "此模式不使用 RECEIVE_CHANNEL_ID 或 WEBHOOK_SECRET",
            ],
          }
        : {
            type: "webhook",
            title: "接收 Worker Webhook 推送",
            secretConfigured: Boolean(channel.pushToken),
            fields: [
              { name: "WEBHOOK_URL", value: `${publicUrl}/v1/inbound` },
              { name: "RECEIVE_CHANNEL_ID", value: channel.id },
              { name: "WEBHOOK_SECRET", value: channel.pushToken ? "已配置（创建或轮换时仅返回一次）" : "未配置" },
              { name: "EMAIL_DOMAIN", value: "转发目标模板中的收件域名" },
            ],
            instructions: [
              "在转发目标域名的 Cloudflare Email Routing 中创建共享接收 Worker",
              "Worker 使用 RECEIVE_CHANNEL_ID 标识渠道，并用 WEBHOOK_SECRET 对原始邮件签名",
              "用户和邮件服务商只配置转发目标，不接触渠道 ID 或签名 Token",
            ],
          };
    return c.json({
      channel: db.getReceiveChannelPublic(channel.id),
      impact,
      forwarding: {
        template: channel.forwardingAddressTemplate,
        requiredVariables: ["tenant"],
        optionalVariables: ["domain"],
      },
      collector,
    });
  }

  if (channel.type === "worker") {
    return c.json({
      channel: db.getReceiveChannelPublic(channel.id),
      impact,
      instructions: [
        "每个域名使用独立 Worker、Worker Name 和派生 Secret",
        "域名用户通过 GET /api/domains/:id/setup-guide 获取完整步骤",
      ],
    });
  }

  return c.json({
    channel: db.getReceiveChannelPublic(channel.id),
    impact,
    endpoint:
      channel.type === "api_push" ? `${publicUrl}/v1/inbound/json/${channel.id}` : undefined,
  });
});

app.post("/api/admin/receive-channels/:id/token/rotate", requireAdmin, async (c) => {
  const actor = c.get("user");
  const channelId = c.req.param("id") || "";
  const channel = db.getReceiveChannel(channelId);
  if (!channel) return c.json({ error: "未找到收件渠道" }, 404);
  if (
    channel.type !== "api_push" &&
    !(channel.type === "email_forward" && channel.collectorType === "webhook")
  ) {
    return c.json({ error: "该渠道不使用 Webhook/API Token" }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const impact = db.getReceiveChannelImpact(channelId);
  if (impact.domainCount > 0 && body.confirmImpact !== true) {
    return c.json(
      {
        error: `轮换 Token 将影响 ${impact.userCount} 个用户、${impact.domainCount} 个域名，需要二次确认`,
        code: "RECEIVE_CHANNEL_IMPACT_CONFIRMATION_REQUIRED",
        impact,
      },
      409,
    );
  }
  const pushToken = `tm_in_${randomBytes(24).toString("base64url")}`;
  await db.updateReceiveChannel(channelId, { pushToken }, actor.username);
  await db.addAudit({
    actorId: actor.id,
    actorUsername: actor.username,
    action: "rotate_token",
    resource: "receive_channel",
    resourceId: channelId,
    detail: `affectedUsers=${impact.userCount} affectedDomains=${impact.domainCount}`,
    ip: clientIp(c),
  });
  return c.json({ ok: true, channelId, pushToken, impact });
});

app.post("/api/admin/receive-channels/:id/test", requireAdmin, async (c) => {
  const channel = db.getReceiveChannel(c.req.param("id"));
  if (!channel) return c.json({ error: "未找到收件渠道" }, 404);
  try {
    const result =
      channel.type === "donemail" ||
      (channel.type === "email_forward" && channel.collectorType === "donemail")
        ? await testDoneMailConnection(channel)
        : {
            ready: true,
            endpoint:
              channel.type === "api_push"
                ? `${config.PUBLIC_URL.replace(/\/$/, "")}/v1/inbound/json/${channel.id}`
                : undefined,
          };
    return c.json({ ok: true, result });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "渠道测试失败" }, 502);
  }
});

app.post("/api/admin/receive-channels/:id/sync", requireAdmin, async (c) => {
  const channel = db.getReceiveChannel(c.req.param("id"));
  if (!channel) return c.json({ error: "未找到收件渠道" }, 404);
  try {
    const result = await syncDoneMailChannel(
      db,
      channel,
      config.MAX_BODY_BYTES,
      undefined,
      notifyInboundMail,
    );
    return c.json({ ok: true, result });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "同步失败" }, 502);
  }
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

app.post("/api/admin/settings/feishu/test", requireAdmin, async (c) => {
  const actor = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const saved = db.getFeishuSettings();
  const submittedSecret = body.appSecret !== undefined ? String(body.appSecret).trim() : "";
  const secretSource =
    submittedSecret && !submittedSecret.includes("••")
      ? "current_input"
      : saved.appSecret
        ? "saved"
        : "missing";

  try {
    const result = await testFeishuConnection({
      appId: body.appId !== undefined ? String(body.appId) : saved.appId,
      appSecret:
        submittedSecret && !submittedSecret.includes("••") ? submittedSecret : saved.appSecret,
      notifyChatId:
        body.notifyChatId !== undefined ? String(body.notifyChatId) : saved.notifyChatId,
    });
    await db.addAudit({
      actorId: actor.id,
      actorUsername: actor.username,
      action: "test",
      resource: "settings.feishu",
      detail: result.messageSent ? "credentials valid; test message sent" : "credentials valid",
      ip: clientIp(c),
    });
    return c.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof FeishuTestError) {
      const upstreamStatus = error.details.upstreamStatus;
      const status =
        error.kind === "validation"
          ? 400
          : error.kind === "timeout"
            ? 504
            : error.kind === "network"
              ? 502
              : upstreamStatus === 429
                ? 429
                : upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 500
                  ? 400
                  : 502;
      return c.json(
        {
          error: error.message,
          details: { kind: error.kind, secretSource, ...error.details },
        },
        status,
      );
    }
    return c.json({ error: "飞书连接测试失败" }, 500);
  }
});

// ---------- admin: SMTP settings ----------
app.get("/api/admin/settings/smtp", requireAdmin, (c) => {
  return c.json({ settings: db.getSmtpSettingsPublic() });
});

app.put("/api/admin/settings/smtp", requireAdmin, async (c) => {
  const actor = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const settings = await db.updateSmtpSettings(
    {
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : undefined,
      host: body.host !== undefined ? String(body.host) : undefined,
      port: body.port !== undefined ? Number(body.port) : undefined,
      secure: body.secure !== undefined ? Boolean(body.secure) : undefined,
      username: body.username !== undefined ? String(body.username) : undefined,
      password: body.password !== undefined ? String(body.password) : undefined,
      fromAddress: body.fromAddress !== undefined ? String(body.fromAddress) : undefined,
      fromName: body.fromName !== undefined ? String(body.fromName) : undefined,
      replyTo: body.replyTo !== undefined ? String(body.replyTo) : undefined,
    },
    actor.username,
  );
  await db.addAudit({
    actorId: actor.id,
    actorUsername: actor.username,
    action: "update",
    resource: "settings.smtp",
    detail: `enabled=${settings.enabled} host=${settings.host}:${settings.port}`,
    ip: clientIp(c),
  });
  return c.json({ ok: true, settings: db.getSmtpSettingsPublic() });
});

app.post("/api/admin/settings/smtp/test", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const saved = db.getSmtpSettings();
  const candidate = {
    ...saved,
    host: body.host !== undefined ? String(body.host).trim() : saved.host,
    port: body.port !== undefined ? Number(body.port) : saved.port,
    secure: body.secure !== undefined ? Boolean(body.secure) : saved.secure,
    username: body.username !== undefined ? String(body.username).trim() : saved.username,
    password:
      body.password && !String(body.password).includes("••")
        ? String(body.password)
        : saved.password,
    fromAddress:
      body.fromAddress !== undefined ? String(body.fromAddress).trim() : saved.fromAddress,
    fromName: body.fromName !== undefined ? String(body.fromName).trim() : saved.fromName,
    replyTo: body.replyTo !== undefined ? String(body.replyTo).trim() : saved.replyTo,
  };
  try {
    await verifySmtpSettings(candidate);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "SMTP 连接失败" }, 502);
  }
});

app.post("/api/admin/settings/feishu/chats", requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const saved = db.getFeishuSettings();
  const submittedSecret = body.appSecret !== undefined ? String(body.appSecret).trim() : "";
  const secretSource =
    submittedSecret && !submittedSecret.includes("••")
      ? "current_input"
      : saved.appSecret
        ? "saved"
        : "missing";

  try {
    const result = await listFeishuChats({
      appId: body.appId !== undefined ? String(body.appId) : saved.appId,
      appSecret:
        submittedSecret && !submittedSecret.includes("••") ? submittedSecret : saved.appSecret,
    });
    return c.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof FeishuTestError) {
      const upstreamStatus = error.details.upstreamStatus;
      const status =
        error.kind === "validation"
          ? 400
          : error.kind === "timeout"
            ? 504
            : error.kind === "network"
              ? 502
              : upstreamStatus === 429
                ? 429
                : upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 500
                  ? 400
                  : 502;
      return c.json(
        {
          error: error.message,
          details: { kind: error.kind, secretSource, ...error.details },
        },
        status,
      );
    }
    return c.json({ error: "获取飞书群列表失败" }, 500);
  }
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

// ---------- API push inbound ----------
function secretMatches(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

app.post(
  "/v1/inbound/json/:channelId",
  bodyLimit({
    maxSize: config.MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "payload too large" }, 413),
  }),
  async (c) => {
    const channel = db.getReceiveChannel(c.req.param("channelId"));
    if (!channel || channel.type !== "api_push" || !channel.enabled) {
      return c.json({ error: "接收渠道不可用" }, 404);
    }
    const authorization = c.req.header("authorization") || "";
    const token = authorization.replace(/^Bearer\s+/i, "").trim() || c.req.header("x-inbound-key") || "";
    if (!token || !secretMatches(token, channel.pushToken)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "invalid json" }, 400);
    try {
      const result = await ingestApiMail(
        db,
        channel,
        body,
        config.MAX_BODY_BYTES,
        undefined,
        notifyInboundMail,
      );
      if (!result.duplicate) {
        await db.addAudit({
          action: "inbound",
          resource: "mail",
          resourceId: result.id,
          detail: `tenant=${result.tenant} source=${channel.name}`,
          ip: clientIp(c),
        });
      }
      return c.json({ ok: true, ...result }, result.duplicate ? 200 : 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "邮件上报失败" }, 400);
    }
  },
);

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

    const envelopeTo = (c.req.header("x-email-to") || "").trim().toLowerCase();
    const boundDomain = db.findDomainByAddress(envelopeTo);
    const boundChannel = db.getReceiveChannel(boundDomain?.receiveChannelId);
    const forwardedChannel = db.getReceiveChannel(c.req.header("x-receive-channel-id") || "");
    const forwardedRecipient =
      forwardedChannel?.type === "email_forward" && forwardedChannel.collectorType === "webhook"
        ? db.resolveForwardedRecipient(forwardedChannel.id, envelopeTo)
        : null;
    if (boundChannel?.type === "worker" && !boundChannel.enabled) {
      return c.json({ error: "receive channel disabled" }, 403);
    }
    const directWorker = Boolean(boundDomain && boundChannel?.type === "worker");
    const emailForward = Boolean(
      !directWorker &&
      forwardedRecipient &&
      forwardedChannel?.type === "email_forward" &&
      forwardedChannel.collectorType === "webhook" &&
      forwardedChannel.enabled,
    );
    if (!directWorker && !emailForward) {
      return c.json({ error: "recipient is not bound to an active receive channel" }, 403);
    }
    const signatureSecret =
      directWorker && boundDomain
        ? deriveDomainWebhookSecret(config.WEBHOOK_SECRET, boundDomain.id)
        : forwardedChannel?.pushToken || "";
    const check = verifySignature({
      secret: signatureSecret,
      timestamp: c.req.header("x-timestamp") || "",
      signatureHeader: c.req.header("x-signature") || "",
      body: raw,
      skewSeconds: config.SIGNATURE_SKEW_SECONDS,
    });
    if (!check.ok) {
      console.warn("signature failed", check.reason);
      return c.json({ error: "unauthorized", reason: check.reason }, 401);
    }

    let tenant = "";
    let channel = "";
    if (directWorker && boundDomain && boundChannel) {
      const owner = db.findUserById(boundDomain.userId);
      if (!owner || owner.status !== "active") return c.json({ error: "domain owner unavailable" }, 403);
      tenant = owner.tenant;
      channel = boundChannel.name;
    } else {
      tenant = forwardedRecipient?.user.tenant || "";
      channel = forwardedChannel?.name || "email-forward";
    }
    if (!tenant) return c.json({ error: "missing x-tenant" }, 400);
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
    const envelopeSubject = decodeMaybeB64(c.req.header("x-email-subject") || "");
    const subject = envelopeSubject && !envelopeSubject.startsWith("=?") ? envelopeSubject : parsed.subject;
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
      void notifyInboundMail({
        id: meta.id,
        tenant,
        channel,
        from,
        to,
        subject,
      });
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
