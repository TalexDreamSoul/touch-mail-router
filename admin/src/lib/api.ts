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

export type Domain = {
  id: string;
  userId: string;
  domain: string;
  note: string;
  createdAt: string;
  username?: string;
  tenant?: string;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
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
  createDomain: (domain: string, note?: string) =>
    request<{ ok: boolean; domain: Domain }>("/api/domains", {
      method: "POST",
      body: JSON.stringify({ domain, note }),
    }),
  deleteDomain: (id: string) =>
    request<{ ok: boolean }>(`/api/domains/${id}`, { method: "DELETE" }),
  mails: (params: URLSearchParams) =>
    request<PageResult<MailMeta>>(`/api/mails?${params}`),
  workerSnippet: () => request<Record<string, unknown>>("/api/worker-snippet"),

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
