import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDb } from "../src/db.ts";

test("email forwarding channels receive an isolated signing token", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "touch-mail-forward-channel-"));
  try {
    const db = new AppDb(dir);
    await db.init();
    const channel = await db.createReceiveChannel(
      {
        name: "Forward",
        type: "email_forward",
        forwardingAddressTemplate: "{tenant}@inbound.example.com",
      },
      "admin",
    );
    assert.match(channel.pushToken, /^tm_in_/);
    assert.equal(channel.pushToken.length >= 16, true);
    assert.equal(db.getReceiveChannelPublic(channel.id)?.pushToken.includes("…"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt database refuses to start without overwriting the file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "touch-mail-db-corrupt-"));
  const file = path.join(dir, "app.json");
  const corrupt = "{not valid json";
  try {
    await writeFile(file, corrupt, "utf8");
    const db = new AppDb(dir);
    await assert.rejects(() => db.init(), SyntaxError);
    assert.equal(await readFile(file, "utf8"), corrupt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy domains remain unbound for explicit secure migration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "touch-mail-db-"));
  const createdAt = "2026-01-01T00:00:00.000Z";
  const legacy = {
    users: [{
      id: "u1",
      username: "owner",
      passwordHash: "unused",
      tenant: "owner",
      displayName: "Owner",
      role: "admin",
      status: "active",
      createdAt,
      updatedAt: createdAt,
    }],
    domains: [{
      id: "d1",
      userId: "u1",
      domain: "legacy.example.com",
      note: "legacy",
      visibility: "private",
      createdAt,
    }],
    sessions: [],
    auditLogs: [],
    mailAccounts: [],
    mailTokens: [],
    userApiKeys: [],
    apiCallLogs: [],
    messageFlags: {},
    settings: { feishu: {}, apiKeys: [] },
  };

  try {
    await writeFile(path.join(dir, "app.json"), JSON.stringify(legacy), "utf8");
    const db = new AppDb(dir);
    await db.init();

    const [domain] = db.listDomains("u1");
    assert.equal(domain.receiveChannelId, null);
    assert.equal(domain.workerName, "");
    assert.equal(db.listReceiveChannels(true).length, 0);

    const persisted = JSON.parse(await readFile(path.join(dir, "app.json"), "utf8"));
    assert.equal(persisted.domains[0].receiveChannelId, null);
    assert.deepEqual(persisted.receiveChannels, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
