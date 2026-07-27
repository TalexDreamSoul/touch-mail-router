# touch-mail-router

**多收件渠道邮件网关 + SMTP 发信 + Next.js / Kumo 管理后台**。

管理员先发布收件渠道，用户绑定域名时只能从已启用渠道中选择：

```
Cloudflare Email Routing → Send to a Worker → POST /v1/inbound
业务邮箱 → 转发到管理员地址模板 → 系统入站 Worker → POST /v1/inbound
DoneMail → Touch Mail 定时 GET /api/mails → 去重入库
上游系统 → POST /v1/inbound/json/:channelId → 去重入库
```

出站邮件统一使用管理员 SMTP 配置；域名接入向导会自动发送测试邮件并等待它从所选渠道回到系统。

**不需要开放 25 端口。** API 与管理后台只需 HTTPS；SMTP 使用管理员配置的外部服务。

---

## 仓库结构

```
touch-mail-router/
├── admin/                  # Next.js 15 + @cloudflare/kumo 管理后台
│   ├── src/app/            # 登录 / 域名 / 收发邮件 / 用户 / 审计 / 收件渠道 / SMTP / 飞书
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
| `/domains` | 域名绑定、收件渠道选择、Worker/转发/API 指引、SMTP 自动接入测试 |
| `/mails` | 入站邮件列表，搜索 + 分页 |
| `/send` | **管理员**使用统一 SMTP 配置发送邮件 |
| `/audit` | **管理员** 审计日志，搜索 + 分页 |
| `/settings/receivers` | **管理员** Worker、邮箱转发、DoneMail、API 上报渠道管理 |
| `/settings/smtp` | **管理员** SMTP 连接、发件身份、启用状态与连接测试 |
| `/settings/feishu` | **管理员** 飞书 SaaS 配置 |

首个注册用户自动成为 `admin`。

技术栈：Next.js App Router、`@cloudflare/kumo`、Phosphor Icons、Tailwind v4。

---

## 接入约定

- **Worker 直连**：客户域 Cloudflare Email Routing 的动作选择 `Send to a Worker`，不需要邮箱转发。系统生成 Worker Name、代码、独立 Secret 和路由规则教程；Worker Name 必须在代码、Wrangler 与路由规则三处一致。
- **邮箱转发**：管理员配置包含 `{tenant}` 的目标模板，例如 `{tenant}@inbound.example.com`；创建渠道时系统生成独立渠道 ID 与签名 Token，中央 Worker 使用二者签名入站请求。用户只看到渲染后的具体转发地址。
- **DoneMail**：管理员配置站点 Base URL 与 `X-Admin-Key`，系统调用 `GET /api/mails`，按收件域名匹配用户并持久化。
- **API 上报**：上游使用渠道 Token 调用 JSON 入站接口。

一个域名同一时间绑定一个收件渠道，避免多通道重复入库。升级前创建的未绑定域名会保持未绑定状态，管理员需要在域名页显式选择新渠道；旧版全局 Worker Secret 不再接受。

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
- 每域直连 Worker 使用域名向导生成的独立 `WEBHOOK_SECRET`；邮箱转发 Worker 使用收件渠道生成的独立 Token，不再接受旧版全局 Secret

---

## 3. 主要 API

### DuckMail 兼容 API（对外主接口）

对齐 [DuckMail API](https://www.duckmail.sbs/zh/api-docs) / [llm-api-docs](https://raw.githubusercontent.com/MoonWeSif/DuckMail/main/public/llm-api-docs.txt)，可直接替换 `https://api.duckmail.sbs` 为你的 `PUBLIC_URL`。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/domains` | 可用域名列表（Hydra）；`Authorization: Bearer dk_xxx` 时含私有域名 |
| `POST` | `/accounts` | 创建邮箱账户 `{ address, password, expiresIn? }` |
| `POST` | `/token` | 用 address+password 换 Bearer Token |
| `GET` | `/me` | 当前账户信息 |
| `DELETE` | `/accounts/{id}` | 删除当前登录账户 |
| `GET` | `/messages` | 收件箱列表（`page`，每页 30，Hydra） |
| `GET` | `/messages/{id}` | 邮件详情（含 text/html/attachments） |
| `PATCH` | `/messages/{id}` | 标记已读 → `{ seen: true }` |
| `DELETE` | `/messages/{id}` | 删除邮件 → `204` |
| `GET` | `/sources/{id}` | 原始 RFC822 |

认证：`Authorization: Bearer <token>`；私有域名可选 `dk_` 开头 API Key（环境变量 `API_KEYS`）。

错误格式：`{ "error": "Conflict", "message": "..." }`，状态码含 400/401/403/404/409/422。

也可挂在前缀 `/dm/*`（如 `/dm/messages`），便于与后台同域分流。

快速示例：

```bash
# 1. 创建账户
curl -X POST "$PUBLIC_URL/accounts" -H 'Content-Type: application/json' \
  -d '{"address":"test@inbound.example.com","password":"mypassword","expiresIn":0}'

# 2. 取 Token
curl -X POST "$PUBLIC_URL/token" -H 'Content-Type: application/json' \
  -d '{"address":"test@inbound.example.com","password":"mypassword"}'

# 3. 读邮件
curl "$PUBLIC_URL/messages" -H "Authorization: Bearer <token>"
```

