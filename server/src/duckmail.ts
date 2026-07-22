/**
 * DuckMail-compatible public API (mail.tm / Hydra style).
 * Spec: https://raw.githubusercontent.com/MoonWeSif/DuckMail/main/public/llm-api-docs.txt
 * Live: https://api.duckmail.sbs
 */
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import {
  AppDb,
  hashPassword,
  verifyPassword,
  type MailAccount,
  type MailMeta,
  type MessageFlags,
} from "./db.js";

type DmVars = {
  account: MailAccount;
  apiKey?: string | null;
};

function err(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 500,
  error: string,
  message: string,
) {
  return c.json({ error, message }, status);
}

function parseAddress(address: string): { local: string; domain: string } | null {
  const raw = address.trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at < 1) return null;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (!local || !domain) return null;
  return { local, domain };
}

function parseFrom(from: string): { name: string; address: string } {
  const raw = (from || "").trim();
  if (!raw) return { name: "", address: "" };
  // "Name" <addr@host>  or  Name <addr@host>
  const angle = raw.match(/^(?:"([^"]*)"|([^<]*?))\s*<([^>]+)>$/);
  if (angle) {
    return {
      name: (angle[1] || angle[2] || "").trim(),
      address: angle[3].trim(),
    };
  }
  // bare email
  if (raw.includes("@") && !raw.includes(" ")) {
    return { name: "", address: raw };
  }
  // fallback: last token with @
  const tokens = raw.split(/\s+/);
  const addr = tokens.find((t) => t.includes("@")) || raw;
  return { name: tokens.filter((t) => t !== addr).join(" ").trim(), address: addr };
}

function parseToList(to: string): Array<{ name: string; address: string }> {
  if (!to) return [];
  return to
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map(parseFrom);
}

function hydraView(pathBase: string, page: number, total: number, pageSize: number) {
  const last = Math.max(1, Math.ceil(total / pageSize) || 1);
  return {
    "@id": `${pathBase}?page=${page}`,
    "@type": "PartialCollectionView",
    "hydra:first": `${pathBase}?page=1`,
    "hydra:last": `${pathBase}?page=${last}`,
    ...(page > 1 ? { "hydra:previous": `${pathBase}?page=${page - 1}` } : {}),
    ...(page < last ? { "hydra:next": `${pathBase}?page=${page + 1}` } : {}),
  };
}

