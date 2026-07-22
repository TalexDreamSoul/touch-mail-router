#!/usr/bin/env bash
# Create / update 1Panel openresty site proxy for Touch Mail
set -euo pipefail

DOMAIN="${1:-mail.wc1.tagzxia.com}"
UPSTREAM="${2:-http://127.0.0.1:8788}"
SITE_ROOT="/opt/1panel/www/sites/${DOMAIN}"
OPENRESTY_CONF_DIR="/opt/1panel/apps/openresty"

mkdir -p "${SITE_ROOT}/proxy" "${SITE_ROOT}/log" "${SITE_ROOT}/ssl" "${SITE_ROOT}/index" "${SITE_ROOT}/auth_basic"

cat > "${SITE_ROOT}/proxy/root.conf" <<EOF
location ^~ / {
    proxy_pass ${UPSTREAM};
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header REMOTE-HOST \$remote_addr;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$http_connection;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Port \$server_port;
    proxy_http_version 1.1;
    client_max_body_size 20m;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    add_header Strict-Transport-Security "max-age=31536000";
}
EOF

# If openresty conf already managed by 1Panel, try to detect conf root
echo "Wrote ${SITE_ROOT}/proxy/root.conf"
echo "If site is not yet registered in 1Panel, create website ${DOMAIN} as reverse proxy to ${UPSTREAM}."
echo "Then issue SSL cert for ${DOMAIN}."
