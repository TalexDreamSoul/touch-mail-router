/**
 * AI-native HTTP surface for agents / skills.
 *
 * Design goals:
 * - Stable JSON envelopes for tool calling
 * - Bearer dk_ API keys with read/write scopes
 * - Machine-readable OpenAPI + skill manifest
 * - Call history for the owning user
 */
import { Hono, type Context, type Next } from "hono";
import type { AppDb, ApiKeyScope, User } from "./db.js";
import type { AppConfig } from "./config.js";

export type AiAuth = {
  user: User;
  keyId: string | null;
  keyName: string | null;
  scopes: ApiKeyScope[];
  global: boolean;
};

type AiVars = { ai: AiAuth };

function extractBearer(c: Context): string | null {
  const h = c.req.header("authorization") || c.req.header("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || null;
}

function clientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    ""
  );
}

function err(c: Context, status: number, message: string, code?: string) {
  return c.json(
    {
      ok: false,
      error: { message, code: code || `http_${status}` },
    },
    status as 400,
  );
}

function ok<T extends Record<string, unknown>>(c: Context, data: T, status = 200) {
  return c.json({ ok: true, ...data }, status as 200);
}

export function buildOpenApi(config: AppConfig) {
  const base = config.PUBLIC_URL.replace(/\/$/, "");
  return {
    openapi: "3.1.0",
    info: {
      title: "Touch Mail AI-Native API",
      version: "0.4.0",
      description:
        "Machine-friendly API for agents and skills. Authenticate with personal API keys (dk_…). Scopes: read, write.",
    },
    servers: [{ url: base }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "dk_…",
          description: "Personal API key from admin → API Keys",
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/health": {
        get: {
          security: [],
          summary: "Health check",
          responses: { "200": { description: "OK" } },
        },
      },
      "/ai/v1/me": {
        get: {
          summary: "Current key owner profile",
          tags: ["identity"],
          responses: { "200": { description: "User + scopes" } },
        },
      },
      "/ai/v1/domains": {
        get: {
          summary: "List domains for the key owner",
          tags: ["domains"],
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "integer" } },
            { name: "pageSize", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": { description: "Paged domains" } },
        },
        post: {
          summary: "Create domain (write)",
          tags: ["domains"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["domain"],
                  properties: {
                    domain: { type: "string" },
                    note: { type: "string" },
                    visibility: { type: "string", enum: ["public", "private"] },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Created" } },
        },
      },
      "/ai/v1/mails": {
        get: {
          summary: "List inbound mails for tenant",
          tags: ["mails"],
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "integer" } },
            { name: "pageSize", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": { description: "Paged mails" } },
        },
      },
      "/ai/v1/mails/{id}": {
        get: {
          summary: "Get mail detail",
          tags: ["mails"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Mail" } },
        },
      },
      "/ai/v1/inbound": {
        get: {
          summary: "Inbound address + worker setup hints",
          tags: ["inbound"],
          responses: { "200": { description: "Inbound config" } },
        },
      },
      "/ai/v1/history": {
        get: {
          summary: "Personal API call history for this key owner",
          tags: ["history"],
          parameters: [
            { name: "q", in: "query", schema: { type: "string" } },
            { name: "page", in: "query", schema: { type: "integer" } },
            { name: "pageSize", in: "query", schema: { type: "integer" } },
          ],
          responses: { "200": { description: "Paged call logs" } },
        },
      },
      "/ai/v1/skill": {
        get: {
          security: [],
          summary: "Agent skill manifest (AI-native)",
          tags: ["meta"],
          responses: { "200": { description: "Skill JSON" } },
        },
      },
      "/ai/v1/openapi.json": {
        get: {
          security: [],
          summary: "OpenAPI document",
          tags: ["meta"],
          responses: { "200": { description: "OpenAPI 3.1" } },
        },
      },
      "/domains": {
        get: {
          summary: "DuckMail-compatible domain list",
          tags: ["duckmail"],
          responses: { "200": { description: "Hydra collection" } },
        },
      },
      "/accounts": {
        post: {
          summary: "DuckMail-compatible create mailbox",
          tags: ["duckmail"],
          responses: { "201": { description: "Account" } },
        },
      },
    },
  };
}