创建账户时 `address` 的 local-part 会作为入站 `tenant`，Worker 推送到 `{local}@INBOUND_DOMAIN` 即可进该邮箱。

### 管理后台 API（内部）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/api/config` | 公开配置 |
| `POST` | `/api/auth/register` | 注册 |
| `POST` | `/api/auth/login` | 登录 |
| `GET/POST/PATCH/DELETE` | `/api/domains*` | 域名与收件渠道绑定 |
| `GET` | `/api/receive-channels` | 当前用户可选的已启用渠道 |
| `GET` | `/api/domains/:id/worker-snippet` | 每域 Worker Name、代码与 Secret（兼容接口） |
| `GET` | `/api/domains/:id/setup-guide?scope=all\|specific&address=` | 按渠道与收件范围生成结构化分步接入向导 |
| `POST` | `/api/domains/:id/test` | SMTP 发送域名接入测试邮件 |
| `GET` | `/api/domains/:id/test/:token` | 查询测试邮件是否入站 |
| `GET` | `/api/mails` | 当前租户邮件列表 |
| `GET` | `/api/smtp/status` | SMTP 可用状态与发件身份 |
| `POST` | `/api/outbound` | **管理员**使用 SMTP 配置发信 |
| `POST` | `/v1/inbound` | Worker RFC822 入站（HMAC） |
| `POST` | `/v1/inbound/json/:channelId` | API 渠道 JSON 入站（Bearer Token） |

### 管理员

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/POST` | `/api/admin/receive-channels` | 收件渠道列表 / 创建 |
| `GET` | `/api/admin/receive-channels/:id/impact` | 修改前查询受影响用户和域名 |
| `GET` | `/api/admin/receive-channels/:id/setup-guide` | 管理员部署与收集方式配置文档 |
| `PATCH/DELETE` | `/api/admin/receive-channels/:id` | 修改需 `confirmImpact: true` 二次确认；已绑定渠道禁止删除 |
| `POST` | `/api/admin/receive-channels/:id/token/rotate` | 二次确认后轮换 Webhook / API Token，仅返回一次 |
| `POST` | `/api/admin/receive-channels/:id/test` | 渠道连接测试 |
| `POST` | `/api/admin/receive-channels/:id/sync` | 立即同步 DoneMail |
| `GET/PUT` | `/api/admin/settings/smtp` | SMTP 配置 |
| `POST` | `/api/admin/settings/smtp/test` | SMTP 连接测试 |
| `GET` | `/api/admin/overview` | 全站概览 |
| `GET/POST/PATCH/DELETE` | `/api/admin/users*` | 用户管理 |
| `GET/DELETE` | `/api/admin/domains*` | 全站域名管理 |
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

仓库 `worker/` 提供管理员自建 Worker；域名向导还会为用户绑定的单个域名生成可复制代码与 `wrangler.toml`。

邮箱转发是组合渠道：

```text
业务邮箱 → 转发目标地址 → DoneMail API 定时拉取 / 接收 Worker Webhook 推送 → Touch Mail
```

- `DoneMail API` 收集：配置 Base URL、`X-Admin-Key` 和同步间隔，不生成 Webhook Token。
- `Webhook` 收集：管理员部署共享接收 Worker，并配置 `RECEIVE_CHANNEL_ID`、`WEBHOOK_SECRET`；域名用户和邮箱服务商只使用转发目标地址，不接触这两个凭据。
- 匹配整个域名时，Cloudflare 的 `Custom address` 不填 `*` 或 `*@domain`，而是在 Routing rules 中编辑 `Catch-all address`。

```bash
cd worker
# 配置 WEBHOOK_URL / EMAIL_DOMAIN；邮箱转发 Worker 还需 RECEIVE_CHANNEL_ID
# WEBHOOK_SECRET 使用域名向导或收件渠道提供的独立 Token
npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy
```

客户域直连时，在 Cloudflare Dashboard 打开 **Email Routing → Routing rules**：

1. 创建 Custom address，或启用 Catch-all；
2. Action 选择 **Send to a Worker**，不是 **Forward to an email**；
3. 选择与域名向导显示完全一致的 Worker Name；
4. 保存后使用向导的 SMTP 自动测试验证整条链路。

## 5. SMTP 发信

管理员在 `/settings/smtp` 配置 Host、Port、TLS、认证信息和发件身份。端口 `465` 通常使用隐式 TLS；`587` 通常使用 STARTTLS。仅管理员可在 `/send` 任意发信；普通用户只能通过域名向导向自己绑定的域名发送接入测试邮件。

## 6. 飞书 SaaS 配置

在后台 **飞书配置** 页填写 App ID / Secret、事件订阅字段、通知群与 OAuth Redirect URI。密钥字段保存时若为掩码 `••••` 则不覆盖原值；启用“入站邮件通知”后，Worker、API Push 和 DoneMail 新邮件会异步推送到所选群，推送失败不影响邮件入库。

---

## License

Private / personal use unless otherwise stated.
