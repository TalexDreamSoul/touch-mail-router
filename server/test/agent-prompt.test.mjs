import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDomainAutomationPrompt,
  buildGeneralAutomationPrompt,
} from "../src/agent-prompt.ts";
import { buildOpenApi, buildSkillManifest } from "../src/ai-native.ts";

const config = { PUBLIC_URL: "https://mail.example.com/" };

test("AI discovery responses include the no-root automation prompt", () => {
  const prompt = buildGeneralAutomationPrompt("https://mail.example.com");
  assert.match(prompt, /npx wrangler/);
  assert.match(prompt, /sudo|root/i);
  assert.match(prompt, /DNS/);
  assert.match(prompt, /Email Routing/);
  assert.match(prompt, /ask.*approval|明确确认/i);

  const manifest = buildSkillManifest(config);
  assert.equal(manifest.agent_prompt, prompt);
  assert.equal(manifest.endpoints.automation_prompt, "https://mail.example.com/ai/v1/automation-prompt");

  const openapi = buildOpenApi(config);
  assert.equal(openapi.info["x-agent-prompt"], prompt);
  assert.ok(openapi.paths["/ai/v1/automation-prompt"]);
});

test("domain automation prompt gives exact Worker catch-all instructions", () => {
  const prompt = buildDomainAutomationPrompt({
    baseUrl: "https://mail.example.com",
    domainId: "d_123",
    domain: "customer.example.com",
    channelType: "worker",
    channelName: "Cloudflare Worker",
    scope: "all",
    workerName: "touch-mail-customer-example-com",
  });
  assert.match(prompt, /customer\.example\.com/);
  assert.match(prompt, /touch-mail-customer-example-com/);
  assert.match(prompt, /Catch-all address/);
  assert.match(prompt, /不要.*Custom address.*\*/s);
  assert.match(prompt, /Send to a Worker/);
  assert.match(prompt, /\/ai\/v1\/domains\/d_123\/setup-guide/);
});

test("domain automation prompt distinguishes a specific address and email forwarding", () => {
  const workerPrompt = buildDomainAutomationPrompt({
    baseUrl: "https://mail.example.com",
    domainId: "d_456",
    domain: "customer.example.com",
    channelType: "worker",
    channelName: "Cloudflare Worker",
    scope: "specific",
    address: "support@customer.example.com",
    workerName: "touch-mail-specific",
  });
  assert.match(workerPrompt, /Custom address 只填写 `support`/);

  const forwardingPrompt = buildDomainAutomationPrompt({
    baseUrl: "https://mail.example.com",
    domainId: "d_789",
    domain: "forward.example.com",
    channelType: "email_forward",
    channelName: "Forward via DoneMail",
    collectorType: "donemail",
    scope: "all",
    forwardingTarget: "tenant@inbound.example.com",
  });
  assert.match(forwardingPrompt, /不要部署每域 Worker/);
  assert.match(forwardingPrompt, /tenant@inbound\.example\.com/);
  assert.match(forwardingPrompt, /DoneMail API/);
});
