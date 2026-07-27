"use client";

import { useEffect, useState } from "react";
import {
  Banner,
  Button,
  CodeBlock,
  Combobox,
  Dialog,
  Input,
  LayerCard,
  SensitiveInput,
  Switch,
  Text,
} from "@cloudflare/kumo";
import { FlaskIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import {
  ApiError,
  api,
  formatDate,
  type FeishuChat,
  type FeishuTestFailureDetails,
} from "@/lib/api";
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

type TestFailure = {
  message: string;
  status?: number;
  details?: FeishuTestFailureDetails;
};

const ERROR_KIND_LABEL: Record<FeishuTestFailureDetails["kind"], string> = {
  validation: "配置校验失败",
  remote: "飞书接口返回错误",
  network: "网络连接失败",
  timeout: "请求超时",
};

export default function FeishuSettingsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const toast = useStableToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingNotification, setTestingNotification] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [chatOptions, setChatOptions] = useState<FeishuChat[]>([]);
  const [testFailure, setTestFailure] = useState<TestFailure | null>(null);
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

  function showTestFailure(error: unknown, toastTitle: string) {
    const details =
      error instanceof ApiError
        ? (error.data.details as FeishuTestFailureDetails | undefined)
        : undefined;
    setTestFailure({
      message: error instanceof Error ? error.message : toastTitle,
      status: error instanceof ApiError ? error.status : undefined,
      details,
    });
    toast.error(toastTitle, "已打开请求与响应详情");
  }

  async function testConnection() {
    setTesting(true);
    setTestFailure(null);
    try {
      await api.testFeishuSettings({
        appId: form.appId,
        appSecret: form.appSecret,
        notifyChatId: "",
      });
      toast.success("连接正常", "App ID 与 App Secret 可用");
    } catch (e) {
      showTestFailure(e, "连接测试失败");
    } finally {
      setTesting(false);
    }
  }

  async function testNotification() {
    if (!form.notifyChatId.trim()) {
      toast.error("请先填写或选择通知群 Chat ID");
      return;
    }
    setTestingNotification(true);
    setTestFailure(null);
    try {
      await api.testFeishuSettings({
        appId: form.appId,
        appSecret: form.appSecret,
        notifyChatId: form.notifyChatId,
      });
      toast.success("测试通知已发送", "请在目标群中确认消息");
    } catch (e) {
      showTestFailure(e, "通知测试失败");
    } finally {
      setTestingNotification(false);
    }
  }

  async function loadChats() {
    setLoadingChats(true);
    setTestFailure(null);
    try {
      const result = await api.listFeishuChats({
        appId: form.appId,
        appSecret: form.appSecret,
      });
      setChatOptions(result.items);
      setChatsLoaded(true);
      if (result.items.length === 0) {
        toast.error("没有可用群聊", "请确认机器人已加入目标群");
      }
    } catch (e) {
      showTestFailure(e, "获取群列表失败");
    } finally {
      setLoadingChats(false);
    }
  }

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
      />

      <Banner
        variant="default"
        title="密钥说明"
        description="连接测试只需要 App ID 和 App Secret；填写通知群 Chat ID 后会额外发送测试消息。Encrypt Key 与 Verification Token 仅用于事件订阅，可留空。密钥字段留空不会覆盖已保存值。"
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
                label="Encrypt Key（可选）"
                description="仅在飞书事件订阅启用加密时填写"
                value={form.encryptKey}
                onValueChange={(v) => setForm({ ...form, encryptKey: v })}
                placeholder={form.encryptKeySet ? "已配置，输入新值可覆盖" : "可留空"}
              />
              <SensitiveInput
                label="Verification Token（可选）"
                description="仅在接收飞书事件回调时填写"
                value={form.verificationToken}
                onValueChange={(v) => setForm({ ...form, verificationToken: v })}
                placeholder={form.verificationTokenSet ? "已配置，输入新值可覆盖" : "可留空"}
              />
              <Combobox
                label="通知群（可选）"
                description="展开后自动查询机器人可见群，可按群名或 Chat ID 检索"
                items={chatOptions}
                value={chatOptions.find((chat) => chat.chatId === form.notifyChatId) || null}
                onValueChange={(value) => {
                  const chat = value as FeishuChat | null;
                  setForm({ ...form, notifyChatId: chat?.chatId || "" });
                }}
                onOpenChange={(open) => {
                  if (open && !chatsLoaded && !loadingChats) void loadChats();
                }}
                isItemEqualToValue={(chat: FeishuChat, selected: FeishuChat) =>
                  chat.chatId === selected.chatId
                }
                itemToStringLabel={(chat: FeishuChat) => `${chat.name} ${chat.chatId}`}
                itemToStringValue={(chat: FeishuChat) => chat.chatId}
              >
                <Combobox.TriggerInput
                  placeholder={loadingChats ? "正在查询群列表…" : "搜索群名或 Chat ID"}
                  clearLabel="清除通知群"
                  showOptionsLabel="展开群列表"
                />
                <Combobox.Content className="max-h-72 overflow-y-auto">
                  <Combobox.Empty>
                    {loadingChats ? "正在查询…" : "没有匹配的群聊"}
                  </Combobox.Empty>
                  <Combobox.List>
                    {(chat: FeishuChat) => (
                      <Combobox.Item key={chat.chatId} value={chat}>
                        <div className="flex min-w-0 flex-col">
                          <Text size="sm">{chat.name}</Text>
                          <Text size="xs" variant="secondary">{chat.chatId}</Text>
                        </div>
                      </Combobox.Item>
                    )}
                  </Combobox.List>
                </Combobox.Content>
              </Combobox>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={PaperPlaneTiltIcon}
                  loading={testingNotification}
                  disabled={!form.notifyChatId.trim() || testing || loadingChats}
                  onClick={() => void testNotification()}
                >
                  测试通知
                </Button>
              </div>
              <Switch
                label="入站邮件时推送飞书通知"
                checked={form.notifyOnInbound}
                onCheckedChange={(v) => setForm({ ...form, notifyOnInbound: v })}
              />
              <Text size="xs" variant="secondary">
                需要先配置通知群 Chat ID
              </Text>
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
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                <Button
                  variant="secondary"
                  icon={FlaskIcon}
                  loading={testing}
                  disabled={loading || saving || testingNotification || loadingChats}
                  onClick={() => void testConnection()}
                >
                  测试连接
                </Button>
                <Button
                  loading={saving}
                  disabled={loading || testing || testingNotification || loadingChats}
                  onClick={() => void save()}
                >
                  保存配置
                </Button>
              </div>
            </div>
          )}
        </LayerCard.Primary>
      </LayerCard>

      <Dialog.Root
        open={Boolean(testFailure)}
        onOpenChange={(open) => {
          if (!open) setTestFailure(null);
        }}
      >
        <Dialog size="xl" className="max-h-[88vh] overflow-y-auto p-6">
          <Dialog.Title>飞书连接测试失败</Dialog.Title>
          {testFailure ? (
            <div className="mt-4 flex flex-col gap-4">
              <Banner
                variant="alert"
                title={
                  testFailure.details
                    ? ERROR_KIND_LABEL[testFailure.details.kind]
                    : "请求失败"
                }
                description={testFailure.message}
              />

              {testFailure.details?.suggestion ? (
                <Banner
                  variant="default"
                  title="处理建议"
                  description={testFailure.details.suggestion}
                />
              ) : null}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <Text size="xs" variant="secondary">请求阶段</Text>
                  <Text size="sm">{testFailure.details?.phase || "未知"}</Text>
                </div>
                <div>
                  <Text size="xs" variant="secondary">后台响应状态</Text>
                  <Text size="sm">{testFailure.status || "无响应"}</Text>
                </div>
                <div>
                  <Text size="xs" variant="secondary">飞书 HTTP 状态</Text>
                  <Text size="sm">{testFailure.details?.upstreamStatus ?? "无响应"}</Text>
                </div>
                <div>
                  <Text size="xs" variant="secondary">飞书错误码</Text>
                  <Text size="sm">{testFailure.details?.feishuCode ?? "无"}</Text>
                </div>
                <div>
                  <Text size="xs" variant="secondary">请求方法</Text>
                  <Text size="sm">{testFailure.details?.method || "未知"}</Text>
                </div>
                <div>
                  <Text size="xs" variant="secondary">请求耗时</Text>
                  <Text size="sm">
                    {testFailure.details?.durationMs !== undefined
                      ? `${testFailure.details.durationMs} ms`
                      : "未知"}
                  </Text>
                </div>
                <div>
                  <Text size="xs" variant="secondary">App Secret 来源</Text>
                  <Text size="sm">
                    {testFailure.details?.secretSource === "current_input"
                      ? "当前输入"
                      : testFailure.details?.secretSource === "saved"
                        ? "已保存配置"
                        : "未配置"}
                  </Text>
                </div>
                <div>
                  <Text size="xs" variant="secondary">发生时间</Text>
                  <Text size="sm">
                    {testFailure.details?.occurredAt
                      ? formatDate(testFailure.details.occurredAt)
                      : "未知"}
                  </Text>
                </div>
              </div>

              {testFailure.details?.endpoint ? (
                <div>
                  <Text size="xs" variant="secondary">请求接口</Text>
                  <div className="break-all">
                    <Text size="sm">{testFailure.details.endpoint}</Text>
                  </div>
                </div>
              ) : null}

              {testFailure.details?.request !== undefined ? (
                <div className="min-w-0">
                  <div className="mb-2">
                    <Text size="sm">Request Body（已脱敏）</Text>
                  </div>
                  <CodeBlock
                    code={JSON.stringify(testFailure.details.request, null, 2)}
                    lang="jsonc"
                  />
                </div>
              ) : null}

              {testFailure.details?.responseHeaders !== undefined ? (
                <div className="min-w-0">
                  <div className="mb-2">
                    <Text size="sm">Response Headers（已脱敏）</Text>
                  </div>
                  <CodeBlock
                    code={JSON.stringify(testFailure.details.responseHeaders, null, 2)}
                    lang="jsonc"
                  />
                </div>
              ) : null}

              {testFailure.details?.response !== undefined ? (
                <div className="min-w-0">
                  <div className="mb-2">
                    <Text size="sm">Response Body（已脱敏）</Text>
                  </div>
                  <CodeBlock
                    code={JSON.stringify(testFailure.details.response, null, 2)}
                    lang="jsonc"
                  />
                </div>
              ) : null}

              <div className="flex justify-end">
                <Button onClick={() => setTestFailure(null)}>关闭</Button>
              </div>
            </div>
          ) : null}
        </Dialog>
      </Dialog.Root>
    </AdminShell>
  );
}
