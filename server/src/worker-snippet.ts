/** Generate ready-to-copy Cloudflare Email Worker source for a tenant. */

export function buildWorkerSnippet(opts: {
  webhookUrl: string;
  webhookSecret: string;
  domain: string;
  workerName: string;
}): {
  js: string;
  wranglerToml: string;
  setupSteps: string[];
  routeSteps: string[];
} {
  const { webhookUrl, webhookSecret, domain, workerName } = opts;

  const js = `/**
 * Touch Mail - Cloudflare Email Worker
 * Domain: ${domain}
 * Worker Name: ${workerName}
 *
 * Cloudflare Email Routing must use "Send to a Worker" and select this exact Worker.
 */

const CONFIG = {
  WEBHOOK_URL: ${JSON.stringify(webhookUrl)},
  WEBHOOK_SECRET: "",
  DOMAIN: ${JSON.stringify(domain)},
  MAX_EMAIL_BYTES: 15 * 1024 * 1024,
};

export default {
  async email(message, env) {
    const secret = env.WEBHOOK_SECRET || CONFIG.WEBHOOK_SECRET;
    const webhookUrl = env.WEBHOOK_URL || CONFIG.WEBHOOK_URL;
    const acceptedDomain = String(env.EMAIL_DOMAIN || CONFIG.DOMAIN).trim().toLowerCase();
    const to = (message.to || "").trim().toLowerCase();
    const from = (message.from || "").trim();
    const subject = message.headers.get("subject") || "";
    const messageId = message.headers.get("message-id") || "";
    const parsed = parseRecipient(to);

    if (!parsed || parsed.domain !== acceptedDomain) {
      message.setReject("Recipient domain not accepted");
      return;
    }
    if (!secret || !webhookUrl) {
      message.setReject("Worker is not configured");
      return;
    }
    if (message.rawSize > CONFIG.MAX_EMAIL_BYTES) {
      message.setReject("Email too large");
      return;
    }

    const raw = await new Response(message.raw).arrayBuffer();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await sign(secret, timestamp, raw);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-timestamp": timestamp,
        "x-signature": "sha256=" + signature,
        "x-email-from": from,
        "x-email-to": to,
        "x-email-subject": encodeHeader(subject),
        "x-message-id": messageId,
        "x-tenant": parsed.local,
        "x-channel": "worker",
        "user-agent": "touch-mail-worker/0.3",
      },
      body: raw,
    });

    if (response.ok) return;
    if (response.status >= 400 && response.status < 500) {
      message.setReject("Inbound rejected: HTTP " + response.status);
      return;
    }
    throw new Error("Webhook HTTP " + response.status);
  },
};

function parseRecipient(address) {
  const at = address.lastIndexOf("@");
  if (at <= 0) return null;
  const local = address.slice(0, at).toLowerCase();
  const domain = address.slice(at + 1).toLowerCase();
  return local && domain ? { local, domain } : null;
}

function encodeHeader(value) {
  if (/^[\\x20-\\x7E]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return "b64:" + btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
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
  const signature = await crypto.subtle.sign("HMAC", key, payload);
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
`;

  const wranglerToml = `name = ${JSON.stringify(workerName)}
main = "src/index.js"
compatibility_date = "2026-07-26"

[vars]
WEBHOOK_URL = ${JSON.stringify(webhookUrl)}
EMAIL_DOMAIN = ${JSON.stringify(domain)}

# Run and paste the separately provided secret:
#   npx wrangler secret put WEBHOOK_SECRET
`;

  const setupSteps = [
    `在 Cloudflare Workers & Pages 中创建 Worker，Worker Name 必须填写 ${workerName}。`,
    `粘贴 Worker 代码并部署；如果使用 Wrangler，wrangler.toml 的 name 也必须保持为 ${workerName}。`,
    `配置 Secret WEBHOOK_SECRET，并确认变量 WEBHOOK_URL 与 EMAIL_DOMAIN。`,
    `进入域名 ${domain} 的 Email Routing，创建路由规则并选择刚部署的 Worker。`,
    `这里不需要把邮件转发到另一个邮箱；路由动作必须是 Send to a Worker。`,
  ];
  const routeSteps = [
    `Cloudflare 控制台 → 域名 ${domain} → Email → Email Routing → Routing rules。`,
    `创建 Custom address；如需接收全部地址，也可以启用 Catch-all。`,
    `Action 选择 Send to a Worker，不要选择 Forward to an email。`,
    `Worker 下拉框选择 ${workerName}；名称必须与创建 Worker 时完全一致。`,
    `保存并启用规则，然后回到本页使用 SMTP 自动发送接入测试。`,
  ];

  return { js, wranglerToml, setupSteps, routeSteps };
}
