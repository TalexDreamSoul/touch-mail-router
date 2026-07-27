import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDb } from "../src/db.ts";
import { ingestApiMail, resolveLegacyInboundRecipient } from "../src/inbound-adapters.ts";

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
