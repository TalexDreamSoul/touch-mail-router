export type User = {
  id: string;
  username: string;
  tenant: string;
  displayName: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  createdAt: string;
  updatedAt?: string;
  inboundAddress: string;
};

export type DomainVisibility = "public" | "private";

export type Domain = {
  id: string;
  userId: string;
  domain: string;
  note: string;
  visibility: DomainVisibility;
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

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type WorkerSnippet = {
  tenant: string;
  inboundAddress: string;
  webhookUrl: string;
  js: string;
  wranglerToml: string;
  setupSteps: string[];
};

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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `请求失败 ${res.status}`);
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
  config: () =>
    request<{ appName: string; publicUrl: string; inboundDomain: string }>("/api/config"),
  dashboard: () => request<Record<string, unknown>>("/api/dashboard"),
  domains: (params: URLSearchParams) =>
    request<PageResult<Domain>>(`/api/domains?${params}`),
  createDomain: (
    domain: string,
    note?: string,
    visibility: DomainVisibility = "private",
  ) =>
    request<{ ok: boolean; domain: Domain }>("/api/domains", {
      method: "POST",
      body: JSON.stringify({ domain, note, visibility }),
    }),
  updateDomain: (
    id: string,
    body: Partial<{ note: string; visibility: DomainVisibility }>,
  ) =>
    request<{ ok: boolean; domain: Domain }>(`/api/domains/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteDomain: (id: string) =>
    request<{ ok: boolean }>(`/api/domains/${id}`, { method: "DELETE" }),
  mails: (params: URLSearchParams) =>
    request<PageResult<MailMeta>>(`/api/mails?${params}`),
  workerSnippet: () => request<WorkerSnippet>("/api/worker-snippet"),

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
  feishuSettings: () =>
    request<{ settings: FeishuSettings }>("/api/admin/settings/feishu"),
  saveFeishuSettings: (body: Partial<FeishuSettings>) =>
    request<{ ok: boolean; settings: FeishuSettings }>("/api/admin/settings/feishu", {
      method: "PUT",
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
