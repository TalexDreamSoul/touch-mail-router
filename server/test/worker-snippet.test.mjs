import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { deriveDomainWebhookSecret, verifySignature } from "../src/crypto.ts";
import { buildWorkerSnippet } from "../src/worker-snippet.ts";

test("generated Worker is valid JavaScript and uses one domain", async () => {
  const snippet = buildWorkerSnippet({
    webhookUrl: "https://mail.example.com/v1/inbound",
    webhookSecret: "derived-secret",
    domain: "customer.example.com",
    workerName: "mail-customer-example",
  });
  const dir = await mkdtemp(path.join(tmpdir(), "touch-mail-worker-"));
  const file = path.join(dir, "worker.mjs");
  try {
    await writeFile(file, snippet.js, "utf8");
    const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.match(snippet.js, /customer\.example\.com/);
  assert.doesNotMatch(snippet.js, /derived-secret/);
  assert.match(snippet.wranglerToml, /EMAIL_DOMAIN = "customer\.example\.com"/);
});

test("domain-derived secret verifies the Worker signature", () => {
  const body = Buffer.from("Subject: test\r\n\r\nhello");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = deriveDomainWebhookSecret("master-secret", "domain-id");
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");

  assert.deepEqual(
    verifySignature({
      secret,
      timestamp,
      signatureHeader: `sha256=${signature}`,
      body,
      skewSeconds: 300,
    }),
    { ok: true },
  );
});
