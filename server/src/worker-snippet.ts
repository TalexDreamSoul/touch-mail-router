/** Generate ready-to-copy Cloudflare Email Worker source for a tenant. */

export function buildWorkerSnippet(opts: {
  webhookUrl: string;
  webhookSecret: string;
  inboundDomain: string;
  tenant: string;
}): { js: string; wranglerToml: string; setupSteps: string[] } {
  const { webhookUrl, webhookSecret, inboundDomain, tenant } = opts;

  const js = `/**
 * Touch Mail - Email Worker
 * Tenant: ${tenant}
 * Generated for Cloudflare Email Routing
 *
 * Deploy: paste into a Worker, bind Email Routing catch-all to this Worker.
 * Secrets: WEBHOOK_SECRET (optional if hardcoded below for quick start)
 */

const CONFIG = {
  WEBHOOK_URL: ${JSON.stringify(webhookUrl)},
  WEBHOOK_SECRET: ${JSON.stringify(webhookSecret)},
  INBOUND_DOMAINS: ${JSON.stringify(inboundDomain)},
  // Optional: only accept this tenant local-part (recommended)
  ALLOWED_TENANTS: ${JSON.stringify(tenant)},
  MAX_EMAIL_BYTES: 15 * 1024 * 1024,
  REJECT_ON_FAILURE: false,
};

export default {
  async email(message, env, ctx) {
    const secret = env.WEBHOOK_SECRET || CONFIG.WEBHOOK_SECRET;
    const webhookUrl = env.WEBHOOK_URL || CONFIG.WEBHOOK_URL;
    const domains = String(env.INBOUND_DOMAINS || CONFIG.INBOUND_DOMAINS)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const allowed = String(env.ALLOWED_TENANTS || CONFIG.ALLOWED_TENANTS)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const to = (message.to || "").trim().toLowerCase();
    const from = (message.from || "").trim();
    const subject = message.headers.get("subject") || "";
    const messageId = message.headers.get("message-id") || "";

    const parsed = parseRecipient(to);
    if (!parsed) {
      message.setReject("Invalid recipient");
      return;
    }
    if (domains.length && !domains.includes(parsed.domain)) {
      message.setReject("Domain not accepted");
      return;
    }
    if (allowed.length && !allowed.includes(parsed.tenant)) {
      message.setReject("Tenant not accepted");
      return;
    }
    if (message.rawSize > CONFIG.MAX_EMAIL_BYTES) {
      message.setReject("Email too large");
      return;
    }

    const raw = await new Response(message.raw).arrayBuffer();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await sign(secret, timestamp, raw);

    const headers = {
      "content-type": "message/rfc822",
      "x-timestamp": timestamp,
      "x-signature": "sha256=" + signature,
      "x-email-from": from,
      "x-email-to": to,
      "x-email-subject": encodeHeader(subject),
      "x-message-id": messageId,
      "x-tenant": parsed.tenant,
      "x-channel": parsed.channel,
      "x-email-size": String(message.rawSize),
      "user-agent": "touch-mail-worker/0.2",
    };

    let res;
    try {
      res = await fetch(webhookUrl, { method: "POST", headers, body: raw });
    } catch (e) {
      console.error("webhook error", e);
      if (CONFIG.REJECT_ON_FAILURE) message.setReject("Webhook unreachable");
      else throw e;
      return;
    }

    if (res.ok) return;
    if (res.status >= 400 && res.status < 500) {
      message.setReject("Inbound rejected: HTTP " + res.status);
      return;
    }
    if (CONFIG.REJECT_ON_FAILURE) message.setReject("Webhook HTTP " + res.status);
    else throw new Error("Webhook HTTP " + res.status);
  },
};

function parseRecipient(address) {
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!local || !domain) return null;
  const plus = local.indexOf("+");
  const tenant = (plus === -1 ? local : local.slice(0, plus)).toLowerCase();
  const channel = plus === -1 ? "default" : local.slice(plus + 1).toLowerCase() || "default";
  return { tenant, channel, domain, local: local.toLowerCase() };
}

function encodeHeader(value) {
  if (/^[\\x20-\\x7E]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "b64:" + btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
}

async function sign(secret, timestamp, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = new TextEncoder().encode(timestamp + ".");
  const payload = new Uint8Array(prefix.byteLength + body.byteLength);
  payload.set(prefix, 0);
  payload.set(new Uint8Array(body), prefix.byteLength);
  const sig = await crypto.subtle.sign("HMAC", key, payload);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
`;

  const wranglerToml = `name = "touch-mail-${tenant}"
main = "src/index.js"
compatibility_date = "2026-06-25"

[vars]
WEBHOOK_URL = ${JSON.stringify(webhookUrl)}
INBOUND_DOMAINS = ${JSON.stringify(inboundDomain)}
ALLOWED_TENANTS = ${JSON.stringify(tenant)}

# Then run:
#   npx wrangler secret put WEBHOOK_SECRET
# value: ${webhookSecret}
`;

  const setupSteps = [
    `在 Cloudflare 控制台创建 Worker，粘贴下方 Worker 代码（或用 wrangler.toml 部署）并发布。`,
    `为入站域 ${inboundDomain} 开启 Email Routing，Catch-all / 路由规则指向该 Worker（不是客户业务域的 MX）。`,
    `配置 Secret：WEBHOOK_SECRET（与本服务一致）；变量 WEBHOOK_URL / INBOUND_DOMAINS / ALLOWED_TENANTS 见代码或 wrangler.toml。`,
    `把客户业务邮箱完整转发到 ${tenant}@${inboundDomain}（渠道：${tenant}+orders@${inboundDomain}）。`,
    `在本平台「域名」页登记客户域仅为台账；收信依赖转发 + Worker，登记本身不会接通邮件。`,
    `发一封测试信后到「邮件」页确认入站；本地可用 scripts/simulate-inbound.sh 模拟推送。`,
  ];

  return { js, wranglerToml, setupSteps };
}