export function buildSkillManifest(config: AppConfig) {
  const base = config.PUBLIC_URL.replace(/\/$/, "");
  return {
    name: "touch-mail-router",
    version: "0.4.0",
    description:
      "Inbound email gateway: Cloudflare Email Worker → HTTPS API. Manage domains, list mails, create temp mailboxes (DuckMail-compatible).",
    homepage: base,
    auth: {
      type: "bearer",
      header: "Authorization",
      format: "Bearer dk_<hex>",
      how_to_get:
        "Admin UI → 个人 → API Keys → create key with read and/or write scopes.",
      scopes: {
        read: "GET domains, mails, inbound, history, me",
        write: "POST/PATCH/DELETE domains and other mutating ops",
      },
    },
    base_url: base,
    endpoints: {
      openapi: `${base}/ai/v1/openapi.json`,
      skill: `${base}/ai/v1/skill`,
      me: `${base}/ai/v1/me`,
      domains: `${base}/ai/v1/domains`,
      mails: `${base}/ai/v1/mails`,
      inbound: `${base}/ai/v1/inbound`,
      history: `${base}/ai/v1/history`,
      duckmail_domains: `${base}/domains`,
      duckmail_accounts: `${base}/accounts`,
      duckmail_token: `${base}/token`,
      duckmail_messages: `${base}/messages`,
    },
    agent_instructions: [
      "Prefer /ai/v1/* for structured ok/error envelopes.",
      "Always send Authorization: Bearer dk_… from the user personal API keys page.",
      "write scope required for POST/PATCH/DELETE; read is enough for GET.",
      "Inbound mail path: customer mailbox → forward to {tenant}@{inboundDomain} → Worker → POST /v1/inbound.",
      "Domain registration in this API is ledger only; Worker + email forward still required.",
      "For temporary mailboxes use DuckMail-compatible /accounts + /token + /messages.",
      "After each call, history is recorded under /ai/v1/history for the key owner.",
    ],
    examples: [
      {
        title: "List my domains",
        request: `curl -sS ${base}/ai/v1/domains -H "Authorization: Bearer dk_…"`,
      },
      {
        title: "Create private domain",
        request: `curl -sS -X POST ${base}/ai/v1/domains -H "Authorization: Bearer dk_…" -H "Content-Type: application/json" -d '{"domain":"client.example.com","visibility":"private"}'`,
      },
      {
        title: "List recent mails",
        request: `curl -sS "${base}/ai/v1/mails?page=1&pageSize=20" -H "Authorization: Bearer dk_…"`,
      },
    ],
  };
}

