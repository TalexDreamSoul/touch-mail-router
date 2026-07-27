export type User = {
  id: string;
  username: string;
  tenant: string;
  displayName: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  createdAt: string;
  updatedAt?: string;
};

export type LoginChannelType = "feishu" | "oidc";

export type LoginChannel = {
  id: string;
  name: string;
  type: LoginChannelType;
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  clientSecretSet: boolean;
  identityCount?: number;
  scopes: string[];
  subjectClaim: string;
  usernameClaim: string;
  displayNameClaim: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};

export type DomainVisibility = "public" | "private";
export type ReceiveChannelType = "worker" | "email_forward" | "donemail" | "api_push";
export type EmailForwardCollectorType = "webhook" | "donemail";

export type ReceiveChannelImpact = {
  userCount: number;
  domainCount: number;
  users: Array<{ id: string; username: string; tenant: string }>;
  domains: Array<{ id: string; domain: string; userId: string; username: string }>;
};

export type SetupGuideField = {
  name: string;
  value: string | number | boolean;
  kind?: "text" | "secret";
  copyable?: boolean;
};

export type DomainSetupGuide = {
  domainId: string;
  domain: string;
  channel: {
    id: string;
    name: string;
    type: ReceiveChannelType;
    collectorType?: EmailForwardCollectorType;
  };
  scope: "all" | "specific";
  testRecipient: string;
  agentPrompt: string;
  steps: Array<{
    id: string;
    title: string;
    warning?: string;
    fields?: SetupGuideField[];
    instructions?: string[];
    code?: { javascript: string; wranglerToml: string };
  }>;
};

export type ReceiveChannel = {
  id: string;
  name: string;
  description: string;
  type: ReceiveChannelType;
  collectorType: EmailForwardCollectorType | "";
  enabled: boolean;
  forwardingAddressTemplate: string;
  baseUrl: string;
  adminKey: string;
  pushToken: string;
  adminKeySet: boolean;
  pushTokenSet: boolean;
  pollIntervalSeconds: number;
  lastSyncAt: string | null;
  lastSyncError: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};

export type Domain = {
  id: string;
  userId: string;
  domain: string;
  note: string;
  visibility: DomainVisibility;
  receiveChannelId: string | null;
  workerName: string;
  createdAt: string;
  username?: string;
  tenant?: string;
};

export type ApiKeyScope = "read" | "write";

