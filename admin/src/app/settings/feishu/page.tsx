"use client";

import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  Input,
  LayerCard,
  SensitiveInput,
  Switch,
  Text,
  useKumoToastManager,
} from "@cloudflare/kumo";
import { useRouter } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, formatDate, type FeishuSettings } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function FeishuSettingsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const toast = useKumoToastManager();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Partial<FeishuSettings>>({
    enabled: false,
    appId: "",
    appSecret: "",
    encryptKey: "",
    verificationToken: "",
    notifyChatId: "",
    notifyOnInbound: false,
    oauthRedirectUri: "",
  });
  const [meta, setMeta] = useState<{ updatedAt: string | null; updatedBy: string | null }>({
    updatedAt: null,
    updatedBy: null,
  });

  useEffect(() => {
    if (user && user.role !== "admin") {
      router.replace("/dashboard");
      return;
    }
    if (user?.role !== "admin") return;
    api
      .feishuSettings()
      .then((res) => {
        setForm(res.settings);
        setMeta({ updatedAt: res.settings.updatedAt, updatedBy: res.settings.updatedBy });
      })
      .catch((e) =>
        toast.add({
          title: "加载失败",
          description: e instanceof Error ? e.message : "",
        }),
      )
      .finally(() => setLoading(false));
  }, [user, router, toast]);

  async function save() {
    setSaving(true);
    try {
      const res = await api.saveFeishuSettings({
        enabled: Boolean(form.enabled),
        appId: form.appId,
        appSecret: form.appSecret,
        encryptKey: form.encryptKey,
        verificationToken: form.verificationToken,
        notifyChatId: form.notifyChatId,
        notifyOnInbound: Boolean(form.notifyOnInbound),
        oauthRedirectUri: form.oauthRedirectUri,
      });
      setForm(res.settings);
      setMeta({ updatedAt: res.settings.updatedAt, updatedBy: res.settings.updatedBy });
      toast.add({ title: "飞书配置已保存" });
    } catch (e) {
      toast.add({
        title: "保存失败",
        description: e instanceof Error ? e.message : "",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminShell>
      <PageHeader
        title="飞书 SaaS 配置"
        description="配置飞书开放平台应用，用于后续通知、OAuth 与企业集成"
        actions={
          <Button loading={saving || loading} onClick={() => void save()}>
            保存配置
          </Button>
        }
      />

      <Banner variant="default" className="mb-4">
        密钥字段留空或保持掩码则不会覆盖已保存的值。请在飞书开放平台创建企业自建应用后填写
        App ID / Secret。
      </Banner>

      <LayerCard className="p-6">
        {loading ? (
          <Text variant="secondary">加载中…</Text>
        ) : (
          <div className="flex max-w-xl flex-col gap-4">
            <Switch
              label="启用飞书集成"
              checked={Boolean(form.enabled)}
              onCheckedChange={(v) => setForm({ ...form, enabled: v })}
            />
            <Input
              label="App ID"
              value={form.appId || ""}
              onChange={(e) => setForm({ ...form, appId: e.target.value })}
              placeholder="cli_xxxxxxxx"
            />
            <SensitiveInput
              label="App Secret"
              value={form.appSecret || ""}
              onChange={(e) => setForm({ ...form, appSecret: e.target.value })}
              placeholder={form.appSecretSet ? "已配置，输入新值可覆盖" : "未配置"}
            />
            <SensitiveInput
              label="Encrypt Key"
              value={form.encryptKey || ""}
              onChange={(e) => setForm({ ...form, encryptKey: e.target.value })}
              placeholder={form.encryptKeySet ? "已配置" : "事件订阅加密"}
            />
            <SensitiveInput
              label="Verification Token"
              value={form.verificationToken || ""}
              onChange={(e) => setForm({ ...form, verificationToken: e.target.value })}
              placeholder={form.verificationTokenSet ? "已配置" : "事件校验"}
            />
            <Input
              label="通知群 Chat ID"
              value={form.notifyChatId || ""}
              onChange={(e) => setForm({ ...form, notifyChatId: e.target.value })}
              placeholder="oc_xxxxxxxx"
            />
            <Switch
              label="入站邮件时推送飞书通知"
              checked={Boolean(form.notifyOnInbound)}
              onCheckedChange={(v) => setForm({ ...form, notifyOnInbound: v })}
            />
            <Input
              label="OAuth Redirect URI"
              value={form.oauthRedirectUri || ""}
              onChange={(e) => setForm({ ...form, oauthRedirectUri: e.target.value })}
              placeholder="https://mail.example.com/oauth/feishu/callback"
            />
            {meta.updatedAt ? (
              <Text variant="secondary" size="sm">
                上次更新：{formatDate(meta.updatedAt)}
                {meta.updatedBy ? ` · ${meta.updatedBy}` : ""}
              </Text>
            ) : null}
          </div>
        )}
      </LayerCard>
    </AdminShell>
  );
}
