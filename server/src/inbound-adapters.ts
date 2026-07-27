import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { AppDb, ReceiveChannel } from "./db.js";

export interface ApiInboundAttachment {
  id?: string;
  filename?: string;
  mimeType?: string;
  contentType?: string;
  contentBase64?: string;
  stored?: boolean;
}

export interface ApiInboundMail {
  id?: string;
  messageId?: string;
  from: string;
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  receivedAt?: string;
  attachments?: ApiInboundAttachment[];
}

export function resolveLegacyInboundRecipient(
  address: string,
  inboundDomain: string,
): { tenant: string } | null {
  const normalized = address.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return null;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (domain !== inboundDomain.trim().toLowerCase()) return null;
  const tenant = local.split("+", 1)[0];
  return tenant ? { tenant } : null;
}

export type InboundMailNotifier = (mail: {
  id: string;
  tenant: string;
  channel: string;
  from: string;
  to: string;
  subject: string;
}) => Promise<void>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function usesDoneMail(channel: ReceiveChannel): boolean {
  return channel.type === "donemail" ||
    (channel.type === "email_forward" && channel.collectorType === "donemail");
}

function resolveChannelRecipient(
  db: AppDb,
  channel: ReceiveChannel,
  address: string,
): { tenant: string } | null {
  const domain = db.findDomainByAddress(address);
  if (domain?.receiveChannelId === channel.id) {
    const user = db.findUserById(domain.userId);
    return user?.status === "active" ? { tenant: user.tenant } : null;
  }
  if (channel.type === "email_forward") {
    const forwarded = db.resolveForwardedRecipient(channel.id, address);
    return forwarded ? { tenant: forwarded.user.tenant } : null;
  }
  return null;
}

type DoneMailResponse = {
  ok?: boolean;
  data?: Array<ApiInboundMail & { toDomain?: string }>;
  pagination?: { nextCursor?: string; hasMore?: boolean };
  error?: { message?: string };
};

function sourceMessageId(channel: ReceiveChannel, payload: ApiInboundMail): string {
  const sourceId = String(payload.messageId || payload.id || "").trim();
  if (!sourceId) throw new Error("邮件缺少 id 或 messageId");
  return `<${channel.id}.${Buffer.from(sourceId).toString("base64url")}@touch-mail>`;
}

async function composeRawMail(
  payload: ApiInboundMail,
  messageId: string,
  attachments: Array<{ filename: string; contentType: string; content: Buffer }>,
): Promise<Buffer> {
  const date = payload.receivedAt ? new Date(payload.receivedAt) : new Date();
  const composer = new MailComposer({
    from: payload.from,
    to: payload.to,
    subject: payload.subject || "",
    text: payload.text || "",
    html: payload.html || undefined,
    date: Number.isNaN(date.getTime()) ? new Date() : date,
    messageId,
    headers: { "x-touch-mail-imported": "1" },
    attachments,
  });
  return composer.compile().build();
}

function decodeInlineAttachments(
  attachments: ApiInboundAttachment[],
  maxBodyBytes: number,
): Array<{ filename: string; contentType: string; content: Buffer }> {
  const result: Array<{ filename: string; contentType: string; content: Buffer }> = [];
  let total = 0;
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment.contentBase64) continue;
    const content = Buffer.from(attachment.contentBase64, "base64");
    total += content.byteLength;
    if (total > maxBodyBytes) throw new Error("附件总大小超过入站限制");
    result.push({
      filename: attachment.filename || `attachment-${index + 1}`,
      contentType: attachment.mimeType || attachment.contentType || "application/octet-stream",
      content,
    });
  }
  return result;
}

export async function ingestApiMail(
  db: AppDb,
  channel: ReceiveChannel,
  payload: ApiInboundMail,
  maxBodyBytes: number,
  preparedAttachments?: Array<{ filename: string; contentType: string; content: Buffer }>,
  notify?: InboundMailNotifier,
): Promise<{ id: string; duplicate: boolean; tenant: string }> {
  const from = String(payload.from || "").trim();
  const to = String(payload.to || "").trim().toLowerCase();
  if (!from || !to.includes("@")) throw new Error("邮件 from/to 格式不正确");
  const recipient = resolveChannelRecipient(db, channel, to);
  if (!recipient) throw new Error("收件地址未绑定到该接收渠道");
  const tenant = recipient.tenant;

  const messageId = sourceMessageId(channel, payload);
  const attachments =
    preparedAttachments || decodeInlineAttachments(payload.attachments || [], maxBodyBytes);
  const raw = await composeRawMail(payload, messageId, attachments);
  if (raw.byteLength > maxBodyBytes) throw new Error("邮件大小超过入站限制");

  const { meta, duplicate } = await db.saveMail({
    tenant,
    channel: channel.name,
    from,
    to,
    subject: String(payload.subject || ""),
    messageId,
    raw,
    parsed: {
      text: String(payload.text || ""),
      html: String(payload.html || ""),
      date: payload.receivedAt ? new Date(payload.receivedAt) : undefined,
      headers: {
        "x-touch-mail-source-channel": channel.id,
        "x-touch-mail-source-id": String(payload.id || payload.messageId || ""),
      },
      attachments: attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.content.byteLength,
      })),
    },
  });
  if (!duplicate && notify) {
    void notify({
      id: meta.id,
      tenant,
      channel: channel.name,
      from,
      to,
      subject: String(payload.subject || ""),
    }).catch((error) => console.error("inbound notification failed", error));
  }
  return { id: meta.id, duplicate, tenant };
}