export function createAiNativeApp(db: AppDb, config: AppConfig) {
  const app = new Hono<{ Variables: AiVars }>();

  async function requireAiAuth(c: Context<{ Variables: AiVars }>, next: Next) {
    const token = extractBearer(c);
    if (!token) return err(c, 401, "Missing Bearer API key", "unauthorized");
    const auth = db.resolveApiKey(token);
    if (!auth.ok) return err(c, 401, "Invalid API key", "unauthorized");

    let user: User | undefined;
    if (auth.global) {
      // global env key: bind to first admin for ownership of history
      user = db.listUsers({ page: 1, pageSize: 100 }).items.find((u) => u.role === "admin");
      if (!user) user = db.listUsers({ page: 1, pageSize: 1 }).items[0];
    } else if (auth.userId) {
      user = db.findUserById(auth.userId);
    }
    if (!user || user.status === "disabled") {
      return err(c, 403, "User disabled or missing", "forbidden");
    }

    c.set("ai", {
      user,
      keyId: auth.keyId,
      keyName: auth.keyName,
      scopes: auth.scopes,
      global: auth.global,
    });
    await next();
  }

  function requireScope(scope: ApiKeyScope) {
    return async (c: Context<{ Variables: AiVars }>, next: Next) => {
      const ai = c.get("ai");
      if (!ai.scopes.includes(scope) && !ai.global) {
        return err(c, 403, `Scope '${scope}' required`, "forbidden_scope");
      }
      await next();
    };
  }

  async function withHistory(
    c: Context<{ Variables: AiVars }>,
    handler: () => Promise<Response>,
  ): Promise<Response> {
    const started = Date.now();
    let res: Response;
    let errorMsg: string | undefined;
    try {
      res = await handler();
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      res = err(c, 500, errorMsg, "internal_error") as unknown as Response;
    }
    try {
      const ai = c.get("ai");
      if (ai?.user) {
        await db.addApiCallLog({
          userId: ai.user.id,
          apiKeyId: ai.keyId,
          apiKeyName: ai.keyName,
          method: c.req.method,
          path: c.req.path,
          status: res.status,
          durationMs: Date.now() - started,
          ip: clientIp(c),
          userAgent: c.req.header("user-agent") || undefined,
          error: errorMsg,
        });
      }
    } catch {
      /* never break response for logging */
    }
    return res;
  }

  // Public meta (no auth)
  app.get("/ai/v1/openapi.json", (c) => c.json(buildOpenApi(config)));
  app.get("/ai/v1/skill", (c) => c.json(buildSkillManifest(config)));
  app.get("/ai/v1/docs", (c) =>
    ok(c, {
      openapi: "/ai/v1/openapi.json",
      skill: "/ai/v1/skill",
      auth: "Authorization: Bearer dk_…",
      scopes: ["read", "write"],
    }),
  );

  // Authenticated AI routes
  app.use("/ai/v1/*", async (c, next) => {
    // skip public meta already registered above — those don't hit require if registered first
    const p = c.req.path;
    if (
      p === "/ai/v1/openapi.json" ||
      p === "/ai/v1/skill" ||
      p === "/ai/v1/docs"
    ) {
      return next();
    }
    return requireAiAuth(c, next);
  });

  app.get("/ai/v1/me", requireScope("read"), async (c) =>
    withHistory(c, async () => {
      const ai = c.get("ai");
      const u = ai.user;
      return ok(c, {
        user: {
          id: u.id,
          username: u.username,
          tenant: u.tenant,
          displayName: u.displayName,
          role: u.role,
          inboundAddress: `${u.tenant}@${config.INBOUND_DOMAIN}`,
        },
        scopes: ai.scopes,
        key: { id: ai.keyId, name: ai.keyName, global: ai.global },
      });
    }),
  );

  app.get("/ai/v1/inbound", requireScope("read"), async (c) =>
    withHistory(c, async () => {
      const ai = c.get("ai");
      return ok(c, {
        inboundAddress: `${ai.user.tenant}@${config.INBOUND_DOMAIN}`,
        inboundDomain: config.INBOUND_DOMAIN,
        webhookUrl: `${config.PUBLIC_URL.replace(/\/$/, "")}/v1/inbound`,
        notes: [
          "Customer mailbox must forward to inboundAddress.",
          "Cloudflare Email Routing Catch-all on inboundDomain must hit the Email Worker.",
          "Worker POSTs raw RFC822 to webhookUrl with HMAC headers.",
        ],
      });
    }),
  );

  app.get("/ai/v1/domains", requireScope("read"), async (c) =>
    withHistory(c, async () => {
      const ai = c.get("ai");
      const q = c.req.query("q") || undefined;
      const page = Number(c.req.query("page") || 1);
      const pageSize = Number(c.req.query("pageSize") || 20);
      let items = db.listDomains(ai.user.id);
      if (q) {
        const qq = q.toLowerCase();
        items = items.filter(
          (d) => d.domain.includes(qq) || (d.note || "").toLowerCase().includes(qq),
        );
      }
      const total = items.length;
      const start = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, pageSize));
      const size = Math.min(100, Math.max(1, pageSize));
      return ok(c, {
        items: items.slice(start, start + size),
        total,
        page: Math.max(1, page),
        pageSize: size,
      });
    }),
  );

  app.post("/ai/v1/domains", requireScope("write"), async (c) =>
    withHistory(c, async () => {
      const ai = c.get("ai");
      const body = await c.req.json().catch(() => ({}));
      try {
        const visibility =
          body.visibility === "public" || body.visibility === "private"
            ? body.visibility
            : "private";
        const domain = await db.addDomain(
          ai.user.id,
          String(body.domain || ""),
          String(body.note || ""),
          visibility,
        );
        await db.addAudit({
          actorId: ai.user.id,
          actorUsername: ai.user.username,
          action: "create",
          resource: "domain",
          resourceId: domain.id,
          detail: `${domain.domain} via ai-native (${domain.visibility})`,
          ip: clientIp(c),
        });
        return ok(c, { domain }, 201);
      } catch (e) {
        return err(c, 400, e instanceof Error ? e.message : "create failed");
      }
    }),
  );

  app.get("/ai/v1/mails", requireScope("read"), async (c) =>
    withHistory(c, async () => {
      const ai = c.get("ai");
      const q = c.req.query("q") || undefined;
      const page = Number(c.req.query("page") || 1);
      const pageSize = Number(c.req.query("pageSize") || 20);
      const result = await db.listMails(ai.user.tenant, { q, page, pageSize });
      return ok(c, result);
    }),
  );

  app.get("/ai/v1/mails/:id", requireScope("read"), async (c) =>
    withHistory(c, async () => {
      const ai = c.get("ai");
      const mailId = c.req.param("id") || "";
      const item = await db.getMail(ai.user.tenant, mailId);
      if (!item) return err(c, 404, "mail not found");
      return ok(c, { mail: item });
    }),
  );

  app.get("/ai/v1/history", requireScope("read"), async (c) =>
    withHistory(c, async () => {
      const ai = c.get("ai");
      const q = c.req.query("q") || undefined;
      const page = Number(c.req.query("page") || 1);
      const pageSize = Number(c.req.query("pageSize") || 20);
      const result = db.listApiCallLogs(ai.user.id, { q, page, pageSize });
      return ok(c, result);
    }),
  );

  return app;
}
