import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDb } from "../src/db.ts";
import {
  buildOAuthAuthorizationUrl,
  sealOAuthState,
  unsealOAuthState,
} from "../src/oauth.ts";

const state = {
  channelId: "lc_test",
  state: "state-value",
  verifier: "v".repeat(43),
  createdAt: Date.now(),
};

test("OAuth state cookie is signed and rejects tampering or expiry", () => {
  const token = sealOAuthState(state, "session-secret-at-least-16");
  assert.deepEqual(unsealOAuthState(token, "session-secret-at-least-16"), state);
  assert.equal(unsealOAuthState(`${token.slice(0, -1)}x`, "session-secret-at-least-16"), null);
  assert.equal(unsealOAuthState(token, "different-session-secret"), null);

  const expired = sealOAuthState(
    { ...state, createdAt: Date.now() - 11 * 60_000 },
    "session-secret-at-least-16",
  );
  assert.equal(unsealOAuthState(expired, "session-secret-at-least-16"), null);
});

test("OIDC authorization uses discovery, state, and PKCE", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://id.example.com/.well-known/openid-configuration");
    return new Response(
      JSON.stringify({
        issuer: "https://id.example.com",
        authorization_endpoint: "https://id.example.com/authorize",
        token_endpoint: "https://id.example.com/token",
        userinfo_endpoint: "https://id.example.com/userinfo",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const url = new URL(
      await buildOAuthAuthorizationUrl(
        {
          id: "lc_test",
          name: "Company OIDC",
          type: "oidc",
          enabled: true,
          issuer: "https://id.example.com",
          clientId: "touch-mail",
          clientSecret: "secret",
          scopes: ["openid", "profile"],
          subjectClaim: "sub",
          usernameClaim: "preferred_username",
          displayNameClaim: "name",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          updatedBy: "admin",
        },
        {},
        "https://mail.example.com/api/auth/oauth/callback",
        "state-value",
        "v".repeat(43),
      ),
    );
    assert.equal(url.origin + url.pathname, "https://id.example.com/authorize");
    assert.equal(url.searchParams.get("client_id"), "touch-mail");
    assert.equal(url.searchParams.get("state"), "state-value");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(url.searchParams.get("code_challenge"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("identity-bearing login channels lock provider identity fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "touch-mail-login-channel-"));
  try {
    const db = new AppDb(dir);
    await db.init();
    await assert.rejects(
      () =>
        db.createLoginChannel(
          {
            name: "Insecure OIDC",
            type: "oidc",
            issuer: "http://id.example.com",
            clientId: "touch-mail",
            clientSecret: "client-secret",
          },
          "admin",
        ),
      /必须使用 HTTPS/,
    );
    const channel = await db.createLoginChannel(
      {
        name: "Company OIDC",
        type: "oidc",
        issuer: "https://id.example.com",
        clientId: "touch-mail",
        clientSecret: "client-secret",
        scopes: ["openid", "profile"],
        subjectClaim: "sub",
      },
      "admin",
    );
    const first = await db.resolveAuthIdentity(channel.id, {
      subject: "employee-1",
      username: "employee@example.com",
      displayName: "Employee",
    });
    assert.equal(first.isNew, true);
    assert.equal(db.getLoginChannelIdentityCount(channel.id), 1);

    await assert.rejects(
      () => db.updateLoginChannel(channel.id, { issuer: "https://evil.example.com" }, "admin"),
      /已有用户身份记录/,
    );
    await assert.rejects(
      () => db.updateLoginChannel(channel.id, { clientId: "other-client" }, "admin"),
      /已有用户身份记录/,
    );
    await assert.rejects(
      () => db.updateLoginChannel(channel.id, { subjectClaim: "email" }, "admin"),
      /已有用户身份记录/,
    );

    const updated = await db.updateLoginChannel(
      channel.id,
      { name: "Company Login", enabled: false, clientSecret: "rotated-secret" },
      "admin",
    );
    assert.equal(updated?.name, "Company Login");
    assert.equal(updated?.enabled, false);
    assert.equal(updated?.clientSecret, "rotated-secret");
    await assert.rejects(() => db.deleteLoginChannel(channel.id), /已有用户身份记录/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
