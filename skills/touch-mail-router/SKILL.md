---
name: touch-mail-router
description: >
  AI-native skill for Touch Mail Router — inbound email gateway (Cloudflare Email
  Worker → HTTPS API). Use when agents need to list/create domains, list inbound
  mails, inspect inbound addresses, manage DuckMail-compatible temp mailboxes,
  or read personal API call history. Prefer /ai/v1/* structured JSON endpoints.
---

# Touch Mail Router (AI-native)

## Auth

```http
Authorization: Bearer dk_<hex>
```

Create keys in Admin → **个人 → API Keys**. Scopes:

| Scope | Allows |
|-------|--------|
| `read` | GET me, domains, mails, inbound, history |
| `write` | POST/PATCH/DELETE (e.g. create domain) |

## Discovery (no auth)

| URL | Purpose |
|-----|---------|
| `GET /ai/v1/skill` | This skill as JSON (base URL + examples) |
| `GET /ai/v1/openapi.json` | OpenAPI 3.1 |
| `GET /ai/v1/docs` | Short docs envelope + `agentPrompt` |
| `GET /ai/v1/automation-prompt` | No-root Cloudflare/DNS/Worker automation prompt |

## Primary endpoints (Bearer required)

```text
GET  /ai/v1/me
GET  /ai/v1/automation-prompt
GET  /ai/v1/inbound
GET  /ai/v1/domains?q=&page=&pageSize=
POST /ai/v1/domains          # write — body: { domain, note?, visibility? }
GET  /ai/v1/domains/:id/setup-guide?scope=all|specific&address=  # exact interactive steps
GET  /ai/v1/mails?q=&page=&pageSize=
GET  /ai/v1/mails/:id
GET  /ai/v1/history?q=&page=&pageSize=
```

Envelope:

```json
{ "ok": true, "...": "payload" }
{ "ok": false, "error": { "message": "...", "code": "..." } }
```

## Mental model

```text
Customer domain
  ├─ direct Worker: Cloudflare Email Routing → per-domain Worker
  └─ email forwarding: business mailbox → forwarding target
       ├─ DoneMail API polling
       └─ signed shared Worker Webhook
  → Touch Mail storage
  → Admin / AI list mails
```

Registering a domain in the API is a **ledger** only. Call `GET /ai/v1/domains/:id/setup-guide` to obtain the channel-specific steps, exact values, and `guide.agentPrompt`. For `scope=all`, never type `*` in Cloudflare Custom address; edit **Catch-all address** instead. Email forwarding users never receive administrator collector credentials.

## AI automation contract

When the user delegates setup to an AI agent:

1. Load `/ai/v1/automation-prompt`, then the domain setup guide. Treat returned values as authoritative.
2. Prefer an already-authorized Cloudflare MCP/API. Use `npx wrangler` for Worker deployment and secrets without global installation, `sudo`, or root.
3. Read and snapshot Zone, DNS, Email Routing, Workers, and Rules before any mutation.
4. Let Cloudflare's current Email Routing API/MCP generate or validate MX/TXT records; never invent MX records from memory.
5. Preserve unrelated DNS. Ask for explicit approval before replacing MX, deleting Rules/Workers, or expanding to Catch-all.
6. For Catch-all, edit **Catch-all address** and choose **Send to a Worker**. For a specific address, Custom address contains only the local-part.
7. Never print or persist `WEBHOOK_SECRET` or Cloudflare tokens. Use secret APIs or `npx wrangler secret put`.
8. Read back every changed resource and run the Touch Mail end-to-end domain test before claiming completion.
9. Report changed resource IDs, verification evidence, remaining work, and rollback steps.

## DuckMail-compatible (optional)

Same host, classic paths (also accept `dk_` for private domains):

- `GET /domains`
- `POST /accounts`
- `POST /token`
- `GET /messages`

## Agent checklist

1. Load `GET /ai/v1/skill` or OpenAPI if unsure of base URL.
2. Call with the user's personal `dk_` key (never invent keys).
3. Use `read` for inspection; request `write` only when mutating.
4. After calls, user can audit via Admin **API Keys → 调用历史** or `GET /ai/v1/history`.
