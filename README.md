# touch-mail-router

**Cloudflare Email Worker → 你的云端 HTTPS API** 的入站邮件网关 + **Next.js / Kumo 管理后台**。

面向「客户自有域名用邮箱转发接入」的长期方案：

```
发件人
  → 客户邮箱 support@customer.com
  → 客户设置自动转发
  → {tenant}@inbound.你的域   （或 tenant+channel@）
  → Cloudflare Email Routing
  → Email Worker（本仓库 worker/）
  → HTTPS POST /v1/inbound
  → 云端 API（本仓库 server/）
  → 落盘 / 审计日志 / 可选飞书通知配置
  → 管理后台（本仓库 admin/，Next.js + @cloudflare/kumo）
```

**不需要 25 端口。** 你的服务器只开 443。

---

## 仓库结构

```
touch-mail-router/
├── admin/                  # Next.js 15 + @cloudflare/kumo 管理后台
│   ├── src/app/            # 登录 / 概览 / 用户 / 域名 / 邮件 / 审计 / 飞书配置
│   └── Dockerfile
├── worker/                 # Cloudflare Email Worker
│   ├── src/index.ts
│   └── wrangler.toml
├── server/                 # 云端入站 API（Node + Hono）
│   ├── src/
│   ├── public/             # 旧版静态 SPA（仍挂在 API 上）
│   └── Dockerfile
├── docker-compose.yml      # mail-api (:8788) + mail-admin (:3000)
├── scripts/simulate-inbound.sh
└── README.md
```

---

## 管理后台功能

| 页面 | 说明 |
|------|------|
| `/login` | 注册 / 登录（Cookie Session） |
| `/dashboard` | 租户概览；管理员可见全站统计 |
| `/users` | **管理员** 用户 CRUD、角色、启用/禁用，搜索 + 分页 |
| `/domains` | 域名台账 CRUD，搜索 + 分页（管理员看全站） |
| `/mails` | 入站邮件列表，搜索 + 分页 |
| `/audit` | **管理员** 审计日志，搜索 + 分页 |
| `/settings/feishu` | **管理员** 飞书 SaaS 配置（App ID/Secret、加密、通知群、入站通知开关） |

首个注册用户自动成为 `admin`。

技术栈：Next.js App Router、`@cloudflare/kumo`、Phosphor Icons、Tailwind v4。

---

## 地址约定

| 地址 | 含义 |
|------|------|
| `acme@inbound.example.com` | 租户 `acme`，渠道 `default` |
| `acme+orders@inbound.example.com` | 租户 `acme`，渠道 `orders` |

客户文档一句话：

> 请把 `support@你的公司域名` **完整转发**到我们给你的地址：`xxx@inbound.example.com`

---

## 1. 本地开发

### API

```bash
cd server
cp .env.example .env
# 编辑 WEBHOOK_SECRET（≥16 位）
npm install
npm run dev
# → http://127.0.0.1:8788/health
```

### Admin（Next.js + Kumo）

```bash
cd admin
cp .env.example .env.local   # API_PROXY_TARGET=http://127.0.0.1:8788
npm install
npm run dev
# → http://127.0.0.1:3000
```

浏览器访问 Admin；`/api/*` 由 Next rewrite 代理到 API，Session Cookie 同源。

---

## 2. Docker 部署

```bash
export WEBHOOK_SECRET='your-long-random-secret'
export PUBLIC_URL='https://mail.wc1.tagzxia.com'
export INBOUND_DOMAIN='inbound.wc1.tagzxia.com'
docker compose up -d --build

curl -s http://127.0.0.1:8788/health
# Admin: http://127.0.0.1:3000  （生产请反代 HTTPS）
```

| 服务 | 端口 | 说明 |
|------|------|------|
| `mail-api` | `127.0.0.1:8788` | 入站 Webhook + REST API |
| `mail-admin` | `127.0.0.1:3000` | Next 管理后台 |

生产建议：

- OpenResty / Caddy / Nginx 将 `https://mail...` 反代到 Admin `:3000`
- 或 API 与 Admin 同域分路径（Admin rewrite `/api` → `mail-api:8788`）
- Worker 的 `WEBHOOK_SECRET` 与 API 一致

---

## 3. 主要 API

### 公共 / 租户

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/config` | 公开配置 |
| `POST` | `/api/auth/register` | 注册 |
| `POST` | `/api/auth/login` | 登录 |
| `POST` | `/api/auth/logout` | 登出 |
| `GET` | `/api/auth/me` | 当前用户 |
| `GET` | `/api/dashboard` | 概览 |
| `GET/POST` | `/api/domains` | 域名列表 / 添加（支持 `q,page,pageSize`） |
| `DELETE` | `/api/domains/:id` | 删除域名 |
| `GET` | `/api/mails` | 邮件列表（搜索分页） |
| `GET` | `/api/worker-snippet` | 生成 Worker 代码片段 |
| `POST` | `/v1/inbound` | Worker 推送入口（HMAC 验签） |

### 管理员

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/admin/overview` | 全站概览 |
| `GET/POST` | `/api/admin/users` | 用户列表 / 创建 |
| `PATCH/DELETE` | `/api/admin/users/:id` | 更新 / 删除用户 |
| `GET` | `/api/admin/domains` | 全站域名 |
| `GET` | `/api/admin/mails` | 全站邮件 |
| `GET` | `/api/admin/audit-logs` | 审计日志 |
| `GET/PUT` | `/api/admin/settings/feishu` | 飞书配置 |

#### 签名算法（Worker 与 Server 一致）

```
signature = hex( HMAC-SHA256( secret, timestamp + "." + rawBody ) )
Headers:
  x-timestamp: <unix seconds>
  x-signature: sha256=<signature>
  x-tenant: <tenant>
  x-channel: <channel>
```

时间窗默认 ±300 秒。

---

## 4. Cloudflare Worker

见 `worker/`：

```bash
cd worker
# 配置 wrangler.toml 与 WEBHOOK_SECRET
npx wrangler deploy
```

在 Cloudflare Dashboard 为入站域开启 Email Routing，绑定本 Worker。

---

## 5. 飞书 SaaS 配置

在后台 **飞书配置** 页填写：

- App ID / App Secret（企业自建应用）
- Encrypt Key / Verification Token（事件订阅）
- 通知群 Chat ID、入站通知开关
- OAuth Redirect URI（预留）

密钥字段保存时若为掩码 `••••` 则不覆盖原值。当前版本完成配置持久化与审计；实际飞书消息推送可在此配置基础上继续扩展。

---

## License

Private / personal use unless otherwise stated.
