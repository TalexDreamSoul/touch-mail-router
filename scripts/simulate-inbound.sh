#!/usr/bin/env bash
# 本地模拟 Worker → Server 推送（不依赖真实邮件）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRET="${WEBHOOK_SECRET:-change-me-to-a-long-random-secret}"
URL="${WEBHOOK_URL:-http://127.0.0.1:8788/v1/inbound}"
TENANT="${TENANT:-demo}"
CHANNEL="${CHANNEL:-default}"
TO="${TO:-${TENANT}+${CHANNEL}@inbound.example.com}"
FROM="${FROM:-sender@example.com}"
SUBJECT="${SUBJECT:-Hello from simulate-inbound}"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

MSG_ID="<sim-$(date +%s)@touch-mail-router.local>"
cat >"$TMP" <<EOF
From: ${FROM}
To: ${TO}
Subject: ${SUBJECT}
Message-ID: ${MSG_ID}
Date: $(date -R 2>/dev/null || date)
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8

这是一封模拟入站邮件。
tenant=${TENANT} channel=${CHANNEL}
EOF

TS="$(date +%s)"
# HMAC-SHA256(secret, timestamp + "." + body)
SIG="$(
  SECRET="$SECRET" TS="$TS" TMP="$TMP" python3 - <<'PY'
import hmac, hashlib, os
secret = os.environ["SECRET"]
ts = os.environ["TS"]
body = open(os.environ["TMP"], "rb").read()
mac = hmac.new(secret.encode(), ts.encode() + b"." + body, hashlib.sha256).hexdigest()
print(mac)
PY
)"

echo "POST ${URL}"
echo "tenant=${TENANT} channel=${CHANNEL} ts=${TS}"

curl -sS -D - -o /tmp/touch-mail-inbound-resp.json \
  -X POST "$URL" \
  -H "content-type: message/rfc822" \
  -H "x-timestamp: ${TS}" \
  -H "x-signature: sha256=${SIG}" \
  -H "x-email-from: ${FROM}" \
  -H "x-email-to: ${TO}" \
  -H "x-email-subject: ${SUBJECT}" \
  -H "x-message-id: ${MSG_ID}" \
  -H "x-tenant: ${TENANT}" \
  -H "x-channel: ${CHANNEL}" \
  --data-binary @"${TMP}"

echo
echo "--- body ---"
cat /tmp/touch-mail-inbound-resp.json
echo
