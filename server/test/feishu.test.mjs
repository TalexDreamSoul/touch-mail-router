import assert from "node:assert/strict";
import test from "node:test";
import { listFeishuChats, sendFeishuNotification, testFeishuConnection } from "../src/feishu.ts";

test("requires only App ID and App Secret", async () => {
  await assert.rejects(
    () => testFeishuConnection({ appId: "", appSecret: "secret", notifyChatId: "" }),
    /App ID/,
  );
  await assert.rejects(
    () => testFeishuConnection({ appId: "cli_test", appSecret: "", notifyChatId: "" }),
    /App Secret/,
  );
});

test("validates credentials without requiring event subscription fields", async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ code: 0, msg: "ok", tenant_access_token: "token" });
  };

  const result = await testFeishuConnection(
    { appId: "cli_test", appSecret: "secret", notifyChatId: "" },
    fetchMock,
  );

  assert.deepEqual(result, { messageSent: false });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /tenant_access_token\/internal$/);
});

test("reports Feishu API failures with sanitized response details", async () => {
  const fetchMock = async () =>
    Response.json({
      code: 10003,
      msg: "app not found",
      tenant_access_token: "must-not-leak",
      data: { app_secret: "must-not-leak" },
    });

  await assert.rejects(
    () =>
      testFeishuConnection(
        { appId: "cli_invalid", appSecret: "secret", notifyChatId: "" },
        fetchMock,
      ),
    (error) => {
      assert.equal(error?.name, "FeishuTestError");
      assert.match(error.message, /app not found/);
      assert.equal(error.kind, "remote");
      assert.equal(error.details.phase, "获取访问凭据");
      assert.equal(error.details.feishuCode, 10003);
      assert.equal(error.details.method, "POST");
      assert.equal(error.details.request.app_secret, "[CONFIGURED]");
      assert.equal(error.details.request.app_id, "cli_invalid");
      assert.equal(typeof error.details.durationMs, "number");
      assert.match(error.details.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(error.details.suggestion, /Chat ID/);
      assert.equal(error.details.response.tenant_access_token, "[REDACTED]");
      assert.equal(error.details.response.data.app_secret, "[REDACTED]");
      return true;
    },
  );
});

test("redacts secrets embedded in messages and handles null responses", async () => {
  const secret = "secret-value-that-must-not-leak";
  const messageFetch = async () =>
    Response.json({ code: 10003, msg: `invalid secret ${secret}` });
  await assert.rejects(
    () => testFeishuConnection({ appId: "cli_invalid", appSecret: secret, notifyChatId: "" }, messageFetch),
    (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.equal(JSON.stringify(error.details).includes(secret), false);
      return true;
    },
  );

  const nullFetch = async () => new Response("null", { status: 502 });
  await assert.rejects(
    () => testFeishuConnection({ appId: "cli_invalid", appSecret: secret, notifyChatId: "" }, nullFetch),
    (error) => error?.name === "FeishuTestError" && error.details.upstreamStatus === 502,
  );
});

test("redacts secrets from network error messages", async () => {
  const secret = "network-secret-that-must-not-leak";
  const fetchMock = async () => {
    throw new TypeError(`request failed with ${secret} and Bearer exposed-token`);
  };

  await assert.rejects(
    () => testFeishuConnection({ appId: "cli_invalid", appSecret: secret, notifyChatId: "" }, fetchMock),
    (error) => {
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes("exposed-token"), false);
      return true;
    },
  );
});

test("lists chats visible to the bot", async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return Response.json({ code: 0, msg: "ok", tenant_access_token: "token" });
    }
    return Response.json({
      code: 0,
      msg: "ok",
      data: {
        items: [
          { chat_id: "oc_team", name: "邮件通知群", description: "告警", avatar: "https://example.com/a.png" },
        ],
      },
    });
  };

  const result = await listFeishuChats({ appId: "cli_test", appSecret: "secret" }, fetchMock);

  assert.deepEqual(result, {
    items: [
      { chatId: "oc_team", name: "邮件通知群", description: "告警", avatar: "https://example.com/a.png" },
    ],
  });
  assert.match(calls[1].url, /\/open-apis\/im\/v1\/chats\?page_size=100$/);
  assert.equal(calls[1].init.headers.authorization, "Bearer token");
});

test("explains when bot ability is disabled for chat listing", async () => {
  let call = 0;
  const fetchMock = async () => {
    call += 1;
    return call === 1
      ? Response.json({ code: 0, msg: "ok", tenant_access_token: "token" })
      : Response.json({ code: 232025, msg: "Bot ability is not activated." }, { status: 400 });
  };

  await assert.rejects(
    () => listFeishuChats({ appId: "cli_test", appSecret: "secret" }, fetchMock),
    (error) => error.details.feishuCode === 232025 && /机器人能力/.test(error.details.suggestion),
  );
});

test("sends a custom inbound notification", async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? Response.json({ code: 0, msg: "ok", tenant_access_token: "token" })
      : Response.json({ code: 0, msg: "ok" });
  };

  await sendFeishuNotification(
    { appId: "cli_test", appSecret: "secret", notifyChatId: "oc_test" },
    "收到新邮件：hello",
    fetchMock,
  );

  const body = JSON.parse(calls[1].init.body);
  assert.equal(JSON.parse(body.content).text, "收到新邮件：hello");
});

test("sends a test message when a chat ID is provided", async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return Response.json({ code: 0, msg: "ok", tenant_access_token: "token" });
    }
    return Response.json({ code: 0, msg: "ok" });
  };

  const result = await testFeishuConnection(
    { appId: "cli_test", appSecret: "secret", notifyChatId: "oc_test" },
    fetchMock,
  );

  assert.deepEqual(result, { messageSent: true });
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /receive_id_type=chat_id/);
  assert.equal(calls[1].init.headers.authorization, "Bearer token");
  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.receive_id, "oc_test");
  assert.equal(body.msg_type, "text");
});
