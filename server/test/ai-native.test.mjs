import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenApi, buildSkillManifest } from "../src/ai-native.ts";

const config = { PUBLIC_URL: "https://mail.example.com/" };

test("AI-native discovery exposes domain setup guides", () => {
  const openapi = buildOpenApi(config);
  assert.ok(openapi.paths["/ai/v1/domains/{id}/setup-guide"]);
  assert.ok(openapi.paths["/api/auth/channels"]);
  assert.ok(openapi.paths["/api/admin/login-channels"]);
  assert.ok(openapi.paths["/api/admin/login-channels/{id}/test"]);
  assert.equal(openapi.components.securitySchemes.cookieAuth.name, "tm_session");

  const manifest = buildSkillManifest(config);
  assert.equal(
    manifest.endpoints.domain_setup_guide,
    "https://mail.example.com/ai/v1/domains/{id}/setup-guide",
  );
  assert.equal(
    manifest.agent_instructions.some((line) => line.includes("Catch-all")),
    true,
  );
});