function publicAccount(a: MailAccount) {
  return {
    id: a.id,
    address: a.address,
    isActive: a.status === "active" && (!a.expiresAt || Date.parse(a.expiresAt) > Date.now()),
    isSilenced: false,
    authType: "email" as const,
    expiresAt: a.expiresAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function listMessage(meta: MailMeta, accountId: string, flags: MessageFlags) {
  return {
    id: meta.id,
    msgid: meta.messageId || meta.id,
    accountId,
    from: parseFrom(meta.from),
    to: parseToList(meta.to),
    subject: meta.subject || "",
    seen: Boolean(flags.seen),
    isDeleted: Boolean(flags.deleted),
    hasAttachments: meta.hasAttachments,
    size: meta.size,
    downloadUrl: `/sources/${meta.id}`,
    createdAt: meta.receivedAt,
    updatedAt: flags.updatedAt || meta.receivedAt,
  };
}

export function createDuckMailApp(db: AppDb, config: AppConfig) {
  const app = new Hono<{ Variables: DmVars }>();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-API-Provider-Base-URL", "Cache-Control"],
    }),
  );

  function extractBearer(c: Context): string | null {
    const h = c.req.header("authorization") || c.req.header("Authorization") || "";
    const m = h.match(/^Bearer\s+(.+)$/i);
    return m?.[1]?.trim() || null;
  }

  async function requireAccount(c: Context<{ Variables: DmVars }>, next: Next) {
    const token = extractBearer(c);
    if (!token) {
      return err(c, 401, "Unauthorized", "Missing or invalid Bearer token");
    }
    if (token.startsWith("dk_")) {
      return err(c, 401, "Unauthorized", "API key cannot access mailbox endpoints; use account token");
    }
    const account = db.getMailAccountByToken(token);
    if (!account) {
      return err(c, 401, "Unauthorized", "Invalid or expired token");
    }
    if (account.status !== "active") {
      return err(c, 403, "Forbidden", "Account is disabled");
    }
    if (account.expiresAt && Date.parse(account.expiresAt) <= Date.now()) {
      return err(c, 401, "Unauthorized", "Account expired");
    }
    c.set("account", account);
    await next();
  }

  function resolveApiKeyAuth(c: Context): {
    ok: boolean;
    userId: string | null;
    global: boolean;
  } {
    const token = extractBearer(c);
    if (!token?.startsWith("dk_")) return { ok: false, userId: null, global: false };
    return db.resolveApiKey(token);
  }

  // ---------- domains ----------
  app.get("/domains", (c) => {
    const page = Math.max(1, Number(c.req.query("page") || 1));
    const pageSize = 30;
    const auth = resolveApiKeyAuth(c);
    const all = db.listPublicDomains({
      systemDomain: config.INBOUND_DOMAIN,
      apiKeyUserId: auth.ok ? auth.userId : null,
      includeAllPrivate: auth.ok && auth.global,
    });
    const total = all.length;
    const start = (page - 1) * pageSize;
    const member = all.slice(start, start + pageSize).map((d) => ({
      id: d.id,
      domain: d.domain,
      ownerId: d.ownerId,
      isVerified: d.isVerified,
      visibility: d.visibility,
      verificationToken: d.verificationToken,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }));
    return c.json({
      "hydra:member": member,
      "hydra:totalItems": total,
      "hydra:view": hydraView("/domains", page, total, pageSize),
    });
  });

  // ---------- accounts ----------
  app.post("/accounts", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const address = String(body.address || "").trim().toLowerCase();
    const password = String(body.password || "");
    const expiresIn =
      body.expiresIn === undefined || body.expiresIn === null
        ? 86400
        : Number(body.expiresIn);

    const parsed = parseAddress(address);
    if (!parsed) {
      return err(c, 422, "Unprocessable Entity", "address must contain @");
    }
    if (parsed.local.length < 3) {
      return err(c, 422, "Unprocessable Entity", "username (before @) must be >= 3 chars");
    }
    if (!/^[a-z0-9._+-]+$/i.test(parsed.local)) {
      return err(c, 422, "Unprocessable Entity", "username has invalid characters");
    }
    if (password.length < 6) {
      return err(c, 422, "Unprocessable Entity", "password must be >= 6 chars");
    }

    const auth = resolveApiKeyAuth(c);
    const domains = db.listPublicDomains({
      systemDomain: config.INBOUND_DOMAIN,
      apiKeyUserId: auth.ok ? auth.userId : null,
      includeAllPrivate: auth.ok && auth.global,
    });
    const domainOk = domains.find((d) => d.domain === parsed.domain && d.isVerified);
    if (!domainOk) {
      return err(
        c,
        422,
        "Unprocessable Entity",
        `domain ${parsed.domain} is not available (private domains need owner API key)`,
      );
    }
    if (domainOk.visibility === "private" && !auth.ok) {
      return err(c, 403, "Forbidden", "API key required for private domain");
    }

    if (db.findMailAccountByAddress(address)) {
      return err(c, 409, "Conflict", "email address already exists");
    }

    let expiresAt: string | null = null;
    if (expiresIn === 0 || expiresIn === -1) {
      expiresAt = null;
    } else if (Number.isFinite(expiresIn) && expiresIn > 0) {
      expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    } else {
      expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
    }

    try {
      const account = await db.createMailAccount({
        address,
        password,
        expiresAt,
        // tenant = local part so CF inbound {tenant}@inbound works for this mailbox
        tenant: parsed.local,
      });
      return c.json(publicAccount(account), 201);
    } catch (e) {
      return err(c, 400, "Bad Request", e instanceof Error ? e.message : "create failed");
    }
  });

  app.get("/me", requireAccount, (c) => {
    return c.json(publicAccount(c.get("account")));
  });

  app.delete("/accounts/:id", requireAccount, async (c) => {
    const account = c.get("account");
    const id = c.req.param("id");
    if (id !== account.id) {
      return err(c, 403, "Forbidden", "You can only delete the currently logged-in account");
    }
    await db.deleteMailAccount(account.id);
    return c.body(null, 204);
  });

  // ---------- token ----------
  app.post("/token", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const address = String(body.address || "").trim().toLowerCase();
    const password = String(body.password || "");
    const account = db.findMailAccountByAddress(address);
    if (!account || !verifyPassword(password, account.passwordHash)) {
      return err(c, 401, "Unauthorized", "Invalid address or password");
    }
    if (account.status !== "active") {
      return err(c, 403, "Forbidden", "Account is disabled");
    }
    if (account.expiresAt && Date.parse(account.expiresAt) <= Date.now()) {
      return err(c, 401, "Unauthorized", "Account expired");
    }
    const token = await db.createMailToken(account.id);
    return c.json({ id: account.id, token });
  });

  // ---------- messages ----------
  app.get("/messages", requireAccount, async (c) => {
    const account = c.get("account");
    const page = Math.max(1, Number(c.req.query("page") || 1));
    const pageSize = 30;
    const { items, total } = await db.listMailsForAccount(account, {
      page,
      pageSize,
      includeDeleted: false,
    });
    const member = items.map((m) => {
      const flags = db.getMessageFlags(account.tenant, m.id);
      return listMessage(m, account.id, flags);
    });
    return c.json({
      "hydra:member": member,
      "hydra:totalItems": total,
      "hydra:view": hydraView("/messages", page, total, pageSize),
    });
  });

  app.get("/messages/:id", requireAccount, async (c) => {
    const account = c.get("account");
    const id = c.req.param("id") || "";
    const flags = db.getMessageFlags(account.tenant, id);
    if (flags.deleted) {
      return err(c, 404, "Not Found", "message not found");
    }
    const full = (await db.getMail(account.tenant, id)) as Record<string, unknown> | null;
    if (!full) {
      return err(c, 404, "Not Found", "message not found");
    }
    const meta = full as unknown as MailMeta & {
      text?: string;
      html?: string;
      attachments?: Array<{
        filename?: string;
        contentType?: string;
        size?: number;
        contentDisposition?: string;
      }>;
    };
    const base = listMessage(meta, account.id, flags);
    const attachments = (meta.attachments || []).map((a, i) => ({
      id: String(i),
      filename: a.filename || `attachment-${i}`,
      contentType: a.contentType || "application/octet-stream",
      disposition: a.contentDisposition || "attachment",
      transferEncoding: "",
      related: false,
      size: a.size || 0,
      downloadUrl: `/messages/${id}/attachments/${i}`,
    }));
    return c.json({
      ...base,
      text: meta.text || "",
      html: meta.html ? [meta.html] : [],
      attachments,
    });
  });

  app.patch("/messages/:id", requireAccount, async (c) => {
    const account = c.get("account");
    const id = c.req.param("id") || "";
    const full = await db.getMail(account.tenant, id);
    if (!full) return err(c, 404, "Not Found", "message not found");
    await db.setMessageFlags(account.tenant, id, { seen: true });
    return c.json({ seen: true });
  });

  app.delete("/messages/:id", requireAccount, async (c) => {
    const account = c.get("account");
    const id = c.req.param("id") || "";
    const full = await db.getMail(account.tenant, id);
    if (!full) return err(c, 404, "Not Found", "message not found");
    await db.setMessageFlags(account.tenant, id, { deleted: true });
    return c.body(null, 204);
  });

  // ---------- sources ----------
  app.get("/sources/:id", requireAccount, async (c) => {
    const account = c.get("account");
    const id = c.req.param("id") || "";
    const full = (await db.getMail(account.tenant, id)) as {
      rawPath?: string;
      id?: string;
    } | null;
    if (!full) return err(c, 404, "Not Found", "message not found");
    let data = "";
    if (full.rawPath) {
      try {
        data = await readFile(path.join(config.DATA_DIR, full.rawPath), "utf8");
      } catch {
        data = "";
      }
    }
    return c.json({
      id,
      downloadUrl: `/sources/${id}`,
      data,
    });
  });

  // ---------- health for this surface ----------
  app.get("/", (c) =>
    c.json({
      service: "touch-mail-router",
      compatible: "duckmail",
      docs: "https://www.duckmail.sbs/zh/api-docs",
      endpoints: [
        "GET /domains",
        "POST /accounts",
        "POST /token",
        "GET /me",
        "DELETE /accounts/{id}",
        "GET /messages",
        "GET /messages/{id}",
        "PATCH /messages/{id}",
        "DELETE /messages/{id}",
        "GET /sources/{id}",
      ],
    }),
  );

  return app;
}

// re-export helpers used by tests
export { hashPassword, verifyPassword };
