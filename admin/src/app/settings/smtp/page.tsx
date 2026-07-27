"use client";

import { useEffect, useState } from "react";
import { Banner, Button, Input, LayerCard, SensitiveInput, Switch, Text } from "@cloudflare/kumo";
import { FlaskIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, formatDate, type SmtpSettings } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useStableToast } from "@/lib/toast";

const emptyForm: SmtpSettings = {
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
  passwordSet: false,
};

export default function SmtpSettingsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const toast = useStableToast();
  const [form, setForm] = useState<SmtpSettings>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (user && user.role !== "admin") {
      router.replace("/dashboard");
      return;
    }
    if (user?.role !== "admin") return;
    api
      .smtpSettings()
      .then(({ settings }) => setForm({ ...settings, password: "" }))
      .catch((error) => toast.error("加载失败", error instanceof Error ? error.message : ""))
      .finally(() => setLoading(false));
  }, [user, router, toast]);

  async function save() {
    setSaving(true);
    try {
      const { settings } = await api.saveSmtpSettings(form);
      setForm({ ...settings, password: "" });
      toast.success("SMTP 配置已保存");
    } catch (error) {
      toast.error("保存失败", error instanceof Error ? error.message : "");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    try {
      await api.testSmtpSettings(form);
      toast.success("SMTP 连接正常", "服务器已通过认证并可接收发信请求");
    } catch (error) {
      toast.error("连接失败", error instanceof Error ? error.message : "");
    } finally {
      setTesting(false);
    }
  }

  return (
    <AdminShell>
      <PageHeader
        title="SMTP 配置"
        description="管理员统一配置出站邮件；普通用户与域名接入测试共用此通道"
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              icon={FlaskIcon}
              loading={testing}
              disabled={loading}
              onClick={() => void testConnection()}
            >
              测试连接
            </Button>
            <Button loading={saving} disabled={loading} onClick={() => void save()}>
              保存配置
            </Button>
          </div>
        }
      />
      <Banner
        className="mb-4"
        variant="secondary"
        title="域名测试依赖 SMTP"
        description="启用后，域名接入向导会自动向该域发送测试邮件，并等待邮件从所选收件渠道回到系统。"
      />
      <LayerCard>
        <LayerCard.Secondary>连接与发件身份</LayerCard.Secondary>
        <LayerCard.Primary>
          <div className="flex max-w-2xl flex-col gap-4">
            <Switch
              label="启用 SMTP 发信"
              checked={form.enabled}
              onCheckedChange={(enabled) => setForm({ ...form, enabled })}
            />
            <Input
              label="SMTP Host"
              value={form.host}
              onChange={(event) => setForm({ ...form, host: event.target.value })}
              placeholder="smtp.example.com"
            />
            <Input
              label="SMTP Port"
              type="number"
              min={1}
              max={65535}
              value={String(form.port)}
              onChange={(event) => setForm({ ...form, port: Number(event.target.value) || 587 })}
            />
            <Switch
              label="使用隐式 TLS"
              checked={form.secure}
              onCheckedChange={(secure) => setForm({ ...form, secure })}
            />
            <Input
              label="用户名"
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              placeholder="mailer@example.com"
            />
            <SensitiveInput
              label="密码"
              description={form.passwordSet ? "密码已保存；留空不会覆盖" : "填写 SMTP 密码或授权码"}
              value={form.password}
              onValueChange={(password) => setForm({ ...form, password })}
              placeholder={form.passwordSet ? "已配置" : "SMTP 密码或授权码"}
            />
            <Input
              label="发件邮箱"
              type="email"
              value={form.fromAddress}
              onChange={(event) => setForm({ ...form, fromAddress: event.target.value })}
              placeholder="mailer@example.com"
            />
            <Input
              label="发件人名称"
              value={form.fromName}
              onChange={(event) => setForm({ ...form, fromName: event.target.value })}
              placeholder="Touch Mail"
            />
            <Input
              label="Reply-To（可选）"
              type="email"
              value={form.replyTo}
              onChange={(event) => setForm({ ...form, replyTo: event.target.value })}
              placeholder="support@example.com"
            />
            <Text variant="secondary" size="sm">
              最近更新：{formatDate(form.updatedAt)} · {form.updatedBy || "—"}
            </Text>
          </div>
        </LayerCard.Primary>
      </LayerCard>
    </AdminShell>
  );
}
