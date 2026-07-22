import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename, appendFile } from "node:fs/promises";
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

export interface Domain {
  id: string;
  userId: string;
  domain: string;
  note: string;
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
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

interface DbShape {
  users: User[];
  domains: Domain[];
  sessions: Session[];
  auditLogs: AuditLog[];
  settings: {
    feishu: FeishuSettings;
  };
}

function id(prefix = ""): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
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

export class AppDb {
  private file: string;
  private data: DbShape = {
    users: [],
    domains: [],
    sessions: [],
    auditLogs: [],
    settings: { feishu: defaultFeishu() },
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
      const parsed = JSON.parse(raw) as Partial<DbShape>;
      this.data = {
        users: parsed.users || [],
        domains: parsed.domains || [],
        sessions: parsed.sessions || [],
        auditLogs: parsed.auditLogs || [],
        settings: {
          feishu: { ...defaultFeishu(), ...(parsed.settings?.feishu || {}) },
        },
      };
      // migrate legacy users without role/status
      for (const u of this.data.users) {
        if (!u.role) u.role = "user";
        if (!u.status) u.status = "active";
        if (!u.updatedAt) u.updatedAt = u.createdAt;
      }
      // first user becomes admin if none
      if (this.data.users.length && !this.data.users.some((u) => u.role === "admin")) {
        this.data.users[0].role = "admin";
      }
    } catch {
      await this.persist();
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

  async addDomain(userId: string, domainRaw: string, note = ""): Promise<Domain> {
    const domain = domainRaw
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\.$/, "");
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) {
      throw new Error("域名格式不正确");
    }
    const exists = this.data.domains.find((d) => d.userId === userId && d.domain === domain);
    if (exists) throw new Error("该域名已添加");

    const item: Domain = {
      id: id("d"),
      userId,
      domain,
      note: note.slice(0, 200),
      createdAt: new Date().toISOString(),
    };
    this.data.domains.push(item);
    await this.queueWrite();
    return item;
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
      .update([opts.tenant, opts.messageId || "", opts.from, opts.to, String(opts.raw.length), receivedAt].join("|"))
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
      await writeFile(path.join(this.dataDir, "index", `${key}.id`), mid, "utf8");
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
}
