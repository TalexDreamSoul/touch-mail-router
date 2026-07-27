"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  ClipboardText,
  Dialog,
  Input,
  LayerCard,
  SensitiveInput,
  Switch,
  Text,
} from "@cloudflare/kumo";
import { FlaskIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { api, formatDate, type LoginChannel } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useStableToast } from "@/lib/toast";

const emptyForm = {
  name: "",
  enabled: true,
  issuer: "",
  clientId: "",
  clientSecret: "",
  scopes: "openid profile email",
  subjectClaim: "sub",
  usernameClaim: "preferred_username",
  displayNameClaim: "name",
};

export default function LoginChannelsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const toast = useStableToast();
  const [rows, setRows] = useState<LoginChannel[]>([]);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [feishuReady, setFeishuReady] = useState(false);
  const [feishuChannelExists, setFeishuChannelExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [addingFeishu, setAddingFeishu] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<LoginChannel | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.adminLoginChannels();
      setRows(result.items || []);
      setCallbackUrl(result.callbackUrl || "");
      setFeishuReady(Boolean(result.feishuReady));
      setFeishuChannelExists(Boolean(result.feishuChannelExists));
    } catch (error) {
      toast.error("加载失败", error instanceof Error ? error.message : "");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (user && user.role !== "admin") {
      router.replace("/dashboard");
      return;
    }
    if (user?.role === "admin") void load();
  }, [user, router, load]);

  function openEditor(channel?: LoginChannel) {
    setEditing(channel || null);
    setForm(
      channel
        ? {
            name: channel.name,
            enabled: channel.enabled,
            issuer: channel.issuer,
            clientId: channel.clientId,
            clientSecret: "",
            scopes: channel.scopes.join(" "),
            subjectClaim: channel.subjectClaim,
            usernameClaim: channel.usernameClaim,
            displayNameClaim: channel.displayNameClaim,
          }
        : emptyForm,
    );
    setOpen(true);
  }

  async function addFeishu() {
    setAddingFeishu(true);
    try {
      await api.addFeishuLoginChannel();
      toast.success("飞书登录渠道已添加");
      await load();
    } catch (error) {
      toast.error("添加失败", error instanceof Error ? error.message : "");
    } finally {
      setAddingFeishu(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const scopes = form.scopes.split(/[\s,]+/).filter(Boolean);
      if (editing) {
        await api.updateLoginChannel(editing.id, {
          name: form.name,
          enabled: form.enabled,
          issuer: form.issuer,
          clientId: form.clientId,
          clientSecret: form.clientSecret,
          scopes,
          subjectClaim: form.subjectClaim,
          usernameClaim: form.usernameClaim,
          displayNameClaim: form.displayNameClaim,
        });
        toast.success("登录渠道已更新");
      } else {
        await api.createLoginChannel({ ...form, scopes });
        toast.success("OIDC 登录渠道已创建");
      }
      setOpen(false);
      await load();
    } catch (error) {
      toast.error("保存失败", error instanceof Error ? error.message : "");
    } finally {
      setSaving(false);
    }
  }

  const columns: Column<LoginChannel>[] = [
    {
      key: "name",
      header: "渠道",
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <Text size="sm">{row.name}</Text>
          <Text size="xs" variant="secondary">
            {row.type === "feishu" ? "使用全局飞书应用凭证" : row.issuer}
          </Text>
        </div>
      ),
    },
    {
      key: "type",
      header: "类型",
      cell: (row) => (
        <Badge variant="outline">{row.type === "feishu" ? "飞书" : "自定义 OIDC"}</Badge>
      ),
    },
    {
      key: "status",
      header: "状态",
      cell: (row) => (
        <Badge variant={row.enabled ? "primary" : "secondary"}>
          {row.enabled ? "已启用" : "已停用"}
        </Badge>
      ),
    },
    {
      key: "updatedAt",
      header: "最近更新",
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <Text size="sm" variant="secondary">
            {formatDate(row.updatedAt)}
          </Text>
          <Text size="xs" variant="secondary">
            {row.updatedBy}
          </Text>
        </div>
      ),
    },
    {
      key: "actions",
      header: "操作",
      cell: (row) => (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={FlaskIcon}
            onClick={async () => {
              try {
                await api.testLoginChannel(row.id);
                toast.success("登录渠道配置可用", "Discovery、授权端点与 PKCE 参数生成正常");
              } catch (error) {
                toast.error("测试失败", error instanceof Error ? error.message : "");
              }
            }}
          >
            测试
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openEditor(row)}>
            编辑
          </Button>
          <Button
            size="sm"
            variant="destructive"
            icon={TrashIcon}
            onClick={async () => {
              if (!confirm(`确认删除登录渠道“${row.name}”？已有登录身份的渠道只能停用。`)) return;
              try {
                await api.deleteLoginChannel(row.id);
                toast.success("登录渠道已删除");
                void load();
              } catch (error) {
                toast.error("删除失败", error instanceof Error ? error.message : "");
              }
            }}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  return (
    <AdminShell>
      <PageHeader
        title="登录渠道"
        description="配置用户进入 Touch Mail 的外部身份提供方；密码登录始终保留"
        actions={
          <Button icon={PlusIcon} onClick={() => openEditor()}>
            添加 OIDC
          </Button>
        }
      />

      <Banner
        className="mb-4"
        variant="alert"
        title="启用外部登录会开放自动注册"
        description="身份提供方成功授权的用户会自动创建为普通用户。请先确认 Provider 的成员范围、应用可见范围和授权策略，再启用渠道。"
      />

      <LayerCard className="mb-4">
        <LayerCard.Primary>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div className="max-w-2xl">
                <Text variant="heading3" as="h2">
                  飞书快捷接入
                </Text>
                <Text variant="secondary">
                  复用“飞书配置”中的 App ID 与 App Secret，不再重复维护凭证。
                </Text>
              </div>
              {feishuChannelExists ? (
                <Badge variant="primary">已添加</Badge>
              ) : feishuReady ? (
                <Button loading={addingFeishu} onClick={() => void addFeishu()}>
                  快速添加飞书渠道
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => router.push("/settings/feishu")}>
                  先配置飞书
                </Button>
              )}
            </div>
            {!feishuReady ? (
              <Banner
                variant="secondary"
                title="飞书登录尚未就绪"
                description="启用飞书配置并保存 App ID、App Secret 后，即可在此一键创建登录渠道。"
              />
            ) : null}
          </div>
        </LayerCard.Primary>
      </LayerCard>

      <LayerCard className="mb-4">
        <LayerCard.Primary>
          <div className="flex flex-col gap-2">
            <Text variant="heading3" as="h2">
              OAuth 回调地址
            </Text>
            <Text variant="secondary">
              将此地址加入飞书开放平台或 OIDC Provider 的 Redirect URI 白名单。
            </Text>
            {callbackUrl ? (
              <ClipboardText
                text={callbackUrl}
                size="base"
                tooltip={{ text: "复制", copiedText: "已复制" }}
                labels={{ copyAction: "复制 OAuth 回调地址" }}
              />
            ) : null}
          </div>
        </LayerCard.Primary>
      </LayerCard>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        page={1}
        pageSize={Math.max(rows.length, 1)}
        total={rows.length}
        onPageChange={() => undefined}
      />

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog size="xl" className="max-h-[88vh] overflow-y-auto p-6">
          <Dialog.Title>
            {editing ? `编辑${editing.type === "feishu" ? "飞书" : " OIDC"}渠道` : "添加 OIDC 渠道"}
          </Dialog.Title>
          <div className="mt-4 flex flex-col gap-4">
            <Input
              label="渠道名称"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder={editing?.type === "feishu" ? "飞书" : "例如：公司统一身份认证"}
              required
            />
            <Switch
              label="允许用户登录"
              checked={form.enabled}
              onCheckedChange={(enabled) => setForm({ ...form, enabled })}
            />

            {editing?.type === "oidc" && (editing.identityCount || 0) > 0 ? (
              <Banner
                variant="alert"
                title={`已绑定 ${editing.identityCount} 个外部身份`}
                description="为防止账号被其他 Provider 的同名用户接管，Issuer、Client ID 和用户唯一标识 Claim 已锁定。可修改名称、启用状态、Scopes、显示字段或轮换 Client Secret。"
              />
            ) : null}

            {editing?.type === "feishu" ? (
              <Banner
                variant="secondary"
                title="凭证由飞书配置统一管理"
                description="在这里可修改显示名称和启用状态；App ID、App Secret 请前往飞书配置更新。"
              />
            ) : (
              <>
                <Input
                  label="Issuer URL"
                  description="系统会读取 /.well-known/openid-configuration，并校验返回的 issuer。"
                  value={form.issuer}
                  disabled={Boolean(editing?.identityCount)}
                  onChange={(event) => setForm({ ...form, issuer: event.target.value })}
                  placeholder="https://id.example.com"
                  required
                />
                <Input
                  label="Client ID"
                  value={form.clientId}
                  disabled={Boolean(editing?.identityCount)}
                  onChange={(event) => setForm({ ...form, clientId: event.target.value })}
                  required
                />
                <SensitiveInput
                  label="Client Secret"
                  description={editing ? "留空保留已保存的 Secret" : "由 OIDC Provider 签发"}
                  value={form.clientSecret}
                  onValueChange={(clientSecret) => setForm({ ...form, clientSecret })}
                  placeholder={editing?.clientSecretSet ? "已配置" : "Client Secret"}
                  required={!editing?.clientSecretSet}
                />
                <Input
                  label="Scopes"
                  description="使用空格或逗号分隔；系统始终补充 openid。"
                  value={form.scopes}
                  onChange={(event) => setForm({ ...form, scopes: event.target.value })}
                  placeholder="openid profile email"
                />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Input
                    label="用户唯一标识 Claim"
                    value={form.subjectClaim}
                    disabled={Boolean(editing?.identityCount)}
                    onChange={(event) => setForm({ ...form, subjectClaim: event.target.value })}
                    placeholder="sub"
                  />
                  <Input
                    label="用户名 Claim"
                    value={form.usernameClaim}
                    onChange={(event) => setForm({ ...form, usernameClaim: event.target.value })}
                    placeholder="preferred_username"
                  />
                  <Input
                    label="显示名 Claim"
                    value={form.displayNameClaim}
                    onChange={(event) => setForm({ ...form, displayNameClaim: event.target.value })}
                    placeholder="name"
                  />
                </div>
              </>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button loading={saving} onClick={() => void save()}>
                保存
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </AdminShell>
  );
}
