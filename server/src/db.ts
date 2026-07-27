import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, appendFile, unlink } from "node:fs/promises";
import path from "node:path";

export type UserRole = "admin" | "user";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  tenant: string;
  displayName: string;
  role: UserRole;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export type DomainVisibility = "public" | "private";

export type ReceiveChannelType = "worker" | "email_forward" | "donemail" | "api_push";
export type EmailForwardCollectorType = "webhook" | "donemail";

export interface ReceiveChannel {
  id: string;
  name: string;
  description: string;
  type: ReceiveChannelType;
  /** Collection backend used after an email has been forwarded. Empty for non-forward channels. */
  collectorType: EmailForwardCollectorType | "";
  enabled: boolean;
  forwardingAddressTemplate: string;
  baseUrl: string;
  adminKey: string;
  pushToken: string;
  pollIntervalSeconds: number;
  lastSyncAt: string | null;
  lastSyncError: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export type PublicReceiveChannel = Omit<ReceiveChannel, "adminKey" | "pushToken"> & {
  adminKey: string;
  pushToken: string;
  adminKeySet: boolean;
  pushTokenSet: boolean;
};

export interface Domain {
  id: string;
  userId: string;
  domain: string;
  note: string;
  /** public: listed on DuckMail /domains without key; private: needs owner's API key */
  visibility: DomainVisibility;
  receiveChannelId: string | null;
  workerName: string;
  createdAt: string;
}

/** API key permission scopes */
export type ApiKeyScope = "read" | "write";

/** Per-user DuckMail-style API key (dk_…) for private domain + AI-native access */
export interface UserApiKey {
  id: string;
  userId: string;
  /** full key, shown once on create; stored for verification */
  key: string;
  name: string;
  /** read: list/query; write: create/mutate */
  scopes: ApiKeyScope[];
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
}

/** Personal API call history (AI-native / DuckMail / personal keys) */
export interface ApiCallLog {
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
}

export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export type LoginChannelType = "feishu" | "oidc";

export interface LoginChannel {
  id: string;
  name: string;
  type: LoginChannelType;
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  subjectClaim: string;
  usernameClaim: string;
  displayNameClaim: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export type PublicLoginChannel = Omit<LoginChannel, "clientSecret"> & {
  clientSecret: string;
  clientSecretSet: boolean;
};

export interface AuthIdentity {
  id: string;
  channelId: string;
  subject: string;
  userId: string;
  createdAt: string;
  lastLoginAt: string;
}

export interface MailMeta {
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
  rawPath: string;
  jsonPath: string;
}

export interface AuditLog {
  id: string;
  actorId: string | null;
  actorUsername: string | null;
  action: string;
  resource: string;
  resourceId?: string;
  detail?: string;
  ip?: string;
  createdAt: string;
}

export interface FeishuSettings {
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
}

export interface SmtpSettings {
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
}

/** DuckMail-compatible mailbox account (address + password + bearer tokens) */
export interface MailAccount {
  id: string;
  address: string;
  passwordHash: string;
  /** inbound tenant key (local-part by default) */
  tenant: string;
  status: "active" | "disabled";
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MailToken {
  token: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
}

export interface MessageFlags {
  seen: boolean;
  deleted: boolean;
  updatedAt: string;
}

interface DbShape {
  users: User[];
  domains: Domain[];
  receiveChannels: ReceiveChannel[];
  loginChannels: LoginChannel[];
  authIdentities: AuthIdentity[];
  sessions: Session[];
  auditLogs: AuditLog[];
  mailAccounts: MailAccount[];
  mailTokens: MailToken[];
  userApiKeys: UserApiKey[];
  apiCallLogs: ApiCallLog[];
  /** key: `${tenant}|${mailId}` */
  messageFlags: Record<string, MessageFlags>;
  settings: {
    feishu: FeishuSettings;
    smtp: SmtpSettings;
    /** Legacy / env-seeded global API keys (dk_…) — still accepted */
    apiKeys: string[];
  };
}

function id(prefix = ""): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

function maskApiKey(key: string): string {
  if (key.length <= 10) return "dk_••••";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function normalizeScopes(scopes: unknown): ApiKeyScope[] {
  const set = new Set<ApiKeyScope>();
  if (!Array.isArray(scopes)) return [];
  for (const s of scopes) {
    if (s === "read" || s === "write") set.add(s);
  }
  return [...set];
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function defaultFeishu(): FeishuSettings {
  return {
    enabled: false,
    appId: "",
    appSecret: "",
    encryptKey: "",
    verificationToken: "",
    notifyChatId: "",
    notifyOnInbound: false,
    oauthRedirectUri: "",
    updatedAt: null,
    updatedBy: null,
  };
}

function defaultSmtp(): SmtpSettings {
  return {
    enabled: false,
    host: "",
    port: 587,
    secure: false,
    username: "",
    password: "",
    fromAddress: "",
    fromName: "Touch Mail",
    replyTo: "",
    updatedAt: null,
    updatedBy: null,
  };
}

function isValidWorkerName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 63 &&
    /^[a-z0-9-]+$/.test(value) &&
    !value.startsWith("-") &&
    !value.endsWith("-")
  );
}

function publicReceiveChannel(channel: ReceiveChannel): PublicReceiveChannel {
  return {
    ...channel,
    adminKey: channel.adminKey ? "••••••••" : "",
    pushToken: channel.pushToken ? `${channel.pushToken.slice(0, 8)}…${channel.pushToken.slice(-4)}` : "",
    adminKeySet: Boolean(channel.adminKey),
    pushTokenSet: Boolean(channel.pushToken),
  };
}

function normalizeReceiveChannel(channel: ReceiveChannel): ReceiveChannel {
  channel.name = channel.name.trim().slice(0, 80);
  channel.description = channel.description.trim().slice(0, 300);
  channel.forwardingAddressTemplate = channel.forwardingAddressTemplate.trim().toLowerCase();
  channel.baseUrl = channel.baseUrl.trim().replace(/\/$/, "");
  channel.adminKey = channel.adminKey.trim();
  channel.pushToken = channel.pushToken.trim();
  channel.pollIntervalSeconds = Math.min(3600, Math.max(30, channel.pollIntervalSeconds || 60));
  if (!channel.name) throw new Error("请填写收件渠道名称");
  if (channel.type === "worker") {
    channel.collectorType = "";
    channel.forwardingAddressTemplate = "";
    channel.baseUrl = "";
    channel.adminKey = "";
    channel.pushToken = "";
  } else if (channel.type === "email_forward") {
    if (channel.collectorType !== "webhook" && channel.collectorType !== "donemail") {
      throw new Error("请选择邮箱转发后的收集方式");
    }
    if (!channel.forwardingAddressTemplate.includes("{tenant}")) {
      throw new Error("邮箱转发目标模板必须包含 {tenant}");
    }
    if (!channel.forwardingAddressTemplate.includes("@")) {
      throw new Error("邮箱转发目标模板格式不正确");
    }
    if (channel.collectorType === "webhook") {
      if (channel.pushToken.length < 16) throw new Error("Webhook 签名 Token 至少 16 位");
      channel.baseUrl = "";
      channel.adminKey = "";
    } else {
      let url: URL;
      try {
        url = new URL(channel.baseUrl);
      } catch {
        throw new Error("DoneMail API 地址格式不正确");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("DoneMail API 地址必须使用 HTTP 或 HTTPS");
      }
      if (!channel.adminKey) throw new Error("请填写 DoneMail X-Admin-Key");
      channel.pushToken = "";
    }
  } else if (channel.type === "donemail") {
    // Legacy direct DoneMail channels remain readable and operable.
    channel.collectorType = "donemail";
    let url: URL;
    try {
      url = new URL(channel.baseUrl);
    } catch {
      throw new Error("DoneMail API 地址格式不正确");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("DoneMail API 地址必须使用 HTTP 或 HTTPS");
    }
    if (!channel.adminKey) throw new Error("请填写 DoneMail X-Admin-Key");
    channel.forwardingAddressTemplate = "";
    channel.pushToken = "";
  } else if (channel.type === "api_push") {
    channel.collectorType = "";
    if (channel.pushToken.length < 16) throw new Error("API 上报 Token 至少 16 位");
    channel.forwardingAddressTemplate = "";
    channel.baseUrl = "";
    channel.adminKey = "";
  } else {
    throw new Error("不支持的收件渠道类型");
  }
  return channel;
}

function publicLoginChannel(channel: LoginChannel): PublicLoginChannel {
  return {
    ...channel,
    clientSecret: channel.clientSecret ? "••••••••" : "",
    clientSecretSet: Boolean(channel.clientSecret),
  };
}

function normalizeLoginChannel(channel: LoginChannel): LoginChannel {
  channel.name = channel.name.trim().slice(0, 80);
  channel.issuer = channel.issuer.trim().replace(/\/$/, "");
  channel.clientId = channel.clientId.trim();
  channel.clientSecret = channel.clientSecret.trim();
  channel.scopes = [...new Set(channel.scopes.map((scope) => scope.trim()).filter(Boolean))];
  channel.subjectClaim = channel.subjectClaim.trim() || "sub";
  channel.usernameClaim = channel.usernameClaim.trim() || "preferred_username";
  channel.displayNameClaim = channel.displayNameClaim.trim() || "name";
  if (!channel.name) throw new Error("请填写登录渠道名称");
  if (channel.type === "feishu") {
    channel.issuer = "";
    channel.clientId = "";
    channel.clientSecret = "";
    channel.scopes = [];
    channel.subjectClaim = "open_id";
    channel.usernameClaim = "name";
    channel.displayNameClaim = "name";
    return channel;
  }
  let issuer: URL;
  try {
    issuer = new URL(channel.issuer);
  } catch {
    throw new Error("OIDC Issuer 地址格式不正确");
  }
  if (
    issuer.protocol !== "https:" &&
    !(
      issuer.protocol === "http:" &&
      (issuer.hostname === "localhost" || issuer.hostname === "127.0.0.1" || issuer.hostname === "[::1]")
    )
  ) {
    throw new Error("OIDC Issuer 必须使用 HTTPS；仅本机开发允许 HTTP");
  }
  if (!channel.clientId) throw new Error("请填写 OIDC Client ID");
  if (!channel.clientSecret) throw new Error("请填写 OIDC Client Secret");
  if (!channel.scopes.includes("openid")) channel.scopes.unshift("openid");
  for (const claim of [channel.subjectClaim, channel.usernameClaim, channel.displayNameClaim]) {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(claim)) throw new Error("OIDC Claim 名称格式不正确");
  }
  return channel;
}

export class AppDb {
  private file: string;
  private data: DbShape = {
    users: [],
    domains: [],
    receiveChannels: [],
    loginChannels: [],
    authIdentities: [],
    sessions: [],
    auditLogs: [],
    mailAccounts: [],
    mailTokens: [],
    userApiKeys: [],
    apiCallLogs: [],
    messageFlags: {},
    settings: { feishu: defaultFeishu(), smtp: defaultSmtp(), apiKeys: [] },
  };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private dataDir: string) {
    this.file = path.join(dataDir, "app.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(path.join(this.dataDir, "raw"), { recursive: true });
    await mkdir(path.join(this.dataDir, "meta"), { recursive: true });
    await mkdir(path.join(this.dataDir, "index"), { recursive: true });
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<DbShape> & {
        settings?: { feishu?: FeishuSettings; smtp?: SmtpSettings; apiKeys?: string[] };
      };
      this.data = {
        users: parsed.users || [],
        domains: parsed.domains || [],
        receiveChannels: parsed.receiveChannels || [],
        loginChannels: parsed.loginChannels || [],
        authIdentities: parsed.authIdentities || [],
        sessions: parsed.sessions || [],
        auditLogs: parsed.auditLogs || [],
        mailAccounts: parsed.mailAccounts || [],
        mailTokens: parsed.mailTokens || [],
        userApiKeys: parsed.userApiKeys || [],
        apiCallLogs: parsed.apiCallLogs || [],
        messageFlags: parsed.messageFlags || {},
        settings: {
          feishu: { ...defaultFeishu(), ...(parsed.settings?.feishu || {}) },
          smtp: { ...defaultSmtp(), ...(parsed.settings?.smtp || {}) },
          apiKeys: parsed.settings?.apiKeys || [],
        },
      };
      let migrated = parsed.loginChannels === undefined || parsed.authIdentities === undefined;
      for (const u of this.data.users) {
        if (!u.role) u.role = "user";
        if (!u.status) u.status = "active";
        if (!u.updatedAt) u.updatedAt = u.createdAt;
      }
      for (const d of this.data.domains) {
        if (d.visibility !== "public" && d.visibility !== "private") {
          d.visibility = "private";
          migrated = true;
        }
        if ((d as Partial<Domain>).receiveChannelId === undefined) {
          d.receiveChannelId = null;
          migrated = true;
        }
        if ((d as Partial<Domain>).workerName === undefined) {
          d.workerName = "";
          migrated = true;
        }
      }
      for (const channel of this.data.receiveChannels) {
        if (!(channel as Partial<ReceiveChannel>).collectorType) {
          channel.collectorType =
            channel.type === "email_forward" ? "webhook" : channel.type === "donemail" ? "donemail" : "";
          migrated = true;
        }
        channel.description ||= "";
        channel.forwardingAddressTemplate ||= "";
        channel.baseUrl ||= "";
        channel.adminKey ||= "";
        channel.pushToken ||= "";
        channel.pollIntervalSeconds = Math.min(3600, Math.max(30, channel.pollIntervalSeconds || 60));
        channel.lastSyncAt ||= null;
        channel.lastSyncError ||= "";
        channel.updatedAt ||= channel.createdAt;
        channel.updatedBy ||= "system";
      }
      for (const channel of this.data.loginChannels) {
        channel.scopes ||= channel.type === "oidc" ? ["openid", "profile", "email"] : [];
        channel.subjectClaim ||= channel.type === "oidc" ? "sub" : "open_id";
        channel.usernameClaim ||= channel.type === "oidc" ? "preferred_username" : "name";
        channel.displayNameClaim ||= "name";
        channel.updatedAt ||= channel.createdAt;
        channel.updatedBy ||= "system";
      }
      for (const k of this.data.userApiKeys) {
        if (!Array.isArray(k.scopes) || k.scopes.length === 0) {
          k.scopes = ["read", "write"];
          migrated = true;
        } else {
          k.scopes = k.scopes.filter((s): s is ApiKeyScope => s === "read" || s === "write");
          if (k.scopes.length === 0) k.scopes = ["read"];
        }
        if (k.status !== "active" && k.status !== "revoked") {
          k.status = "active";
          migrated = true;
        }
      }
      if (this.data.users.length && !this.data.users.some((u) => u.role === "admin")) {
        this.data.users[0].role = "admin";
      }
      if (migrated) await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.persist();
      } else {
        throw error;
      }
    }
    this.purgeExpiredSessions();
  }

