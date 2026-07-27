import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDb } from "../src/db.ts";
import {
  ingestApiMail,
  resolveLegacyInboundRecipient,
  syncDoneMailChannel,
  testDoneMailConnection,
} from "../src/inbound-adapters.ts";

test("legacy inbound tenant is derived only from the envelope recipient", () => {
  assert.deepEqual(
    resolveLegacyInboundRecipient("owner+orders@inbound.example.com", "inbound.example.com"),
    { tenant: "owner" },
  );
  assert.equal(
    resolveLegacyInboundRecipient("victim@customer.example.com", "inbound.example.com"),
    null,
  );
});

test("email forwarding collector modes keep credentials isolated", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "touch-mail-forward-mode-"));
  try {
    const db = new AppDb(dir);
    await db.init();
    const doneMail = await db.createReceiveChannel(
      {
        name: "Forward via DoneMail",
        type: "email_forward",
        enabled: true,
        forwardingAddressTemplate: "{tenant}@inbound.example.com",
        collectorType: "donemail",
        baseUrl: "https://done.example.com",
        adminKey: "admin-secret",
      },
      "admin",
    );
    assert.equal(doneMail.collectorType, "donemail");
    assert.equal(doneMail.pushToken, "");
    assert.equal(doneMail.adminKey, "admin-secret");
    const switched = await db.updateReceiveChannel(
      doneMail.id,
      { collectorType: "webhook" },
      "admin",
    );
    assert.equal(switched?.collectorType, "webhook");
    assert.match(switched?.pushToken || "", /^tm_in_/);
    assert.equal(switched?.baseUrl, "");
    assert.equal(switched?.adminKey, "");

    const webhook = await db.createReceiveChannel(
      {
        name: "Forward via Webhook",
        type: "email_forward",
        enabled: true,
        forwardingAddressTemplate: "{tenant}@hook.example.com",
        collectorType: "webhook",
      },
      "admin",
    );
    assert.equal(webhook.collectorType, "webhook");
    assert.match(webhook.pushToken, /^tm_in_/);
    assert.equal(webhook.baseUrl, "");
    assert.equal(webhook.adminKey, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DoneMail forwarding resolves the owner from the rendered forwarding target", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "touch-mail-forward-donemail-"));
  try {
    const db = new AppDb(dir);
    await db.init();
    const user = await db.createUser({ username: "owner", password: "password123" });
    const channel = await db.createReceiveChannel(
      {
        name: "Forward via DoneMail",
        type: "email_forward",
        enabled: true,
        forwardingAddressTemplate: "{tenant}@inbound.example.com",
        collectorType: "donemail",
        baseUrl: "https://done.example.com",
        adminKey: "admin-secret",
      },
      "admin",
    );
    await db.addDomain(user.id, "customer.example.com", "", "private", channel.id, "");

    const fetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/api/mails")) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: [{
              id: "forwarded-1",
              from: "sender@example.net",
              to: `${user.tenant}@inbound.example.com`,
              subject: "forwarded",
              text: "body",
              receivedAt: new Date().toISOString(),
            }],
            pagination: { hasMore: false },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected request ${url}`);
    };

    assert.deepEqual(await testDoneMailConnection(channel, fetchImpl), { mailCount: 1 });
    const result = await syncDoneMailChannel(db, channel, 1024 * 1024, fetchImpl);
    assert.deepEqual(result, { imported: 1, duplicates: 0, skipped: 0 });
    assert.equal((await db.listMails(user.tenant, { pageSize: 10 })).total, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("API push stores once and notifies only for a new message", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "touch-mail-inbound-"));
  try {
    const db = new AppDb(dir);
    await db.init();
    const user = await db.createUser({ username: "owner", password: "password123" });
    const channel = await db.createReceiveChannel(
      { name: "API Push", type: "api_push", enabled: true },
      "owner",
    );
    await db.addDomain(
      user.id,
      "mail.example.com",
      "",
      "private",
      channel.id,
      "",
    );
    const impact = db.getReceiveChannelImpact(channel.id);
    assert.equal(impact.userCount, 1);
    assert.equal(impact.domainCount, 1);
    assert.equal(impact.users[0].username, "owner");
    assert.equal(impact.domains[0].domain, "mail.example.com");

    const notifications = [];
    const notify = async (mail) => {
      notifications.push(mail);
    };
    const payload = {
      id: "source-1",
      from: "sender@example.net",
      to: "inbox@mail.example.com",
      subject: "hello",
      text: "body",
    };

    const [first, second] = await Promise.all([
      ingestApiMail(db, channel, payload, 1024 * 1024, undefined, notify),
      ingestApiMail(db, channel, payload, 1024 * 1024, undefined, notify),
    ]);

    assert.deepEqual([first.duplicate, second.duplicate].sort(), [false, true]);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].subject, "hello");
    const page = await db.listMails(user.tenant, { pageSize: 10 });
    assert.equal(page.total, 1);
    assert.equal((await readFile(path.join(dir, page.items[0].rawPath), "utf8")).includes("body"), true);
    assert.notEqual(await db.getMail(user.tenant, page.items[0].id), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