function doneMailListUrl(channel: ReceiveChannel, cursor = ""): URL {
  const url = new URL(`${channel.baseUrl.replace(/\/$/, "")}/api/mails`);
  url.searchParams.set("limit", "20");
  url.searchParams.set("includeAttachments", "true");
  if (cursor) url.searchParams.set("cursor", cursor);
  return url;
}

async function fetchDoneMailPage(
  channel: ReceiveChannel,
  cursor: string,
  fetchImpl: FetchLike,
): Promise<DoneMailResponse> {
  const response = await fetchImpl(doneMailListUrl(channel, cursor), {
    headers: { "X-Admin-Key": channel.adminKey },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as DoneMailResponse;
  if (!response.ok || body.ok !== true || !Array.isArray(body.data)) {
    throw new Error(body.error?.message || `DoneMail API 返回 HTTP ${response.status}`);
  }
  return body;
}

export async function testDoneMailConnection(
  channel: ReceiveChannel,
  fetchImpl: FetchLike = fetch,
): Promise<{ mailCount: number }> {
  if (!usesDoneMail(channel)) throw new Error("该渠道未使用 DoneMail API");
  const page = await fetchDoneMailPage(channel, "", fetchImpl);
  return { mailCount: page.data?.length || 0 };
}

async function downloadDoneMailAttachments(
  channel: ReceiveChannel,
  mail: ApiInboundMail,
  maxBodyBytes: number,
  fetchImpl: FetchLike,
): Promise<Array<{ filename: string; contentType: string; content: Buffer }>> {
  const result: Array<{ filename: string; contentType: string; content: Buffer }> = [];
  let total = 0;
  for (const [index, attachment] of (mail.attachments || []).entries()) {
    if (!attachment.stored || !attachment.id || !mail.id) continue;
    const url = `${channel.baseUrl.replace(/\/$/, "")}/api/mails/${encodeURIComponent(mail.id)}/attachments/${encodeURIComponent(attachment.id)}`;
    const response = await fetchImpl(url, {
      headers: { "X-Admin-Key": channel.adminKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`DoneMail 附件下载失败：HTTP ${response.status}`);
    const content = Buffer.from(await response.arrayBuffer());
    total += content.byteLength;
    if (total > maxBodyBytes) throw new Error("DoneMail 附件总大小超过入站限制");
    result.push({
      filename: attachment.filename || `attachment-${index + 1}`,
      contentType:
        attachment.mimeType || attachment.contentType || response.headers.get("content-type") || "application/octet-stream",
      content,
    });
  }
  return result;
}

export async function syncDoneMailChannel(
  db: AppDb,
  channel: ReceiveChannel,
  maxBodyBytes: number,
  fetchImpl: FetchLike = fetch,
  notify?: InboundMailNotifier,
): Promise<{ imported: number; duplicates: number; skipped: number }> {
  if (!usesDoneMail(channel) || !channel.enabled) {
    throw new Error("DoneMail 收集方式未启用");
  }
  let cursor = "";
  let imported = 0;
  let duplicates = 0;
  let skipped = 0;
  try {
    for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
      const page = await fetchDoneMailPage(channel, cursor, fetchImpl);
      let reachedExisting = false;
      for (const mail of page.data || []) {
        if (mail.receivedAt && Date.parse(mail.receivedAt) < Date.parse(channel.createdAt)) {
          skipped += 1;
          reachedExisting = true;
          continue;
        }
        const recipient = resolveChannelRecipient(db, channel, mail.to || "");
        if (!recipient) {
          skipped += 1;
          continue;
        }
        const messageId = sourceMessageId(channel, mail);
        if (await db.existsByMessageId(recipient.tenant, messageId)) {
          duplicates += 1;
          reachedExisting = true;
          continue;
        }
        const attachments = await downloadDoneMailAttachments(
          channel,
          mail,
          maxBodyBytes,
          fetchImpl,
        );
        const result = await ingestApiMail(
          db,
          channel,
          mail,
          maxBodyBytes,
          attachments,
          notify,
        );
        if (result.duplicate) duplicates += 1;
        else imported += 1;
      }
      const nextCursor = page.pagination?.nextCursor || "";
      if (reachedExisting || !page.pagination?.hasMore || !nextCursor) break;
      cursor = nextCursor;
    }
    await db.markReceiveChannelSync(channel.id);
    return { imported, duplicates, skipped };
  } catch (error) {
    await db.markReceiveChannelSync(
      channel.id,
      error instanceof Error ? error.message : "DoneMail 同步失败",
    );
    throw error;
  }
}

export function startDoneMailScheduler(
  db: AppDb,
  maxBodyBytes: number,
  notify?: InboundMailNotifier,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      for (const channel of db.listReceiveChannels().filter(usesDoneMail)) {
        const lastSync = channel.lastSyncAt ? Date.parse(channel.lastSyncAt) : 0;
        if (now - lastSync < channel.pollIntervalSeconds * 1000) continue;
        await syncDoneMailChannel(db, channel, maxBodyBytes, fetch, notify).catch((error) => {
          console.error("donemail sync failed", channel.id, error);
        });
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 15_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
