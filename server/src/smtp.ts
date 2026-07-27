import nodemailer from "nodemailer";
import type { SmtpSettings } from "./db.js";

function createTransport(settings: SmtpSettings) {
  if (!settings.host) throw new Error("请配置 SMTP Host");
  if (!settings.port) throw new Error("请配置 SMTP Port");
  if (!settings.fromAddress) throw new Error("请配置发件邮箱");
  if ((settings.username && !settings.password) || (!settings.username && settings.password)) {
    throw new Error("SMTP 用户名和密码必须同时配置");
  }
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: settings.username
      ? {
          user: settings.username,
          pass: settings.password,
        }
      : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

export async function verifySmtpSettings(settings: SmtpSettings): Promise<void> {
  const transport = createTransport(settings);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export async function sendSmtpMail(
  settings: SmtpSettings,
  mail: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    headers?: Record<string, string>;
  },
): Promise<{ messageId: string; accepted: string[]; rejected: string[] }> {
  if (!settings.enabled) throw new Error("管理员尚未启用 SMTP 发信");
  const transport = createTransport(settings);
  try {
    const info = await transport.sendMail({
      from: settings.fromName
        ? { name: settings.fromName, address: settings.fromAddress }
        : settings.fromAddress,
      replyTo: settings.replyTo || undefined,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      headers: mail.headers,
    });
    return {
      messageId: info.messageId,
      accepted: (info.accepted || []).map(String),
      rejected: (info.rejected || []).map(String),
    };
  } finally {
    transport.close();
  }
}