export type UserApiKey = {
  id: string;
  name: string;
  scopes: ApiKeyScope[];
  status: "active" | "revoked";
  keyPreview: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type CreatedUserApiKey = {
  id: string;
  name: string;
  key: string;
  scopes: ApiKeyScope[];
  status: "active";
  createdAt: string;
};

export type ApiCallLog = {
  id: string;
  userId: string;
  apiKeyId: string | null;
  apiKeyName: string | null;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ip?: string;
  userAgent?: string;
  error?: string;
  createdAt: string;
};

export type ApiDocsInfo = {
  openapiUrl: string;
  skillUrl: string;
  docsUrl: string;
  baseUrl: string;
  auth: string;
  scopes: Record<string, string>;
  endpoints: Record<string, string>;
  duckmail: Record<string, string>;
};

export type MailMeta = {
  id: string;
  tenant: string;
  channel: string;
  from: string;
  to: string;
  subject: string;
  messageId: string;
  receivedAt: string;
  size: number;
  hasAttachments: boolean;
  attachmentCount: number;
  textPreview: string;
};

export type AuditLog = {
  id: string;
  actorId: string | null;
  actorUsername: string | null;
  action: string;
  resource: string;
  resourceId?: string;
  detail?: string;
  ip?: string;
  createdAt: string;
};

export type FeishuSettings = {
  enabled: boolean;
  appId: string;
  appSecret: string;
  encryptKey: string;
  verificationToken: string;
  notifyChatId: string;
  notifyOnInbound: boolean;
  oauthRedirectUri: string;
  updatedAt: string | null;
  updatedBy: string | null;
  appSecretSet?: boolean;
  encryptKeySet?: boolean;
  verificationTokenSet?: boolean;
};

export type SmtpSettings = {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
  replyTo: string;
  updatedAt: string | null;
  updatedBy: string | null;
  passwordSet?: boolean;
};

export type SmtpStatus = {
  enabled: boolean;
  fromAddress: string;
  fromName: string;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type WorkerSnippet = {
  domainId: string;
  domain: string;
  workerName: string;
  webhookUrl: string;
  webhookSecret: string;
  js: string;
  wranglerToml: string;
  setupSteps: string[];
  routeSteps: string[];
};

export type FeishuChat = {
  chatId: string;
  name: string;
  description: string;
  avatar: string;
};

export type FeishuTestFailureDetails = {
  kind: "validation" | "remote" | "network" | "timeout";
  phase: string;
  endpoint?: string;
  method?: string;
  request?: unknown;
  secretSource?: "current_input" | "saved" | "missing";
  upstreamStatus?: number;
  feishuCode?: number | string;
  responseHeaders?: Record<string, string>;
  response?: unknown;
  suggestion?: string;
  durationMs?: number;
  occurredAt?: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly data: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Browsers surface network/CORS/proxy failures as "Failed to fetch"
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      throw new Error(
        "无法连接 API（检查 admin 代理与 server 是否在运行：默认 http://127.0.0.1:8789）",
      );
    }
    throw err instanceof Error ? err : new Error(msg);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      typeof data.error === "string" ? data.error : `请求失败 ${res.status}`,
      res.status,
      data,
    );
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: User | null }>("/api/auth/me"),
  login: (username: string, password: string) =>
    request<{ ok: boolean; user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  register: (username: string, password: string, displayName?: string) =>
    request<{ ok: boolean; user: User }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password, displayName }),
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  loginChannels: () =>
    request<{ items: Array<Pick<LoginChannel, "id" | "name" | "type">> }>(
      "/api/auth/channels",
    ),
  config: () =>
    request<{ appName: string; publicUrl: string; inboundDomain: string }>("/api/config"),
  dashboard: () => request<Record<string, unknown>>("/api/dashboard"),
  domains: (params: URLSearchParams) =>
    request<PageResult<Domain>>(`/api/domains?${params}`),
  createDomain: (
    domain: string,
    note: string,
    visibility: DomainVisibility,
    receiveChannelId: string,
    workerName: string,
  ) =>
    request<{ ok: boolean; domain: Domain }>("/api/domains", {
      method: "POST",
      body: JSON.stringify({ domain, note, visibility, receiveChannelId, workerName }),
    }),
  updateDomain: (
    id: string,
    body: Partial<{
      note: string;
      visibility: DomainVisibility;
      receiveChannelId: string;
      workerName: string;
    }>,
  ) =>
    request<{ ok: boolean; domain: Domain }>(`/api/domains/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteDomain: (id: string) =>
    request<{ ok: boolean }>(`/api/domains/${id}`, { method: "DELETE" }),
  mails: (params: URLSearchParams) =>
    request<PageResult<MailMeta>>(`/api/mails?${params}`),
  receiveChannels: () => request<{ items: ReceiveChannel[] }>("/api/receive-channels"),
  workerSnippet: (domainId: string) =>
    request<WorkerSnippet>(`/api/domains/${domainId}/worker-snippet`),
  domainSetupGuide: (domainId: string, scope: "all" | "specific", address = "") => {
    const params = new URLSearchParams({ scope });
    if (address) params.set("address", address);
    return request<DomainSetupGuide>(`/api/domains/${domainId}/setup-guide?${params}`);
  },
  smtpStatus: () => request<SmtpStatus>("/api/smtp/status"),
  sendMail: (body: { to: string; subject: string; text: string; html?: string }) =>
    request<{ ok: boolean; messageId: string; accepted: string[]; rejected: string[] }>(
      "/api/outbound",
      { method: "POST", body: JSON.stringify(body) },
    ),
  sendDomainTest: (domainId: string, recipient: string) =>
    request<{ ok: boolean; token: string; recipient: string; messageId: string }>(
      `/api/domains/${domainId}/test`,
      { method: "POST", body: JSON.stringify({ recipient }) },
    ),
  domainTestStatus: (domainId: string, token: string) =>
    request<{ received: boolean; mail: MailMeta | null }>(
      `/api/domains/${domainId}/test/${token}`,
    ),

  listApiKeys: () => request<{ items: UserApiKey[] }>("/api/me/api-keys"),
  createApiKey: (name?: string, scopes: ApiKeyScope[] = ["read", "write"]) =>
    request<{ ok: boolean; key: CreatedUserApiKey }>("/api/me/api-keys", {
      method: "POST",
      body: JSON.stringify({ name, scopes }),
    }),
  updateApiKey: (
    id: string,
    body: Partial<{ name: string; scopes: ApiKeyScope[]; status: "active" | "revoked" }>,
  ) =>
    request<{ ok: boolean; key: UserApiKey }>(`/api/me/api-keys/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteApiKey: (id: string) =>
    request<{ ok: boolean }>(`/api/me/api-keys/${id}`, { method: "DELETE" }),
  apiHistory: (params: URLSearchParams) =>
    request<PageResult<ApiCallLog>>(`/api/me/api-history?${params}`),
  apiDocs: () => request<ApiDocsInfo>("/api/me/api-docs"),

  adminOverview: () => request<Record<string, unknown>>("/api/admin/overview"),
  adminUsers: (params: URLSearchParams) =>
    request<PageResult<User>>(`/api/admin/users?${params}`),
  createUser: (body: {
    username: string;
    password: string;
    displayName?: string;
    role?: string;
  }) =>
    request<{ ok: boolean; user: User }>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateUser: (
    id: string,
    body: Partial<{
      displayName: string;
      role: string;
      status: string;
      password: string;
    }>,
  ) =>
    request<{ ok: boolean; user: User }>(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteUser: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${id}`, { method: "DELETE" }),
  adminDomains: (params: URLSearchParams) =>
    request<PageResult<Domain>>(`/api/admin/domains?${params}`),
  adminDeleteDomain: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/domains/${id}`, { method: "DELETE" }),
  adminMails: (params: URLSearchParams) =>
    request<PageResult<MailMeta>>(`/api/admin/mails?${params}`),
  auditLogs: (params: URLSearchParams) =>
    request<PageResult<AuditLog>>(`/api/admin/audit-logs?${params}`),
  adminLoginChannels: () =>
    request<{
      items: LoginChannel[];
      callbackUrl: string;
      feishuReady: boolean;
      feishuChannelExists: boolean;
    }>("/api/admin/login-channels"),
  addFeishuLoginChannel: () =>
    request<{ ok: boolean; channel: LoginChannel }>("/api/admin/login-channels/feishu", {
      method: "POST",
    }),
  createLoginChannel: (body: {
    name: string;
    enabled: boolean;
    issuer: string;
    clientId: string;
    clientSecret: string;
    scopes: string[];
    subjectClaim: string;
    usernameClaim: string;
    displayNameClaim: string;
  }) =>
    request<{ ok: boolean; channel: LoginChannel }>("/api/admin/login-channels", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateLoginChannel: (id: string, body: Partial<LoginChannel>) =>
    request<{ ok: boolean; channel: LoginChannel }>(`/api/admin/login-channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  testLoginChannel: (id: string) =>
    request<{ ok: boolean; authorizationUrl: string; callbackUrl: string }>(
      `/api/admin/login-channels/${id}/test`,
      { method: "POST" },
    ),
  deleteLoginChannel: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/login-channels/${id}`, { method: "DELETE" }),
  adminReceiveChannels: () =>
    request<{ items: ReceiveChannel[] }>("/api/admin/receive-channels"),
  createReceiveChannel: (body: {
    name: string;
    description?: string;
    type: ReceiveChannelType;
    collectorType?: EmailForwardCollectorType;
    enabled: boolean;
    forwardingAddressTemplate?: string;
    baseUrl?: string;
    adminKey?: string;
    pushToken?: string;
    pollIntervalSeconds?: number;
  }) =>
    request<{ ok: boolean; channel: ReceiveChannel; pushToken?: string }>(
      "/api/admin/receive-channels",
      { method: "POST", body: JSON.stringify(body) },
    ),
  receiveChannelImpact: (id: string) =>
    request<{ impact: ReceiveChannelImpact }>(`/api/admin/receive-channels/${id}/impact`),
  receiveChannelSetupGuide: (id: string) =>
    request<Record<string, unknown>>(`/api/admin/receive-channels/${id}/setup-guide`),
  updateReceiveChannel: (
    id: string,
    body: Partial<ReceiveChannel> & { confirmImpact?: boolean },
  ) =>
    request<{ ok: boolean; channel: ReceiveChannel; pushToken?: string }>(`/api/admin/receive-channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  rotateReceiveChannelToken: (id: string, confirmImpact = false) =>
    request<{
      ok: boolean;
      channelId: string;
      pushToken: string;
      impact: ReceiveChannelImpact;
    }>(`/api/admin/receive-channels/${id}/token/rotate`, {
      method: "POST",
      body: JSON.stringify({ confirmImpact }),
    }),
  deleteReceiveChannel: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/receive-channels/${id}`, { method: "DELETE" }),
  testReceiveChannel: (id: string) =>
    request<{ ok: boolean; result: Record<string, unknown> }>(
      `/api/admin/receive-channels/${id}/test`,
      { method: "POST" },
    ),
  syncReceiveChannel: (id: string) =>
    request<{
      ok: boolean;
      result: { imported: number; duplicates: number; skipped: number };
    }>(`/api/admin/receive-channels/${id}/sync`, { method: "POST" }),
  smtpSettings: () =>
    request<{ settings: SmtpSettings }>("/api/admin/settings/smtp"),
  saveSmtpSettings: (body: Partial<SmtpSettings>) =>
    request<{ ok: boolean; settings: SmtpSettings }>("/api/admin/settings/smtp", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  testSmtpSettings: (body: Partial<SmtpSettings>) =>
    request<{ ok: boolean }>("/api/admin/settings/smtp/test", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  feishuSettings: () =>
    request<{ settings: FeishuSettings }>("/api/admin/settings/feishu"),
  saveFeishuSettings: (body: Partial<FeishuSettings>) =>
    request<{ ok: boolean; settings: FeishuSettings }>("/api/admin/settings/feishu", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  testFeishuSettings: (body: Pick<FeishuSettings, "appId" | "appSecret" | "notifyChatId">) =>
    request<{ ok: boolean; messageSent: boolean }>("/api/admin/settings/feishu/test", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listFeishuChats: (body: Pick<FeishuSettings, "appId" | "appSecret">) =>
    request<{ ok: boolean; items: FeishuChat[] }>("/api/admin/settings/feishu/chats", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export function qs(obj: Record<string, string | number | undefined | null>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, String(v));
  }
  return p;
}

export function formatDate(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}
