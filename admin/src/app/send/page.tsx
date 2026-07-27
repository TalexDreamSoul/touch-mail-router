"use client";

import { useEffect, useState } from "react";
import { Banner, Button, Input, InputArea, LayerCard, Text } from "@cloudflare/kumo";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, type SmtpStatus } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useStableToast } from "@/lib/toast";

export default function SendMailPage() {
  const { user } = useAuth();
  const router = useRouter();
  const toast = useStableToast();
  const [smtp, setSmtp] = useState<SmtpStatus | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (user && user.role !== "admin") {
      router.replace("/dashboard");
      return;
    }
    if (user?.role !== "admin") return;
    api
      .smtpStatus()
      .then(setSmtp)
      .catch((error) => toast.error("无法读取 SMTP 状态", error instanceof Error ? error.message : ""));
  }, [user, router, toast]);

  async function send() {
    setSending(true);
    try {
      const result = await api.sendMail({ to, subject, text });
      toast.success("邮件已交给 SMTP 服务器", result.messageId);
      setSubject("");
      setText("");
    } catch (error) {
      toast.error("发送失败", error instanceof Error ? error.message : "");
    } finally {
      setSending(false);
    }
  }

  return (
    <AdminShell>
      <PageHeader title="发邮件" description="通过管理员配置的 SMTP 通道发送邮件" />
      {smtp && !smtp.enabled ? (
        <Banner
          className="mb-4"
          variant="alert"
          title="SMTP 尚未启用"
          description="请联系管理员完成 SMTP 配置后再发送。"
        />
      ) : null}
      <LayerCard>
        <LayerCard.Secondary>新邮件</LayerCard.Secondary>
        <LayerCard.Primary>
          <div className="flex max-w-2xl flex-col gap-4">
            <Text variant="secondary" size="sm">
              发件人：{smtp?.fromName || "—"} {smtp?.fromAddress ? `<${smtp.fromAddress}>` : ""}
            </Text>
            <Input
              label="收件人"
              type="email"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              placeholder="recipient@example.com"
              required
            />
            <Input
              label="主题"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="邮件主题"
              required
            />
            <InputArea
              label="正文"
              value={text}
              onValueChange={setText}
              minRows={10}
              maxRows={18}
              placeholder="输入邮件正文"
              required
            />
            <div>
              <Button
                icon={PaperPlaneTiltIcon}
                loading={sending}
                disabled={!smtp?.enabled || !to.trim() || !subject.trim() || !text.trim()}
                onClick={() => void send()}
              >
                发送邮件
              </Button>
            </div>
          </div>
        </LayerCard.Primary>
      </LayerCard>
    </AdminShell>
  );
}
