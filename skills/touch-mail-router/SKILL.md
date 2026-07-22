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
| `GET /ai/v1/docs` | Short docs envelope |

## Primary endpoints (Bearer required)

```text
GET  /ai/v1/me
GET  /ai/v1/inbound
GET  /ai/v1/domains?q=&page=&pageSize=
POST /ai/v1/domains          # write — body: { domain, note?, visibility? }
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
Customer mailbox
  → forward to {tenant}@{INBOUND_DOMAIN}
  → Cloudflare Email Routing + Worker
  → POST /v1/inbound (HMAC)
  → API storage
  → Admin / AI list mails
```

Registering a domain in the API is a **ledger** only. Mail still needs forward + Worker.

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
