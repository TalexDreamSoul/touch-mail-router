import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(opts: {
  secret: string;
  timestamp: string;
  signatureHeader: string;
  body: Buffer;
  skewSeconds: number;
}): { ok: true } | { ok: false; reason: string } {
  const { secret, timestamp, signatureHeader, body, skewSeconds } = opts;

  if (!timestamp || !/^\d+$/.test(timestamp)) {
    return { ok: false, reason: "invalid timestamp" };
  }

  const ts = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > skewSeconds) {
    return { ok: false, reason: "timestamp outside allowed skew" };
  }

  const provided = signatureHeader.replace(/^sha256=/i, "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    return { ok: false, reason: "invalid signature format" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }

  return { ok: true };
}


export function deriveDomainWebhookSecret(masterSecret: string, domainId: string): string {
  return createHmac("sha256", masterSecret)
    .update(`domain-webhook:${domainId}`)
    .digest("base64url");
}
