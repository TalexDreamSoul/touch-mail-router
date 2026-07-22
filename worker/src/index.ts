/**
 * touch-mail-router Worker
 *
 * 收信入口：Cloudflare Email Routing → email() handler
 * 再 HTTPS 推送到你的云端 /v1/inbound
 *
 * 客户接入（长期可用的「转发」方案）：
 *   客户把 support@客户域 转发到  {tenant}@inbound.你的域
 *   或  {tenant}+{channel}@inbound.你的域
 */

export interface Env {
  WEBHOOK_URL: string;
  WEBHOOK_SECRET: string;
  INBOUND_DOMAINS: string;
  SIGNATURE_SKEW_SECONDS?: string;
  REJECT_ON_FAILURE?: string;
  MAX_EMAIL_BYTES?: string;
  /** 可选：CF 已验证的保底转发邮箱 */
  FALLBACK_EMAIL?: string;
}

interface ParsedRecipient {
  tenant: string;
  channel: string;
  local: string;
  domain: string;
  raw: string;
}

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      return Response.json({
        ok: true,
        service: "touch-mail-router",
        mode: "email-worker",
        inboundDomains: splitCsv(env.INBOUND_DOMAINS),
      });
    }
    return new Response("Not Found", { status: 404 });
  },

  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const started = Date.now();
    const to = (message.to || "").trim().toLowerCase();
    const from = (message.from || "").trim();
    const subject = message.headers.get("subject") || "";
    const messageId = message.headers.get("message-id") || "";

    console.log(
      JSON.stringify({
        event: "email.received",
        from,
        to,
        subject,
        messageId,
        size: message.rawSize,
      }),
    );

    if (!env.WEBHOOK_URL || !env.WEBHOOK_SECRET) {
      console.error("missing WEBHOOK_URL or WEBHOOK_SECRET");
      message.setReject("Inbound gateway misconfigured");
      return;
    }

    const domains = splitCsv(env.INBOUND_DOMAINS).map((d) => d.toLowerCase());
    const parsed = parseRecipient(to);
    if (!parsed) {
      message.setReject("Invalid recipient address");
      return;
    }

    if (domains.length > 0 && !domains.includes(parsed.domain)) {
      console.warn("recipient domain not allowed", parsed.domain);
      message.setReject("Recipient domain not accepted");
      return;
    }

    if (!parsed.tenant || parsed.tenant === "postmaster" || parsed.tenant === "abuse") {
      // 系统地址：可按需处理；默认丢弃
      if (parsed.tenant === "postmaster" || parsed.tenant === "abuse") {
        console.log("system address ignored", parsed.tenant);
        return;
      }
      message.setReject("Missing tenant in local-part");
      return;
    }

    const maxBytes = Number(env.MAX_EMAIL_BYTES || DEFAULT_MAX_BYTES);
    if (message.rawSize > maxBytes) {
      message.setReject(`Email too large (max ${maxBytes} bytes)`);
      return;
    }

    let raw: ArrayBuffer;
    try {
      raw = await new Response(message.raw).arrayBuffer();
    } catch (err) {
      console.error("failed to read raw email", err);
      await fail(message, env, "Failed to read email body");
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signPayload(env.WEBHOOK_SECRET, timestamp, raw);

    const headers: Record<string, string> = {
      "content-type": "message/rfc822",
      "x-timestamp": timestamp,
      "x-signature": `sha256=${signature}`,
      "x-email-from": from,
      "x-email-to": to,
      "x-email-subject": encodeHeaderValue(subject),
      "x-message-id": messageId,
      "x-tenant": parsed.tenant,
      "x-channel": parsed.channel,
      "x-email-size": String(message.rawSize),
      "user-agent": "touch-mail-router-worker/0.1",
    };

    // 透传若干有用头，便于云端还原转发场景
    const passHeaders = [
      "delivered-to",
      "x-forwarded-to",
      "x-forwarded-for",
      "x-original-to",
      "x-original-from",
      "reply-to",
      "in-reply-to",
      "references",
      "date",
    ];
    for (const name of passHeaders) {
      const value = message.headers.get(name);
      if (value) {
        headers[`x-original-${name}`] = encodeHeaderValue(value);
      }
    }

    let response: Response;
    try {
      response = await fetch(env.WEBHOOK_URL, {
        method: "POST",
        headers,
        body: raw,
      });
    } catch (err) {
      console.error("webhook network error", err);
      await fail(message, env, "Webhook unreachable");
      return;
    }

    const bodyText = await response.text().catch(() => "");
    console.log(
      JSON.stringify({
        event: "email.webhook",
        status: response.status,
        tenant: parsed.tenant,
        channel: parsed.channel,
        ms: Date.now() - started,
        body: bodyText.slice(0, 300),
      }),
    );

    if (response.ok) {
      // 可选：同时 forward 到真人邮箱做双写
      if (env.FALLBACK_EMAIL && message.headers.get("x-touch-also-forward") === "1") {
        ctx.waitUntil(message.forward(env.FALLBACK_EMAIL).catch(console.error));
      }
      return;
    }

    // 4xx：客户端/业务拒绝 → 永久拒收，避免毒信死循环
    if (response.status >= 400 && response.status < 500) {
      message.setReject(`Inbound rejected: HTTP ${response.status}`);
      return;
    }

    // 5xx / 其它 → 按配置重试或拒收 / 保底转发
    await fail(message, env, `Webhook HTTP ${response.status}`);
  },
} satisfies ExportedHandler<Env>;

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 支持：
 *   tenant@domain
 *   tenant+channel@domain
 *   tenant+a+b@domain  → channel = "a+b"
 */
function parseRecipient(address: string): ParsedRecipient | null {
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!local || !domain) return null;

  const plus = local.indexOf("+");
  const tenant = (plus === -1 ? local : local.slice(0, plus)).toLowerCase();
  const channel = plus === -1 ? "default" : local.slice(plus + 1).toLowerCase() || "default";

  return { tenant, channel, local: local.toLowerCase(), domain, raw: address };
}

function encodeHeaderValue(value: string): string {
  // HTTP 头必须是 ASCII 安全；非 ASCII 用 base64url
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `b64:${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

async function signPayload(
  secret: string,
  timestamp: string,
  body: ArrayBuffer,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const payload = new Uint8Array(prefix.byteLength + body.byteLength);
  payload.set(prefix, 0);
  payload.set(new Uint8Array(body), prefix.byteLength);
  const sig = await crypto.subtle.sign("HMAC", key, payload);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fail(
  message: ForwardableEmailMessage,
  env: Env,
  reason: string,
): Promise<void> {
  console.error("email.fail", reason);

  if (env.FALLBACK_EMAIL) {
    try {
      await message.forward(env.FALLBACK_EMAIL);
      console.log("forwarded to FALLBACK_EMAIL after failure");
      return;
    } catch (err) {
      console.error("fallback forward failed", err);
    }
  }

  const reject = String(env.REJECT_ON_FAILURE || "false").toLowerCase() === "true";
  if (reject) {
    message.setReject(reason);
    return;
  }

  // 抛错：让 Cloudflare 侧按失败处理（可能重试）；比永久 reject 更适合瞬时故障
  throw new Error(reason);
}
