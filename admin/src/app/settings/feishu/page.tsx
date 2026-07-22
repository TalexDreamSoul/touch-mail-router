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
} from "@cloudflare/kumo";
import { useRouter } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, formatDate } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useStableToast } from "@/lib/toast";

const emptyForm = {
  enabled: false,
  appId: "",
  appSecret: "",
  encryptKey: "",
  verificationToken: "",
  notifyChatId: "",
  notifyOnInbound: false,
  oauthRedirectUri: "",
  appSecretSet: false,
  encryptKeySet: false,
  verificationTokenSet: false,
};

export default function FeishuSettingsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const toast = useStableToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);
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

    let cancelled = false;
    setLoading(true);
    api
      .feishuSettings()
      .then((res) => {
        if (cancelled) return;
        const s = res.settings;
        setForm({
          enabled: Boolean(s.enabled),
          appId: s.appId || "",
          appSecret: "",
          encryptKey: "",
          verificationToken: "",
          notifyChatId: s.notifyChatId || "",
          notifyOnInbound: Boolean(s.notifyOnInbound),
          oauthRedirectUri: s.oauthRedirectUri || "",
          appSecretSet: Boolean(s.appSecretSet),
          encryptKeySet: Boolean(s.encryptKeySet),
          verificationTokenSet: Boolean(s.verificationTokenSet),
        });
        setMeta({ updatedAt: s.updatedAt, updatedBy: s.updatedBy });
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error("加载失败", e instanceof Error ? e.message : "");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.role, router, toast]);

  async function save() {
    setSaving(true);
    try {
      const res = await api.saveFeishuSettings({
        enabled: form.enabled,
        appId: form.appId,
        appSecret: form.appSecret,
        encryptKey: form.encryptKey,
        verificationToken: form.verificationToken,
        notifyChatId: form.notifyChatId,
        notifyOnInbound: form.notifyOnInbound,
        oauthRedirectUri: form.oauthRedirectUri,
      });
      const s = res.settings;
      setForm((prev) => ({
        ...prev,
        enabled: Boolean(s.enabled),
        appId: s.appId || "",
        appSecret: "",
        encryptKey: "",
        verificationToken: "",
        notifyChatId: s.notifyChatId || "",
        notifyOnInbound: Boolean(s.notifyOnInbound),
        oauthRedirectUri: s.oauthRedirectUri || "",
        appSecretSet: Boolean(s.appSecretSet),
        encryptKeySet: Boolean(s.encryptKeySet),
        verificationTokenSet: Boolean(s.verificationTokenSet),
      }));
      setMeta({ updatedAt: s.updatedAt, updatedBy: s.updatedBy });
      toast.success("飞书配置已保存");
    } catch (e) {
      toast.error("保存失败", e instanceof Error ? e.message : "");
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

      <Banner
        variant="default"
        title="密钥说明"
        description="密钥字段留空则不会覆盖已保存的值。请在飞书开放平台创建企业自建应用后填写 App ID / Secret。"
      />

      <LayerCard className="mt-4">
        <LayerCard.Primary>
          {loading ? (
            <Text variant="secondary">加载中…</Text>
          ) : (
            <div className="flex max-w-xl flex-col gap-4">
              <Switch
                label="启用飞书集成"
                checked={form.enabled}
                onCheckedChange={(v) => setForm({ ...form, enabled: v })}
              />
              <Input
                label="App ID"
                value={form.appId}
                onChange={(e) => setForm({ ...form, appId: e.target.value })}
                placeholder="cli_xxxxxxxx"
              />
              <SensitiveInput
                label="App Secret"
                value={form.appSecret}
                onValueChange={(v) => setForm({ ...form, appSecret: v })}
                placeholder={form.appSecretSet ? "已配置，输入新值可覆盖" : "未配置"}
              />
              <SensitiveInput
                label="Encrypt Key"
                value={form.encryptKey}
                onValueChange={(v) => setForm({ ...form, encryptKey: v })}
                placeholder={form.encryptKeySet ? "已配置" : "事件订阅加密"}
              />
              <SensitiveInput
                label="Verification Token"
                value={form.verificationToken}
                onValueChange={(v) => setForm({ ...form, verificationToken: v })}
                placeholder={form.verificationTokenSet ? "已配置" : "事件校验"}
              />
              <Input
                label="通知群 Chat ID"
                value={form.notifyChatId}
                onChange={(e) => setForm({ ...form, notifyChatId: e.target.value })}
                placeholder="oc_xxxxxxxx"
              />
              <Switch
                label="入站邮件时推送飞书通知"
                checked={form.notifyOnInbound}
                onCheckedChange={(v) => setForm({ ...form, notifyOnInbound: v })}
              />
              <Input
                label="OAuth Redirect URI"
                value={form.oauthRedirectUri}
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
        </LayerCard.Primary>
      </LayerCard>
    </AdminShell>
  );
}
