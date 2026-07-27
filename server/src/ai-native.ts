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
import { deriveDomainWebhookSecret } from "./crypto.js";
import { buildWorkerSnippet } from "./worker-snippet.js";
import {
  buildDomainAutomationPrompt,
  buildGeneralAutomationPrompt,
} from "./agent-prompt.js";
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
      version: "0.5.0",
      description:
        "Machine-friendly API for agents and skills. Authenticate with personal API keys (dk_…). Scopes: read, write.",
      "x-agent-prompt": buildGeneralAutomationPrompt(base),
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
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "tm_session",
          description: "Administrator session cookie returned by /api/auth/login",
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
      "/api/auth/channels": {
        get: {
          security: [],
          summary: "List enabled external login channels",
          tags: ["authentication"],
          responses: { "200": { description: "Public channel IDs, names, and types" } },
        },
      },
      "/api/auth/oauth/start/{id}": {
        get: {
          security: [],
          summary: "Start Feishu or OIDC authorization with signed state and PKCE",
          tags: ["authentication"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "302": { description: "Redirect to identity provider" } },
        },
      },
      "/api/auth/oauth/callback": {
        get: {
          security: [],
          summary: "OAuth/OIDC callback and Touch Mail session creation",
          tags: ["authentication"],
          responses: { "302": { description: "Redirect to dashboard or login error" } },
        },
      },
      "/api/admin/login-channels": {
        get: {
          security: [{ cookieAuth: [] }],
          summary: "List login channels and callback configuration",
          tags: ["admin-login-channels"],
          responses: { "200": { description: "Sanitized login channels" } },
        },
        post: {
          security: [{ cookieAuth: [] }],
          summary: "Create an OIDC login channel",
          tags: ["admin-login-channels"],
          responses: { "201": { description: "Created" } },
        },
      },
      "/api/admin/login-channels/feishu": {
        post: {
          security: [{ cookieAuth: [] }],
          summary: "Create a login channel from saved Feishu credentials",
          tags: ["admin-login-channels"],
          responses: { "201": { description: "Created" } },
        },
      },
      "/api/admin/login-channels/{id}": {
        patch: {
          security: [{ cookieAuth: [] }],
          summary: "Update a login channel",
          description: "Issuer, Client ID, and subject claim are locked after identities exist.",
          tags: ["admin-login-channels"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Updated" }, "400": { description: "Locked or invalid" } },
        },
        delete: {
          security: [{ cookieAuth: [] }],
          summary: "Delete an unused login channel",
          tags: ["admin-login-channels"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Deleted" }, "400": { description: "Channel has identities" } },
        },
      },
      "/api/admin/login-channels/{id}/test": {
        post: {
          security: [{ cookieAuth: [] }],
          summary: "Validate discovery and build an authorization URL",
          tags: ["admin-login-channels"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Configuration is usable" }, "502": { description: "Provider validation failed" } },
        },
      },
      "/ai/v1/automation-prompt": {
        get: {
          security: [],
          summary: "Get the Cloudflare/DNS/Worker automation prompt for AI agents",
          tags: ["meta"],
          responses: { "200": { description: "Prompt and operating policy" } },
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
                  required: ["domain", "receiveChannelId"],
                  properties: {
                    domain: { type: "string" },
                    note: { type: "string" },
                    visibility: { type: "string", enum: ["public", "private"] },
                    receiveChannelId: { type: "string" },
                    workerName: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Created" } },
        },
      },
      "/ai/v1/domains/{id}/setup-guide": {
        get: {
          summary: "Get interactive setup steps for a domain",
          description: "Response includes agentPrompt with exact DNS, Worker, Email Routing, and Rule instructions.",
          "x-agent-prompt": buildGeneralAutomationPrompt(base),
          tags: ["domains"],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "scope", in: "query", schema: { type: "string", enum: ["all", "specific"] } },
            { name: "address", in: "query", schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "Channel-aware setup steps and exact field values" },
            "400": { description: "Invalid scope/address or channel configuration" },
            "404": { description: "Domain not found" },
          },
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
    version: "0.5.0",
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
      automation_prompt: `${base}/ai/v1/automation-prompt`,
      me: `${base}/ai/v1/me`,
      domains: `${base}/ai/v1/domains`,
      domain_setup_guide: `${base}/ai/v1/domains/{id}/setup-guide`,
      mails: `${base}/ai/v1/mails`,
      inbound: `${base}/ai/v1/inbound`,
      history: `${base}/ai/v1/history`,
      duckmail_domains: `${base}/domains`,
      duckmail_accounts: `${base}/accounts`,
      duckmail_token: `${base}/token`,
      duckmail_messages: `${base}/messages`,
    },
    agent_prompt: buildGeneralAutomationPrompt(base),
    agent_instructions: [
      "Prefer /ai/v1/* for structured ok/error envelopes.",
      "Always send Authorization: Bearer dk_… from the user personal API keys page.",
      "write scope required for POST/PATCH/DELETE; read is enough for GET.",
      "Each domain must bind one administrator-enabled receive channel.",
      "Use /ai/v1/domains/{id}/setup-guide for exact interactive Worker or forwarding steps.",
      "Email forwarding is followed by either DoneMail API collection or signed Webhook collection.",
      "For Cloudflare catch-all, never type * into Custom address; edit Catch-all address instead.",
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

  function domainSetupGuide(
    user: User,
    domainId: string,
    requestedScope: string,
    requestedAddress: string,
  ): Record<string, unknown> {
    const domain = db.listDomains(user.id).find((item) => item.id === domainId);
    if (!domain) throw Object.assign(new Error("domain not found"), { status: 404 });
    const channel = db.getReceiveChannel(domain.receiveChannelId);
    if (!channel || !channel.enabled) throw new Error("domain is not bound to an enabled receive channel");
    const scope = requestedScope === "specific" ? "specific" : "all";
    const address = requestedAddress.trim().toLowerCase();
    const parts = address.split("@");
    if (
      scope === "specific" &&
      !(parts.length === 2 && Boolean(parts[0]) && parts[1] === domain.domain)
    ) {
      throw new Error(`specific address must belong to ${domain.domain}`);
    }
    const common = {
      domainId: domain.id,
      domain: domain.domain,
      channel: {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        collectorType: channel.collectorType || undefined,
      },
      scope,
      testRecipient: scope === "specific" ? address : `test@${domain.domain}`,
    };

    if (channel.type === "worker") {
      if (!domain.workerName) throw new Error("Worker Name is not configured");
      const webhookUrl = `${config.PUBLIC_URL.replace(/\/$/, "")}/v1/inbound`;
      const webhookSecret = deriveDomainWebhookSecret(config.WEBHOOK_SECRET, domain.id);
      const snippet = buildWorkerSnippet({
        webhookUrl,
        webhookSecret,
        domain: domain.domain,
        workerName: domain.workerName,
      });
      return {
        ...common,
        agentPrompt: buildDomainAutomationPrompt({
          baseUrl: config.PUBLIC_URL,
          domainId: domain.id,
          domain: domain.domain,
          channelType: channel.type,
          channelName: channel.name,
          scope,
          address: scope === "specific" ? address : undefined,
          workerName: domain.workerName,
        }),
        steps: [
          {
            id: "worker-create",
            title: "Create and deploy Worker",
            fields: [{ name: "Worker Name", value: domain.workerName, copyable: true }],
            instructions: [
              "Cloudflare > Workers & Pages > Create Worker",
              "Use the exact Worker Name",
              "Replace the default code and deploy",
            ],
            code: { javascript: snippet.js, wranglerToml: snippet.wranglerToml },
          },
          {
            id: "worker-variables",
            title: "Configure Worker variables",
            fields: [
              { name: "WEBHOOK_URL", value: webhookUrl, kind: "text", copyable: true },
              { name: "WEBHOOK_SECRET", value: webhookSecret, kind: "secret", copyable: true },
              { name: "EMAIL_DOMAIN", value: domain.domain, kind: "text", copyable: true },
            ],
            instructions: ["Worker > Settings > Variables and Secrets", "Save and redeploy"],
          },
          {
            id: "email-routing",
            title: scope === "all" ? "Configure Catch-all route" : "Configure specific address route",
            warning:
              scope === "all"
                ? "Do not enter *, *@domain, or any value in Custom address. Edit Catch-all address."
                : undefined,
            fields:
              scope === "all"
                ? [
                    { name: "Rule", value: "Catch-all address" },
                    { name: "Custom address", value: "leave empty" },
                    { name: "Action", value: "Send to a Worker" },
                    { name: "Worker", value: domain.workerName, copyable: true },
                  ]
                : [
                    { name: "Custom address", value: parts[0], copyable: true },
                    { name: "Action", value: "Send to a Worker" },
                    { name: "Worker", value: domain.workerName, copyable: true },
                  ],
          },
        ],
      };
    }

    if (channel.type === "email_forward") {
      const forwardingTarget = db.renderForwardingAddress(domain, user.tenant) || "";
      return {
        ...common,
        agentPrompt: buildDomainAutomationPrompt({
          baseUrl: config.PUBLIC_URL,
          domainId: domain.id,
          domain: domain.domain,
          channelType: channel.type,
          channelName: channel.name,
          collectorType: channel.collectorType,
          scope,
          address: scope === "specific" ? address : undefined,
          forwardingTarget,
        }),
        steps: [
          {
            id: "forward",
            title: scope === "all" ? "Configure domain-wide forwarding" : "Configure mailbox forwarding",
            warning:
              scope === "all"
                ? "Provider must support Catch-all/domain forwarding. Do not use * as a mailbox address."
                : undefined,
            fields: [
              { name: "Source", value: scope === "all" ? `*@${domain.domain} / Catch-all` : address },
              { name: "Action", value: "Forward" },
              {
                name: "Target",
                value: forwardingTarget,
                copyable: true,
              },
            ],
          },
          {
            id: "collector",
            title: channel.collectorType === "donemail" ? "DoneMail API collection" : "Signed Webhook collection",
            instructions: ["Collector credentials are managed by administrators and are never entered by domain users."],
          },
        ],
      };
    }

    return {
      ...common,
      agentPrompt: buildDomainAutomationPrompt({
        baseUrl: config.PUBLIC_URL,
        domainId: domain.id,
        domain: domain.domain,
        channelType: channel.type,
        channelName: channel.name,
        scope,
        address: scope === "specific" ? address : undefined,
      }),
      steps: [{ id: "collector", title: "Use administrator-managed collector" }],
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
  app.get("/ai/v1/automation-prompt", (c) =>
    ok(c, {
      agentPrompt: buildGeneralAutomationPrompt(config.PUBLIC_URL),
      purpose: "Cloudflare DNS, Email Routing, Worker, Rules, verification, and rollback automation",
    }),
  );
  app.get("/ai/v1/docs", (c) =>
    ok(c, {
      openapi: "/ai/v1/openapi.json",
      skill: "/ai/v1/skill",
      automationPrompt: "/ai/v1/automation-prompt",
      agentPrompt: buildGeneralAutomationPrompt(config.PUBLIC_URL),
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
      p === "/ai/v1/docs" ||
      p === "/ai/v1/automation-prompt"
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
        },
        scopes: ai.scopes,
        key: { id: ai.keyId, name: ai.keyName, global: ai.global },
      });
    }),
  );

  app.get("/ai/v1/inbound", requireScope("read"), async (c) =>
    withHistory(c, async () => {
      return ok(c, {
        agentPrompt: buildGeneralAutomationPrompt(config.PUBLIC_URL),
        receiveChannels: db.listReceiveChannelsPublic(false).map((channel) => ({
          ...channel,
          adminKey: "",
          pushToken: "",
          adminKeySet: false,
          pushTokenSet: false,
        })),
        workerWebhookUrl: `${config.PUBLIC_URL.replace(/\/$/, "")}/v1/inbound`,
        notes: [
          "Bind every domain to one enabled receive channel.",
          "Worker: configure Cloudflare Email Routing action Send to a Worker; no email forwarding is required.",
          "Email forwarding is collected by either DoneMail API polling or a signed Webhook Worker.",
          "Use /ai/v1/domains/{id}/setup-guide for exact route and forwarding fields.",
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
          String(body.receiveChannelId || ""),
          String(body.workerName || ""),
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

  app.get("/ai/v1/domains/:id/setup-guide", requireScope("read"), async (c) =>
    withHistory(c, async () => {
      const ai = c.get("ai");
      try {
        return ok(c, {
          guide: domainSetupGuide(
            ai.user,
            c.req.param("id") || "",
            c.req.query("scope") || "all",
            c.req.query("address") || "",
          ),
        });
      } catch (error) {
        const status = Number((error as { status?: number }).status || 400);
        return err(c, status, error instanceof Error ? error.message : "setup guide failed");
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