  private async persist(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), "utf8");
    await rename(tmp, this.file);
  }

  private queueWrite(): Promise<void> {
    this.writeChain = this.writeChain.then(() => this.persist()).catch((err) => {
      console.error("db write failed", err);
    });
    return this.writeChain;
  }

  private purgeExpiredSessions(): void {
    const now = Date.now();
    this.data.sessions = this.data.sessions.filter((s) => Date.parse(s.expiresAt) > now);
  }

  // ---- audit ----

  async addAudit(entry: {
    actorId?: string | null;
    actorUsername?: string | null;
    action: string;
    resource: string;
    resourceId?: string;
    detail?: string;
    ip?: string;
  }): Promise<AuditLog> {
    const log: AuditLog = {
      id: id("a"),
      actorId: entry.actorId ?? null,
      actorUsername: entry.actorUsername ?? null,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      detail: entry.detail?.slice(0, 500),
      ip: entry.ip,
      createdAt: new Date().toISOString(),
    };
    this.data.auditLogs.push(log);
    // keep last 5000
    if (this.data.auditLogs.length > 5000) {
      this.data.auditLogs = this.data.auditLogs.slice(-5000);
    }
    await this.queueWrite();
    return log;
  }

  listAuditLogs(opts: {
    q?: string;
    action?: string;
    resource?: string;
    page?: number;
    pageSize?: number;
  }): { items: AuditLog[]; total: number; page: number; pageSize: number } {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize || 20));
    let items = [...this.data.auditLogs].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    if (opts.action) {
      items = items.filter((x) => x.action === opts.action);
    }
    if (opts.resource) {
      items = items.filter((x) => x.resource === opts.resource);
    }
    if (opts.q) {
      const q = opts.q.toLowerCase();
      items = items.filter(
        (x) =>
          (x.actorUsername || "").toLowerCase().includes(q) ||
          x.action.toLowerCase().includes(q) ||
          x.resource.toLowerCase().includes(q) ||
          (x.detail || "").toLowerCase().includes(q) ||
          (x.resourceId || "").toLowerCase().includes(q),
      );
    }
    const total = items.length;
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total, page, pageSize };
  }

  // ---- users ----

  findUserByUsername(username: string): User | undefined {
    return this.data.users.find((u) => u.username === username.toLowerCase());
  }

  findUserById(id: string): User | undefined {
    return this.data.users.find((u) => u.id === id);
  }

  findUserByTenant(tenant: string): User | undefined {
    return this.data.users.find((u) => u.tenant === tenant.toLowerCase());
  }

  listUsers(opts: {
    q?: string;
    role?: string;
    status?: string;
    page?: number;
    pageSize?: number;
  }): { items: User[]; total: number; page: number; pageSize: number } {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize || 20));
    let items = [...this.data.users].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    if (opts.role) items = items.filter((u) => u.role === opts.role);
    if (opts.status) items = items.filter((u) => u.status === opts.status);
    if (opts.q) {
      const q = opts.q.toLowerCase();
      items = items.filter(
        (u) =>
          u.username.includes(q) ||
          u.displayName.toLowerCase().includes(q) ||
          u.tenant.includes(q),
      );
    }
    const total = items.length;
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total, page, pageSize };
  }

  async createUser(opts: {
    username: string;
    password: string;
    displayName?: string;
    role?: UserRole;
  }): Promise<User> {
    const username = opts.username.toLowerCase().trim();
    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      throw new Error("用户名需 3-24 位，仅小写字母数字下划线");
    }
    if (opts.password.length < 8) {
      throw new Error("密码至少 8 位");
    }
    if (this.findUserByUsername(username)) {
      throw new Error("用户名已存在");
    }

    let tenant = slugify(username);
    if (!tenant) tenant = id("t").slice(0, 10);
    if (this.findUserByTenant(tenant)) {
      tenant = `${tenant}-${randomBytes(2).toString("hex")}`;
    }

    const now = new Date().toISOString();
    const isFirst = this.data.users.length === 0;
    const user: User = {
      id: id("u"),
      username,
      passwordHash: hashPassword(opts.password),
      tenant,
      displayName: (opts.displayName || username).slice(0, 48),
      role: opts.role || (isFirst ? "admin" : "user"),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.data.users.push(user);
    await this.queueWrite();
    return user;
  }

  async updateUser(
    userId: string,
    patch: {
      displayName?: string;
      role?: UserRole;
      status?: "active" | "disabled";
      password?: string;
    },
  ): Promise<User> {
    const user = this.findUserById(userId);
    if (!user) throw new Error("用户不存在");
    if (patch.displayName !== undefined) {
      user.displayName = patch.displayName.slice(0, 48);
    }
    if (patch.role !== undefined) {
      if (patch.role === "user" && user.role === "admin") {
        const admins = this.data.users.filter((u) => u.role === "admin" && u.id !== userId);
        if (admins.length === 0) throw new Error("至少保留一名管理员");
      }
      user.role = patch.role;
    }
    if (patch.status !== undefined) {
      if (patch.status === "disabled" && user.role === "admin") {
        const activeAdmins = this.data.users.filter(
          (u) => u.role === "admin" && u.status === "active" && u.id !== userId,
        );
        if (activeAdmins.length === 0) throw new Error("不能禁用最后一名管理员");
      }
      user.status = patch.status;
    }
    if (patch.password !== undefined) {
      if (patch.password.length < 8) throw new Error("密码至少 8 位");
      user.passwordHash = hashPassword(patch.password);
    }
    user.updatedAt = new Date().toISOString();
    await this.queueWrite();
    return user;
  }

  async deleteUser(userId: string): Promise<boolean> {
    const user = this.findUserById(userId);
    if (!user) return false;
    if (user.role === "admin") {
      const admins = this.data.users.filter((u) => u.role === "admin" && u.id !== userId);
      if (admins.length === 0) throw new Error("不能删除最后一名管理员");
    }
    this.data.users = this.data.users.filter((u) => u.id !== userId);
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== userId);
    this.data.domains = this.data.domains.filter((d) => d.userId !== userId);
    this.data.authIdentities = this.data.authIdentities.filter((identity) => identity.userId !== userId);
    await this.queueWrite();
    return true;
  }

  async createSession(userId: string, days = 30): Promise<Session> {
    this.purgeExpiredSessions();
    const session: Session = {
      id: id("s"),
      userId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + days * 86400_000).toISOString(),
    };
    this.data.sessions.push(session);
    const mine = this.data.sessions.filter((s) => s.userId === userId);
    if (mine.length > 10) {
      const drop = mine
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .slice(0, mine.length - 10)
        .map((s) => s.id);
      this.data.sessions = this.data.sessions.filter((s) => !drop.includes(s.id));
    }
    await this.queueWrite();
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    this.purgeExpiredSessions();
    const s = this.data.sessions.find((x) => x.id === sessionId);
    if (!s) return undefined;
    if (Date.parse(s.expiresAt) <= Date.now()) return undefined;
    return s;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== sessionId);
    await this.queueWrite();
  }

  // ---- login channels / external identities ----

  listLoginChannels(includeDisabled = false): LoginChannel[] {
    return this.data.loginChannels
      .filter((channel) => includeDisabled || channel.enabled)
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .map((channel) => ({ ...channel, scopes: [...channel.scopes] }));
  }

  listLoginChannelsPublic(includeDisabled = false): PublicLoginChannel[] {
    return this.listLoginChannels(includeDisabled).map(publicLoginChannel);
  }

  getLoginChannel(channelId: string | null | undefined): LoginChannel | undefined {
    if (!channelId) return undefined;
    return this.data.loginChannels.find((channel) => channel.id === channelId);
  }

  getLoginChannelIdentityCount(channelId: string): number {
    return this.data.authIdentities.filter((identity) => identity.channelId === channelId).length;
  }

  async createLoginChannel(
    input: {
      name: string;
      type: LoginChannelType;
      enabled?: boolean;
      issuer?: string;
      clientId?: string;
      clientSecret?: string;
      scopes?: string[];
      subjectClaim?: string;
      usernameClaim?: string;
      displayNameClaim?: string;
    },
    updatedBy: string,
  ): Promise<LoginChannel> {
    if (input.type !== "feishu" && input.type !== "oidc") {
      throw new Error("不支持的登录渠道类型");
    }
    if (input.type === "feishu" && this.data.loginChannels.some((item) => item.type === "feishu")) {
      throw new Error("飞书登录渠道已存在");
    }
    const now = new Date().toISOString();
    const channel = normalizeLoginChannel({
      id: id("lc_"),
      name: String(input.name || ""),
      type: input.type,
      enabled: input.enabled ?? true,
      issuer: String(input.issuer || ""),
      clientId: String(input.clientId || ""),
      clientSecret: String(input.clientSecret || ""),
      scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : [],
      subjectClaim: String(input.subjectClaim || ""),
      usernameClaim: String(input.usernameClaim || ""),
      displayNameClaim: String(input.displayNameClaim || ""),
      createdAt: now,
      updatedAt: now,
      updatedBy,
    });
    if (this.data.loginChannels.some((item) => item.name === channel.name)) {
      throw new Error("登录渠道名称已存在");
    }
    this.data.loginChannels.push(channel);
    await this.queueWrite();
    return { ...channel, scopes: [...channel.scopes] };
  }

  async updateLoginChannel(
    channelId: string,
    patch: Partial<{
      name: string;
      enabled: boolean;
      issuer: string;
      clientId: string;
      clientSecret: string;
      scopes: string[];
      subjectClaim: string;
      usernameClaim: string;
      displayNameClaim: string;
    }>,
    updatedBy: string,
  ): Promise<LoginChannel | null> {
    const current = this.getLoginChannel(channelId);
    if (!current) return null;
    if (this.getLoginChannelIdentityCount(channelId) > 0 && current.type === "oidc") {
      const nextIssuer =
        patch.issuer !== undefined ? String(patch.issuer).trim().replace(/\/$/, "") : current.issuer;
      const nextClientId =
        patch.clientId !== undefined ? String(patch.clientId).trim() : current.clientId;
      const nextSubjectClaim =
        patch.subjectClaim !== undefined
          ? String(patch.subjectClaim).trim() || "sub"
          : current.subjectClaim;
      if (
        nextIssuer !== current.issuer ||
        nextClientId !== current.clientId ||
        nextSubjectClaim !== current.subjectClaim
      ) {
        throw new Error("该登录渠道已有用户身份记录，不能修改 Issuer、Client ID 或用户唯一标识 Claim；请新建渠道");
      }
    }
    const submittedSecret = patch.clientSecret !== undefined ? String(patch.clientSecret) : undefined;
    const next = normalizeLoginChannel({
      ...current,
      name: patch.name !== undefined ? String(patch.name) : current.name,
      enabled: patch.enabled ?? current.enabled,
      issuer: patch.issuer !== undefined ? String(patch.issuer) : current.issuer,
      clientId: patch.clientId !== undefined ? String(patch.clientId) : current.clientId,
      clientSecret:
        submittedSecret && !submittedSecret.includes("••") ? submittedSecret : current.clientSecret,
      scopes: Array.isArray(patch.scopes) ? patch.scopes.map(String) : current.scopes,
      subjectClaim:
        patch.subjectClaim !== undefined ? String(patch.subjectClaim) : current.subjectClaim,
      usernameClaim:
        patch.usernameClaim !== undefined ? String(patch.usernameClaim) : current.usernameClaim,
      displayNameClaim:
        patch.displayNameClaim !== undefined
          ? String(patch.displayNameClaim)
          : current.displayNameClaim,
      updatedAt: new Date().toISOString(),
      updatedBy,
    });
    if (this.data.loginChannels.some((item) => item.id !== channelId && item.name === next.name)) {
      throw new Error("登录渠道名称已存在");
    }
    Object.assign(current, next);
    await this.queueWrite();
    return { ...current, scopes: [...current.scopes] };
  }

  async deleteLoginChannel(channelId: string): Promise<boolean> {
    if (this.data.authIdentities.some((identity) => identity.channelId === channelId)) {
      throw new Error("该登录渠道已有用户身份记录，请停用而不是删除");
    }
    const before = this.data.loginChannels.length;
    this.data.loginChannels = this.data.loginChannels.filter((channel) => channel.id !== channelId);
    if (this.data.loginChannels.length === before) return false;
    await this.queueWrite();
    return true;
  }

  async resolveAuthIdentity(
    channelId: string,
    profile: { subject: string; username?: string; displayName?: string },
  ): Promise<{ user: User; isNew: boolean }> {
    const subject = profile.subject.trim().slice(0, 256);
    if (!subject) throw new Error("登录渠道未返回用户唯一标识");
    const now = new Date().toISOString();
    const existing = this.data.authIdentities.find(
      (identity) => identity.channelId === channelId && identity.subject === subject,
    );
    if (existing) {
      const user = this.findUserById(existing.userId);
      if (!user) throw new Error("外部身份绑定的用户不存在");
      existing.lastLoginAt = now;
      await this.queueWrite();
      return { user, isNew: false };
    }

    let baseUsername = String(profile.username || "external")
      .toLowerCase()
      .split("@")[0]
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24);
    if (baseUsername.length < 3) baseUsername = `user_${baseUsername || "oidc"}`.slice(0, 24);
    let username = baseUsername;
    while (this.findUserByUsername(username)) {
      username = `${baseUsername.slice(0, 17)}_${randomBytes(3).toString("hex")}`;
    }
    let tenant = slugify(username) || id("t").slice(0, 10);
    while (this.findUserByTenant(tenant)) {
      tenant = `${tenant.slice(0, 25)}-${randomBytes(2).toString("hex")}`;
    }
    const user: User = {
      id: id("u"),
      username,
      passwordHash: hashPassword(randomBytes(32).toString("base64url")),
      tenant,
      displayName: String(profile.displayName || username).trim().slice(0, 48) || username,
      role: "user",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.data.users.push(user);
    this.data.authIdentities.push({
      id: id("ai_"),
      channelId,
      subject,
      userId: user.id,
      createdAt: now,
      lastLoginAt: now,
    });
    await this.queueWrite();
    return { user, isNew: true };
  }

  // ---- domains ----

  listDomains(userId: string): Domain[] {
    return this.data.domains
      .filter((d) => d.userId === userId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  listAllDomains(opts: {
    q?: string;
    page?: number;
    pageSize?: number;
  }): {
    items: Array<Domain & { username?: string; tenant?: string }>;
    total: number;
    page: number;
    pageSize: number;
  } {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize || 20));
    let items = this.data.domains.map((d) => {
      const u = this.findUserById(d.userId);
      return { ...d, username: u?.username, tenant: u?.tenant };
    });
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (opts.q) {
      const q = opts.q.toLowerCase();
      items = items.filter(
        (d) =>
          d.domain.includes(q) ||
          (d.note || "").toLowerCase().includes(q) ||
          (d.username || "").includes(q) ||
          (d.tenant || "").includes(q),
      );
    }
    const total = items.length;
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total, page, pageSize };
  }

  async addDomain(
    userId: string,
    domainRaw: string,
    note: string,
    visibility: DomainVisibility,
    receiveChannelId: string,
    workerName: string,
  ): Promise<Domain> {
    const domain = domainRaw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\.$/, "");
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
      throw new Error("域名格式不正确");
    }
    if (this.data.domains.some((d) => d.domain === domain)) {
      throw new Error("该域名已被绑定");
    }
    const receiveChannel = this.getReceiveChannel(receiveChannelId);
    if (!receiveChannel || !receiveChannel.enabled) {
      throw new Error("请选择管理员已启用的收件渠道");
    }
    const normalizedWorkerName = workerName.trim().toLowerCase();
    if (receiveChannel.type === "worker" && !isValidWorkerName(normalizedWorkerName)) {
      throw new Error("Worker Name 只能包含小写字母、数字和连字符，最长 63 位，且不能以连字符开头或结尾");
    }

    const item: Domain = {
      id: id("d"),
      userId,
      domain,
      note: note.slice(0, 200),
      visibility: visibility === "public" ? "public" : "private",
      receiveChannelId: receiveChannel.id,
      workerName: receiveChannel.type === "worker" ? normalizedWorkerName : "",
      createdAt: new Date().toISOString(),
    };
    this.data.domains.push(item);
    await this.queueWrite();
    return item;
  }

  async updateDomain(
    userId: string,
    domainId: string,
    patch: Partial<{
      note: string;
      visibility: DomainVisibility;
      receiveChannelId: string;
      workerName: string;
    }>,
  ): Promise<Domain | null> {
    const item = this.data.domains.find((d) => d.userId === userId && d.id === domainId);
    if (!item) return null;
    if (patch.note !== undefined) item.note = String(patch.note).slice(0, 200);
    if (patch.visibility === "public" || patch.visibility === "private") {
      item.visibility = patch.visibility;
    }
    const receiveChannelId = patch.receiveChannelId ?? item.receiveChannelId;
    if (receiveChannelId) {
      const receiveChannel = this.getReceiveChannel(receiveChannelId);
      if (!receiveChannel || (!receiveChannel.enabled && receiveChannel.id !== item.receiveChannelId)) {
        throw new Error("请选择管理员已启用的收件渠道");
      }
      const workerName = String(patch.workerName ?? item.workerName).trim().toLowerCase();
      if (receiveChannel.type === "worker" && !isValidWorkerName(workerName)) {
        throw new Error("Worker Name 只能包含小写字母、数字和连字符，最长 63 位，且不能以连字符开头或结尾");
      }
      item.receiveChannelId = receiveChannel.id;
      item.workerName = receiveChannel.type === "worker" ? workerName : "";
    }
    await this.queueWrite();
    return item;
  }


  listReceiveChannels(includeDisabled = false): ReceiveChannel[] {
    return this.data.receiveChannels
      .filter((channel) => includeDisabled || channel.enabled)
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .map((channel) => ({ ...channel }));
  }

  listReceiveChannelsPublic(includeDisabled = false): PublicReceiveChannel[] {
    return this.listReceiveChannels(includeDisabled).map(publicReceiveChannel);
  }

  getReceiveChannel(channelId: string | null | undefined): ReceiveChannel | undefined {
    if (!channelId) return undefined;
    return this.data.receiveChannels.find((channel) => channel.id === channelId);
  }

  getReceiveChannelPublic(channelId: string | null | undefined): PublicReceiveChannel | undefined {
    const channel = this.getReceiveChannel(channelId);
    return channel ? publicReceiveChannel(channel) : undefined;
  }

  async createReceiveChannel(
    input: {
      name: string;
      description?: string;
      type: ReceiveChannelType;
      collectorType?: EmailForwardCollectorType;
      enabled?: boolean;
      forwardingAddressTemplate?: string;
      baseUrl?: string;
      adminKey?: string;
      pushToken?: string;
      pollIntervalSeconds?: number;
    },
    updatedBy: string,
  ): Promise<ReceiveChannel> {
    const now = new Date().toISOString();
    const channel = normalizeReceiveChannel({
      id: id("rc_"),
      name: String(input.name || ""),
      description: String(input.description || ""),
      type: input.type,
      collectorType:
        input.type === "email_forward"
          ? input.collectorType || "webhook"
          : input.type === "donemail"
            ? "donemail"
            : "",
      enabled: input.enabled ?? true,
      forwardingAddressTemplate: String(input.forwardingAddressTemplate || ""),
      baseUrl: String(input.baseUrl || ""),
      adminKey: String(input.adminKey || ""),
      pushToken:
        input.type === "api_push" ||
        (input.type === "email_forward" && (input.collectorType || "webhook") === "webhook")
          ? String(input.pushToken || `tm_in_${randomBytes(24).toString("base64url")}`)
          : "",
      pollIntervalSeconds: Number(input.pollIntervalSeconds || 60),
      lastSyncAt: null,
      lastSyncError: "",
      createdAt: now,
      updatedAt: now,
      updatedBy,
    });
    if (this.data.receiveChannels.some((item) => item.name === channel.name)) {
      throw new Error("收件渠道名称已存在");
    }
    this.data.receiveChannels.push(channel);
    await this.queueWrite();
    return { ...channel };
  }

  async updateReceiveChannel(
    channelId: string,
    patch: Partial<{
      name: string;
      description: string;
      type: ReceiveChannelType;
      collectorType: EmailForwardCollectorType;
      enabled: boolean;
      forwardingAddressTemplate: string;
      baseUrl: string;
      adminKey: string;
      pushToken: string;
      pollIntervalSeconds: number;
    }>,
    updatedBy: string,
  ): Promise<ReceiveChannel | null> {
    const current = this.getReceiveChannel(channelId);
    if (!current) return null;
    const next = normalizeReceiveChannel({
      ...current,
      name: patch.name !== undefined ? String(patch.name) : current.name,
      description:
        patch.description !== undefined ? String(patch.description) : current.description,
      type: patch.type || current.type,
      collectorType:
        patch.collectorType !== undefined ? patch.collectorType : current.collectorType,
      enabled: patch.enabled ?? current.enabled,
      forwardingAddressTemplate:
        patch.forwardingAddressTemplate !== undefined
          ? String(patch.forwardingAddressTemplate)
          : current.forwardingAddressTemplate,
      baseUrl: patch.baseUrl !== undefined ? String(patch.baseUrl) : current.baseUrl,
      adminKey:
        patch.adminKey !== undefined && patch.adminKey && !String(patch.adminKey).includes("••")
          ? String(patch.adminKey)
          : current.adminKey,
      pushToken:
        patch.pushToken !== undefined && patch.pushToken && !String(patch.pushToken).includes("…")
          ? String(patch.pushToken)
          : current.pushToken ||
            ((patch.type || current.type) === "api_push" ||
            ((patch.type || current.type) === "email_forward" &&
              (patch.collectorType || current.collectorType) === "webhook")
              ? `tm_in_${randomBytes(24).toString("base64url")}`
              : ""),
      pollIntervalSeconds:
        patch.pollIntervalSeconds !== undefined
          ? Number(patch.pollIntervalSeconds)
          : current.pollIntervalSeconds,
      updatedAt: new Date().toISOString(),
      updatedBy,
    });
    if (this.data.receiveChannels.some((item) => item.id !== channelId && item.name === next.name)) {
      throw new Error("收件渠道名称已存在");
    }
    Object.assign(current, next);
    await this.queueWrite();
    return { ...current };
  }

  async deleteReceiveChannel(channelId: string): Promise<boolean> {
    if (this.data.domains.some((domain) => domain.receiveChannelId === channelId)) {
      throw new Error("该收件渠道仍被域名使用，不能删除");
    }
    const before = this.data.receiveChannels.length;
    this.data.receiveChannels = this.data.receiveChannels.filter((channel) => channel.id !== channelId);
    if (this.data.receiveChannels.length === before) return false;
    await this.queueWrite();
    return true;
  }

  async markReceiveChannelSync(channelId: string, error = ""): Promise<void> {
    const channel = this.getReceiveChannel(channelId);
    if (!channel) return;
    channel.lastSyncAt = new Date().toISOString();
    channel.lastSyncError = error.slice(0, 500);
    await this.queueWrite();
  }

  findDomainByName(domainName: string): Domain | undefined {
    const normalized = domainName.trim().toLowerCase().replace(/\.$/, "");
    return this.data.domains.find((domain) => domain.domain === normalized);
  }

  findDomainByAddress(address: string): Domain | undefined {
    const at = address.lastIndexOf("@");
    return at > 0 ? this.findDomainByName(address.slice(at + 1)) : undefined;
  }

  renderForwardingAddress(domain: Domain, tenant: string): string | null {
    const channel = this.getReceiveChannel(domain.receiveChannelId);
    if (!channel || channel.type !== "email_forward") return null;
    return channel.forwardingAddressTemplate
      .replaceAll("{tenant}", tenant.toLowerCase())
      .replaceAll("{domain}", domain.domain);
  }

  resolveForwardedRecipient(
    channelId: string,
    address: string,
  ): { user: User; domain: Domain } | null {
    const normalized = address.trim().toLowerCase();
    for (const domain of this.data.domains) {
      if (domain.receiveChannelId !== channelId) continue;
      const user = this.data.users.find((candidate) => candidate.id === domain.userId);
      if (!user || user.status !== "active") continue;
      if (this.renderForwardingAddress(domain, user.tenant) === normalized) {
        return { user, domain };
      }
    }
    return null;
  }

  getReceiveChannelImpact(channelId: string): {
    userCount: number;
    domainCount: number;
    users: Array<{ id: string; username: string; tenant: string }>;
    domains: Array<{ id: string; domain: string; userId: string; username: string }>;
  } {
    const domains = this.data.domains.filter((domain) => domain.receiveChannelId === channelId);
    const userIds = new Set(domains.map((domain) => domain.userId));
    const users = this.data.users
      .filter((user) => userIds.has(user.id))
      .map((user) => ({ id: user.id, username: user.username, tenant: user.tenant }));
    return {
      userCount: users.length,
      domainCount: domains.length,
      users,
      domains: domains.map((domain) => ({
        id: domain.id,
        domain: domain.domain,
        userId: domain.userId,
        username: users.find((user) => user.id === domain.userId)?.username || domain.userId,
      })),
    };
  }

  getSmtpSettings(): SmtpSettings {
    return { ...this.data.settings.smtp };
  }

  getSmtpSettingsPublic(): SmtpSettings & { passwordSet: boolean } {
    const smtp = this.data.settings.smtp;
    return {
      ...smtp,
      password: smtp.password ? "••••••••" : "",
      passwordSet: Boolean(smtp.password),
    };
  }

  async updateSmtpSettings(
    patch: Partial<Omit<SmtpSettings, "updatedAt" | "updatedBy">>,
    updatedBy: string,
  ): Promise<SmtpSettings> {
    const current = this.data.settings.smtp;
    const next: SmtpSettings = {
      ...current,
      enabled: patch.enabled ?? current.enabled,
      host: patch.host !== undefined ? String(patch.host).trim() : current.host,
      port:
        patch.port !== undefined
          ? Math.min(65535, Math.max(1, Number(patch.port)))
          : current.port,
      secure: patch.secure ?? current.secure,
      username: patch.username !== undefined ? String(patch.username).trim() : current.username,
      fromAddress:
        patch.fromAddress !== undefined
          ? String(patch.fromAddress).trim().toLowerCase()
          : current.fromAddress,
      fromName: patch.fromName !== undefined ? String(patch.fromName).trim() : current.fromName,
      replyTo:
        patch.replyTo !== undefined ? String(patch.replyTo).trim().toLowerCase() : current.replyTo,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    if (patch.password !== undefined && patch.password && !String(patch.password).includes("••")) {
      next.password = String(patch.password);
    }
    this.data.settings.smtp = next;
    await this.queueWrite();
    return { ...next };
  }

  async removeDomain(userId: string, domainId: string): Promise<boolean> {
    const before = this.data.domains.length;
    this.data.domains = this.data.domains.filter(
      (d) => !(d.userId === userId && d.id === domainId),
    );
    if (this.data.domains.length === before) return false;
    await this.queueWrite();
    return true;
  }

  async adminRemoveDomain(domainId: string): Promise<boolean> {
    const before = this.data.domains.length;
    this.data.domains = this.data.domains.filter((d) => d.id !== domainId);
    if (this.data.domains.length === before) return false;
    await this.queueWrite();
    return true;
  }

  // ---- settings / feishu ----

  getFeishuSettings(): FeishuSettings {
    return { ...this.data.settings.feishu };
  }

  /** Public-safe view: secrets masked */
  getFeishuSettingsPublic(): FeishuSettings & {
    appSecretSet: boolean;
    encryptKeySet: boolean;
    verificationTokenSet: boolean;
  } {
    const f = this.data.settings.feishu;
    return {
      ...f,
      appSecret: f.appSecret ? "••••••••" : "",
      encryptKey: f.encryptKey ? "••••••••" : "",
      verificationToken: f.verificationToken ? "••••••••" : "",
      appSecretSet: Boolean(f.appSecret),
      encryptKeySet: Boolean(f.encryptKey),
      verificationTokenSet: Boolean(f.verificationToken),
    };
  }

  async updateFeishuSettings(
    patch: Partial<Omit<FeishuSettings, "updatedAt" | "updatedBy">>,
    updatedBy: string,
  ): Promise<FeishuSettings> {
    const cur = this.data.settings.feishu;
    const next: FeishuSettings = {
      ...cur,
      enabled: patch.enabled ?? cur.enabled,
      appId: patch.appId !== undefined ? String(patch.appId).trim() : cur.appId,
      notifyChatId:
        patch.notifyChatId !== undefined ? String(patch.notifyChatId).trim() : cur.notifyChatId,
      notifyOnInbound: patch.notifyOnInbound ?? cur.notifyOnInbound,
      oauthRedirectUri:
        patch.oauthRedirectUri !== undefined
          ? String(patch.oauthRedirectUri).trim()
          : cur.oauthRedirectUri,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    // only update secrets if non-empty and not masked placeholder
    if (patch.appSecret !== undefined && patch.appSecret && !patch.appSecret.includes("••")) {
      next.appSecret = String(patch.appSecret).trim();
    }
    if (patch.encryptKey !== undefined && patch.encryptKey && !patch.encryptKey.includes("••")) {
      next.encryptKey = String(patch.encryptKey).trim();
    }
    if (
      patch.verificationToken !== undefined &&
      patch.verificationToken &&
      !patch.verificationToken.includes("••")
    ) {
      next.verificationToken = String(patch.verificationToken).trim();
    }
    this.data.settings.feishu = next;
    await this.queueWrite();
    return { ...next };
  }

  // ---- mail storage ----

  private tenantSafe(tenant: string): string {
    return tenant.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  }

  async existsByMessageId(tenant: string, messageId: string): Promise<boolean> {
    if (!messageId) return false;
    const key = createHash("sha256").update(`${tenant}|${messageId}`).digest("hex");
    try {
      await readFile(path.join(this.dataDir, "index", `${key}.id`), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  async saveMail(opts: {
    tenant: string;
    channel: string;
    from: string;
    to: string;
    subject: string;
    messageId: string;
    raw: Buffer;
    parsed: {
      text?: string;
      html?: string;
      attachments: Array<{ filename?: string; contentType?: string; size: number }>;
      date?: Date;
      headers: Record<string, string>;
    };
  }): Promise<{ meta: MailMeta; duplicate: boolean }> {
    const receivedAt = new Date().toISOString();
    const mid = createHash("sha256")
      .update([
        opts.tenant,
        opts.messageId || "",
        opts.from,
        opts.to,
        String(opts.raw.length),
        receivedAt,
        randomBytes(8).toString("hex"),
      ].join("|"))
      .digest("hex")
      .slice(0, 24);

    if (opts.messageId && (await this.existsByMessageId(opts.tenant, opts.messageId))) {
      return {
        meta: {
          id: `dup-${mid}`,
          tenant: opts.tenant,
          channel: opts.channel,
          from: opts.from,
          to: opts.to,
          subject: opts.subject,
          messageId: opts.messageId,
          receivedAt,
          size: opts.raw.length,
          hasAttachments: opts.parsed.attachments.length > 0,
          attachmentCount: opts.parsed.attachments.length,
          textPreview: (opts.parsed.text || "").slice(0, 160),
          rawPath: "",
          jsonPath: "",
        },
        duplicate: true,
      };
    }

    const day = receivedAt.slice(0, 10);
    const safe = this.tenantSafe(opts.tenant);
    const rawRel = path.join("raw", safe, day, `${mid}.eml`);
    const rawPath = path.join(this.dataDir, rawRel);
    await mkdir(path.dirname(rawPath), { recursive: true });
    await writeFile(rawPath, opts.raw);

    const meta: MailMeta = {
      id: mid,
      tenant: opts.tenant,
      channel: opts.channel,
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      messageId: opts.messageId,
      receivedAt,
      size: opts.raw.length,
      hasAttachments: opts.parsed.attachments.length > 0,
      attachmentCount: opts.parsed.attachments.length,
      textPreview: (opts.parsed.text || "").replace(/\s+/g, " ").trim().slice(0, 160),
      rawPath: rawRel,
      jsonPath: "",
    };

    const full = {
      ...meta,
      text: opts.parsed.text || "",
      html: opts.parsed.html || "",
      date: opts.parsed.date?.toISOString() || null,
      headers: opts.parsed.headers,
      attachments: opts.parsed.attachments,
    };

    const jsonRel = path.join("meta", safe, `${mid}.json`);
    const jsonPath = path.join(this.dataDir, jsonRel);
    await mkdir(path.dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, JSON.stringify(full, null, 2), "utf8");
    meta.jsonPath = jsonRel;

    if (opts.messageId) {
      const key = createHash("sha256").update(`${opts.tenant}|${opts.messageId}`).digest("hex");
      const indexPath = path.join(this.dataDir, "index", `${key}.id`);
      try {
        await writeFile(indexPath, mid, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await Promise.all([
          unlink(rawPath).catch(() => undefined),
          unlink(jsonPath).catch(() => undefined),
        ]);
        return {
          meta: {
            ...meta,
            id: `dup-${mid}`,
            rawPath: "",
            jsonPath: "",
          },
          duplicate: true,
        };
      }
    }

    const timeline = path.join(this.dataDir, "meta", safe, "timeline.ndjson");
    await appendFile(timeline, `${JSON.stringify(meta)}\n`, "utf8");

    return { meta, duplicate: false };
  }

  async listMails(
    tenant: string,
    opts: { limit?: number; q?: string; page?: number; pageSize?: number } = {},
  ): Promise<{ items: MailMeta[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize || opts.limit || 20));
    const p = path.join(this.dataDir, "meta", this.tenantSafe(tenant), "timeline.ndjson");
    let items: MailMeta[] = [];
    try {
      const text = await readFile(p, "utf8");
      items = text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as MailMeta)
        .reverse();
    } catch {
      items = [];
    }
    if (opts.q) {
      const q = opts.q.toLowerCase();
      items = items.filter(
        (m) =>
          m.subject.toLowerCase().includes(q) ||
          m.from.toLowerCase().includes(q) ||
          m.to.toLowerCase().includes(q) ||
          m.channel.toLowerCase().includes(q) ||
          (m.textPreview || "").toLowerCase().includes(q),
      );
    }
    const total = items.length;
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total, page, pageSize };
  }

  async listAllMails(opts: {
    q?: string;
    tenant?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: MailMeta[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize || 20));
    const tenants = opts.tenant
      ? [opts.tenant]
      : this.data.users.map((u) => u.tenant);
    let items: MailMeta[] = [];
    for (const t of tenants) {
      const p = path.join(this.dataDir, "meta", this.tenantSafe(t), "timeline.ndjson");
      try {
        const text = await readFile(p, "utf8");
        const rows = text
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as MailMeta);
        items.push(...rows);
      } catch {
        // skip
      }
    }
    items.sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    if (opts.q) {
      const q = opts.q.toLowerCase();
      items = items.filter(
        (m) =>
          m.subject.toLowerCase().includes(q) ||
          m.from.toLowerCase().includes(q) ||
          m.to.toLowerCase().includes(q) ||
          m.tenant.toLowerCase().includes(q) ||
          m.channel.toLowerCase().includes(q),
      );
    }
    const total = items.length;
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total, page, pageSize };
  }

  async getMail(tenant: string, mailId: string): Promise<unknown | null> {
    const p = path.join(this.dataDir, "meta", this.tenantSafe(tenant), `${mailId}.json`);
    try {
      return JSON.parse(await readFile(p, "utf8"));
    } catch {
      return null;
    }
  }

  stats(tenant: string): { domains: number } {
    const user = this.findUserByTenant(tenant);
    if (!user) return { domains: 0 };
    return { domains: this.listDomains(user.id).length };
  }

  globalStats(): {
    userCount: number;
    domainCount: number;
    adminCount: number;
    activeUserCount: number;
  } {
    return {
      userCount: this.data.users.length,
      domainCount: this.data.domains.length,
      adminCount: this.data.users.filter((u) => u.role === "admin").length,
      activeUserCount: this.data.users.filter((u) => u.status === "active").length,
    };
  }

  // ---- DuckMail-compatible mailbox accounts ----

  listPublicDomains(opts: {
    systemDomain: string;
    /** when set, also include this user's private domains */
    apiKeyUserId?: string | null;
    /** legacy: include all private domains (global key) */
    includeAllPrivate?: boolean;
  }): Array<{
    id: string;
    domain: string;
    ownerId: string | null;
    isVerified: boolean;
    visibility: DomainVisibility;
    verificationToken?: string;
    createdAt: string;
    updatedAt: string;
  }> {
    const system = opts.systemDomain.toLowerCase();
    const out: Array<{
      id: string;
      domain: string;
      ownerId: string | null;
      isVerified: boolean;
      visibility: DomainVisibility;
      verificationToken?: string;
      createdAt: string;
      updatedAt: string;
    }> = [
      {
        id: createHash("md5").update(`system|${system}`).digest("hex"),
        domain: system,
        ownerId: null,
        isVerified: true,
        visibility: "public",
        createdAt: "0001-01-01T00:00:00Z",
        updatedAt: "0001-01-01T00:00:00Z",
      },
    ];
    for (const d of this.data.domains) {
      const vis: DomainVisibility = d.visibility === "public" ? "public" : "private";
      const allow =
        vis === "public" ||
        opts.includeAllPrivate ||
        (opts.apiKeyUserId && d.userId === opts.apiKeyUserId);
      if (!allow) continue;
      out.push({
        id: d.id,
        domain: d.domain,
        ownerId: d.userId,
        isVerified: true,
        visibility: vis,
        verificationToken: `touchmail-verify-${d.id.slice(0, 12)}`,
        createdAt: d.createdAt,
        updatedAt: d.createdAt,
      });
    }
    // de-dupe by domain
    const seen = new Set<string>();
    return out.filter((d) => {
      if (seen.has(d.domain)) return false;
      seen.add(d.domain);
      return true;
    });
  }

  findMailAccountByAddress(address: string): MailAccount | undefined {
    return this.data.mailAccounts.find((a) => a.address === address.toLowerCase());
  }

  findMailAccountById(id: string): MailAccount | undefined {
    return this.data.mailAccounts.find((a) => a.id === id);
  }

  findMailAccountByTenant(tenant: string): MailAccount | undefined {
    return this.data.mailAccounts.find((a) => a.tenant === tenant.toLowerCase());
  }

  async createMailAccount(opts: {
    address: string;
    password: string;
    expiresAt: string | null;
    tenant: string;
  }): Promise<MailAccount> {
    const address = opts.address.toLowerCase().trim();
    if (this.findMailAccountByAddress(address)) {
      throw new Error("email address already exists");
    }
    let tenant = slugify(opts.tenant) || id("t").slice(0, 10);
    // ensure tenant unique among users + mail accounts
    if (this.findUserByTenant(tenant) || this.findMailAccountByTenant(tenant)) {
      tenant = `${tenant}-${randomBytes(2).toString("hex")}`;
    }
    const now = new Date().toISOString();
    const account: MailAccount = {
      id: id("ma").replace(/^ma/, "") || randomBytes(16).toString("hex"),
      address,
      passwordHash: hashPassword(opts.password),
      tenant,
      status: "active",
      expiresAt: opts.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    // prefer pure hex-ish ids like duckmail
    account.id = randomBytes(16).toString("hex");
    this.data.mailAccounts.push(account);
    await this.queueWrite();
    return account;
  }

  async deleteMailAccount(accountId: string): Promise<boolean> {
    const before = this.data.mailAccounts.length;
    this.data.mailAccounts = this.data.mailAccounts.filter((a) => a.id !== accountId);
    this.data.mailTokens = this.data.mailTokens.filter((t) => t.accountId !== accountId);
    if (this.data.mailAccounts.length === before) return false;
    await this.queueWrite();
    return true;
  }

  async createMailToken(accountId: string, days = 365): Promise<string> {
    // opaque token (not JWT) — still works as Bearer for clients
    const token = `tm_${randomBytes(32).toString("base64url")}`;
    const entry: MailToken = {
      token,
      accountId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + days * 86400_000).toISOString(),
    };
    this.data.mailTokens.push(entry);
    // prune expired
    const now = Date.now();
    this.data.mailTokens = this.data.mailTokens.filter((t) => Date.parse(t.expiresAt) > now);
    // limit tokens per account
    const mine = this.data.mailTokens.filter((t) => t.accountId === accountId);
    if (mine.length > 20) {
      const drop = mine
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .slice(0, mine.length - 20)
        .map((t) => t.token);
      this.data.mailTokens = this.data.mailTokens.filter((t) => !drop.includes(t.token));
    }
    await this.queueWrite();
    return token;
  }

  getMailAccountByToken(token: string): MailAccount | undefined {
    const now = Date.now();
    const t = this.data.mailTokens.find(
      (x) => x.token === token && Date.parse(x.expiresAt) > now,
    );
    if (!t) return undefined;
    return this.findMailAccountById(t.accountId);
  }

  /**
   * Resolve DuckMail / AI-native API key.
   * - user keys (userApiKeys): scoped to that user + scopes
   * - global settings.apiKeys (env seed): full access, all private domains
   */
  resolveApiKey(key: string): {
    ok: boolean;
    userId: string | null;
    global: boolean;
    keyId: string | null;
    keyName: string | null;
    scopes: ApiKeyScope[];
  } {
    if (!key || !key.startsWith("dk_")) {
      return {
        ok: false,
        userId: null,
        global: false,
        keyId: null,
        keyName: null,
        scopes: [],
      };
    }
    const userKey = this.data.userApiKeys.find(
      (k) => k.key === key && k.status !== "revoked",
    );
    if (userKey) {
      userKey.lastUsedAt = new Date().toISOString();
      void this.queueWrite();
      const scopes =
        Array.isArray(userKey.scopes) && userKey.scopes.length
          ? userKey.scopes
          : (["read", "write"] as ApiKeyScope[]);
      return {
        ok: true,
        userId: userKey.userId,
        global: false,
        keyId: userKey.id,
        keyName: userKey.name,
        scopes,
      };
    }
    if (this.data.settings.apiKeys.includes(key)) {
      return {
        ok: true,
        userId: null,
        global: true,
        keyId: null,
        keyName: "global",
        scopes: ["read", "write"],
      };
    }
    return {
      ok: false,
      userId: null,
      global: false,
      keyId: null,
      keyName: null,
      scopes: [],
    };
  }

  verifyApiKey(key: string): boolean {
    return this.resolveApiKey(key).ok;
  }

  listApiKeys(): string[] {
    return [...this.data.settings.apiKeys];
  }

  async addApiKey(key?: string): Promise<string> {
    const k = key || `dk_${randomBytes(24).toString("hex")}`;
    if (!k.startsWith("dk_")) throw new Error("API key must start with dk_");
    if (!this.data.settings.apiKeys.includes(k)) {
      this.data.settings.apiKeys.push(k);
      await this.queueWrite();
    }
    return k;
  }

  async removeApiKey(key: string): Promise<boolean> {
    const before = this.data.settings.apiKeys.length;
    this.data.settings.apiKeys = this.data.settings.apiKeys.filter((k) => k !== key);
    if (this.data.settings.apiKeys.length === before) return false;
    await this.queueWrite();
    return true;
  }

  // ---- per-user API keys ----

  listUserApiKeys(userId: string): Array<{
    id: string;
    name: string;
    scopes: ApiKeyScope[];
    status: "active" | "revoked";
    /** masked key for list UI */
    keyPreview: string;
    createdAt: string;
    lastUsedAt: string | null;
  }> {
    return this.data.userApiKeys
      .filter((k) => k.userId === userId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((k) => ({
        id: k.id,
        name: k.name,
        scopes: k.scopes?.length ? k.scopes : (["read", "write"] as ApiKeyScope[]),
        status: k.status === "revoked" ? "revoked" : "active",
        keyPreview: maskApiKey(k.key),
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt,
      }));
  }

  async createUserApiKey(
    userId: string,
    name = "",
    scopes: ApiKeyScope[] = ["read", "write"],
  ): Promise<{
    id: string;
    name: string;
    key: string;
    scopes: ApiKeyScope[];
    status: "active";
    createdAt: string;
  }> {
    const mine = this.data.userApiKeys.filter((k) => k.userId === userId);
    if (mine.length >= 20) throw new Error("每个用户最多 20 个 API Key");
    const cleanScopes = normalizeScopes(scopes);
    if (!cleanScopes.length) throw new Error("至少选择一个权限：read 或 write");
    const key = `dk_${randomBytes(24).toString("hex")}`;
    const item: UserApiKey = {
      id: id("ak"),
      userId,
      key,
      name: (name || "default").slice(0, 64),
      scopes: cleanScopes,
      status: "active",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.data.userApiKeys.push(item);
    await this.queueWrite();
    return {
      id: item.id,
      name: item.name,
      key: item.key,
      scopes: item.scopes,
      status: "active",
      createdAt: item.createdAt,
    };
  }

  async updateUserApiKey(
    userId: string,
    keyId: string,
    patch: Partial<{ name: string; scopes: ApiKeyScope[]; status: "active" | "revoked" }>,
  ): Promise<UserApiKey | null> {
    const item = this.data.userApiKeys.find((k) => k.userId === userId && k.id === keyId);
    if (!item) return null;
    if (patch.name !== undefined) item.name = String(patch.name).slice(0, 64);
    if (patch.scopes) {
      const s = normalizeScopes(patch.scopes);
      if (!s.length) throw new Error("至少选择一个权限：read 或 write");
      item.scopes = s;
    }
    if (patch.status === "active" || patch.status === "revoked") item.status = patch.status;
    await this.queueWrite();
    return item;
  }

  async deleteUserApiKey(userId: string, keyId: string): Promise<boolean> {
    const before = this.data.userApiKeys.length;
    this.data.userApiKeys = this.data.userApiKeys.filter(
      (k) => !(k.userId === userId && k.id === keyId),
    );
    if (this.data.userApiKeys.length === before) return false;
    await this.queueWrite();
    return true;
  }

  // ---- API call history ----

  async addApiCallLog(entry: {
    userId: string;
    apiKeyId?: string | null;
    apiKeyName?: string | null;
    method: string;
    path: string;
    status: number;
    durationMs: number;
    ip?: string;
    userAgent?: string;
    error?: string;
  }): Promise<ApiCallLog> {
    const log: ApiCallLog = {
      id: id("cl"),
      userId: entry.userId,
      apiKeyId: entry.apiKeyId ?? null,
      apiKeyName: entry.apiKeyName ?? null,
      method: entry.method.toUpperCase(),
      path: entry.path.slice(0, 500),
      status: entry.status,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
      ip: entry.ip,
      userAgent: entry.userAgent?.slice(0, 300),
      error: entry.error?.slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    this.data.apiCallLogs.unshift(log);
    // keep last 5000 per installation
    if (this.data.apiCallLogs.length > 5000) {
      this.data.apiCallLogs = this.data.apiCallLogs.slice(0, 5000);
    }
    await this.queueWrite();
    return log;
  }

  listApiCallLogs(
    userId: string,
    opts: { q?: string; page?: number; pageSize?: number } = {},
  ): {
    items: ApiCallLog[];
    total: number;
    page: number;
    pageSize: number;
  } {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize || 20));
    let items = this.data.apiCallLogs.filter((l) => l.userId === userId);
    if (opts.q) {
      const q = opts.q.toLowerCase();
      items = items.filter(
        (l) =>
          l.path.toLowerCase().includes(q) ||
          l.method.toLowerCase().includes(q) ||
          (l.apiKeyName || "").toLowerCase().includes(q) ||
          String(l.status).includes(q),
      );
    }
    const total = items.length;
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total, page, pageSize };
  }

  private flagKey(tenant: string, mailId: string): string {
    return `${tenant}|${mailId}`;
  }

  getMessageFlags(tenant: string, mailId: string): MessageFlags {
    return (
      this.data.messageFlags[this.flagKey(tenant, mailId)] || {
        seen: false,
        deleted: false,
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  async setMessageFlags(
    tenant: string,
    mailId: string,
    patch: Partial<Pick<MessageFlags, "seen" | "deleted">>,
  ): Promise<MessageFlags> {
    const key = this.flagKey(tenant, mailId);
    const cur = this.getMessageFlags(tenant, mailId);
    const next: MessageFlags = {
      seen: patch.seen ?? cur.seen,
      deleted: patch.deleted ?? cur.deleted,
      updatedAt: new Date().toISOString(),
    };
    this.data.messageFlags[key] = next;
    await this.queueWrite();
    return next;
  }

  async listMailsForAccount(
    account: MailAccount,
    opts: { page?: number; pageSize?: number; includeDeleted?: boolean } = {},
  ): Promise<{ items: MailMeta[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize || 30));
    // list by tenant storage
    const all = await this.listMails(account.tenant, { page: 1, pageSize: 10000 });
    let items = all.items;
    if (!opts.includeDeleted) {
      items = items.filter((m) => !this.getMessageFlags(account.tenant, m.id).deleted);
    }
    const total = items.length;
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total, page, pageSize };
  }

  /** Whether inbound tenant is allowed (SaaS user OR DuckMail mailbox) */
  isKnownTenant(tenant: string): boolean {
    return Boolean(this.findUserByTenant(tenant) || this.findMailAccountByTenant(tenant));
  }
}
