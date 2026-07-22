import { simpleParser, type ParsedMail, type Attachment } from "mailparser";

export interface ParsedInbound {
  text: string;
  html: string;
  subject: string;
  from: string;
  to: string[];
  messageId: string;
  date?: Date;
  headers: Record<string, string>;
  attachments: Array<{
    filename?: string;
    contentType?: string;
    size: number;
    contentId?: string;
  }>;
}

function addressList(value: ParsedMail["from"] | ParsedMail["to"]): string[] {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of arr) {
    if (!item) continue;
    if ("value" in item && Array.isArray(item.value)) {
      for (const v of item.value) {
        if (v.address) out.push(v.address);
      }
    }
  }
  return out;
}

function headersToObject(mail: ParsedMail): Record<string, string> {
  const out: Record<string, string> = {};
  if (!mail.headers) return out;
  for (const [key, value] of mail.headers) {
    if (value == null) continue;
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map(String).join(", ");
    else if (typeof value === "object" && value !== null && "text" in value) {
      out[key] = String((value as { text: string }).text);
    } else out[key] = String(value);
  }
  return out;
}

export async function parseRawEmail(raw: Buffer): Promise<ParsedInbound> {
  const mail = await simpleParser(raw, {
    skipHtmlToText: false,
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
  });

  const attachments = (mail.attachments || []).map((a: Attachment) => ({
    filename: a.filename,
    contentType: a.contentType,
    size: a.size,
    contentId: a.contentId,
  }));

  return {
    text: mail.text || "",
    html: typeof mail.html === "string" ? mail.html : "",
    subject: mail.subject || "",
    from: addressList(mail.from)[0] || "",
    to: addressList(mail.to),
    messageId: mail.messageId || "",
    date: mail.date,
    headers: headersToObject(mail),
    attachments,
  };
}
