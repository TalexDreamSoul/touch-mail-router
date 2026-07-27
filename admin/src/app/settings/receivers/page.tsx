"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  ClipboardText,
  Dialog,
  Input,
  InputArea,
  LayerCard,
  Select,
  SensitiveInput,
  Switch,
  Text,
} from "@cloudflare/kumo";
import { FlaskIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import {
  api,
  formatDate,
  type ReceiveChannel,
  type ReceiveChannelType,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useStableToast } from "@/lib/toast";

const TYPE_LABEL: Record<ReceiveChannelType, string> = {
  worker: "Cloudflare Worker",
  email_forward: "邮箱转发",
  donemail: "DoneMail API",
  api_push: "API 主动上报",
};

const emptyForm = {
  name: "",
  description: "",
  type: "worker" as ReceiveChannelType,
  enabled: true,
  forwardingAddressTemplate: "{tenant}@inbound.example.com",
  baseUrl: "",
  adminKey: "",
  pushToken: "",
  pollIntervalSeconds: 60,
};

export default function ReceiveChannelsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const toast = useStableToast();
  const [rows, setRows] = useState<ReceiveChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [createdSecret, setCreatedSecret] = useState("");
  const [createdChannelId, setCreatedChannelId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.adminReceiveChannels();
      setRows(result.items || []);
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

  function openEditor(channel?: ReceiveChannel) {
    setEditingId(channel?.id || null);
    setForm(
      channel
        ? {
            name: channel.name,
            description: channel.description,
            type: channel.type,
            enabled: channel.enabled,
            forwardingAddressTemplate:
              channel.forwardingAddressTemplate || "{tenant}@inbound.example.com",
            baseUrl: channel.baseUrl,
            adminKey: "",
            pushToken: "",
            pollIntervalSeconds: channel.pollIntervalSeconds,
          }
        : emptyForm,
    );
    setOpen(true);
  }

  async function save() {
    setSaving(true);
    try {
      if (editingId) {
        await api.updateReceiveChannel(editingId, form);
        toast.success("收件渠道已更新");
      } else {
        const result = await api.createReceiveChannel(form);
        if (result.pushToken) {
          setCreatedSecret(result.pushToken);
          setCreatedChannelId(result.channel.id);
        }
        toast.success("收件渠道已创建");
      }
      setOpen(false);
      await load();
    } catch (error) {
      toast.error("保存失败", error instanceof Error ? error.message : "");
    } finally {
      setSaving(false);
    }
  }

  const columns: Column<ReceiveChannel>[] = [
    {
      key: "name",
      header: "渠道",
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <Text size="sm">{row.name}</Text>
          <Text size="xs" variant="secondary">
            {row.description || "—"}
          </Text>
        </div>
      ),
    },
    {
      key: "type",
      header: "类型",
      cell: (row) => <Badge variant="outline">{TYPE_LABEL[row.type]}</Badge>,
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
      key: "sync",
      header: "最近同步",
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <Text size="sm" variant="secondary">
            {row.type === "donemail" ? formatDate(row.lastSyncAt) : "—"}
          </Text>
          {row.lastSyncError ? (
            <Text size="xs" variant="error">
              {row.lastSyncError}
            </Text>
          ) : null}
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
                await api.testReceiveChannel(row.id);
                toast.success("渠道配置可用");
              } catch (error) {
                toast.error("测试失败", error instanceof Error ? error.message : "");
              }
            }}
          >
            测试
          </Button>
          {row.type === "donemail" ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                try {
                  const result = await api.syncReceiveChannel(row.id);
                  toast.success(
                    "同步完成",
                    `新增 ${result.result.imported}，重复 ${result.result.duplicates}，跳过 ${result.result.skipped}`,
                  );
                  void load();
                } catch (error) {
                  toast.error("同步失败", error instanceof Error ? error.message : "");
                }
              }}
            >
              立即同步
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => openEditor(row)}>
            编辑
          </Button>
          <Button
            size="sm"
            variant="destructive"
            icon={TrashIcon}
            onClick={async () => {
              if (!confirm(`删除收件渠道 ${row.name}？`)) return;
              try {
                await api.deleteReceiveChannel(row.id);
                toast.success("已删除");
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
        title="收件渠道"
        description="管理员先发布可用渠道，用户绑定域名时只能从已启用渠道中选择"
        actions={
          <Button icon={PlusIcon} onClick={() => openEditor()}>
            新建渠道
          </Button>
        }
      />
      <Banner
        className="mb-4"
        variant="secondary"
        title="Worker 与邮箱转发是不同渠道"
        description="Worker 使用 Cloudflare Email Routing 的 Send to a Worker；邮箱转发才会把原邮箱转到管理员配置的目标地址。"
      />
      {createdSecret ? (
        <LayerCard className="mb-4">
          <LayerCard.Secondary>渠道签名 Token（仅本次显示）</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3">
              <div>
                <Text size="xs" variant="secondary">收件渠道 ID</Text>
                <ClipboardText
                  text={createdChannelId}
                  size="base"
                  tooltip={{ text: "复制", copiedText: "已复制" }}
                  labels={{ copyAction: "复制渠道 ID" }}
                />
              </div>
              <div>
                <Text size="xs" variant="secondary">签名 Token</Text>
                <ClipboardText
                  text={createdSecret}
                  size="base"
                  tooltip={{ text: "复制", copiedText: "已复制" }}
                  labels={{ copyAction: "复制渠道 Token" }}
                />
              </div>
            </div>
          </LayerCard.Primary>
        </LayerCard>
      ) : null}
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
        <Dialog size="xl" className="p-6">
          <Dialog.Title>{editingId ? "编辑收件渠道" : "新建收件渠道"}</Dialog.Title>
          <div className="mt-4 flex flex-col gap-4">
            <Input
              label="渠道名称"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="例如：Cloudflare Worker"
              required
            />
            <InputArea
              label="说明"
              value={form.description}
              onValueChange={(description) => setForm({ ...form, description })}
              minRows={2}
              maxRows={4}
              placeholder="向用户解释这个渠道适用的场景"
            />
            <Select
              label="渠道类型"
              hideLabel={false}
              value={form.type}
              onValueChange={(value) =>
                setForm({ ...form, type: String(value) as ReceiveChannelType })
              }
            >
              <Select.Option value="worker">Cloudflare Worker</Select.Option>
              <Select.Option value="email_forward">邮箱转发</Select.Option>
              <Select.Option value="donemail">DoneMail API</Select.Option>
              <Select.Option value="api_push">API 主动上报</Select.Option>
            </Select>
            <Switch
              label="允许用户选择"
              checked={form.enabled}
              onCheckedChange={(enabled) => setForm({ ...form, enabled })}
            />

            {form.type === "worker" ? (
              <Banner
                variant="secondary"
                title="用户部署直连 Worker"
                description="系统会为每个域名生成独立 Worker Name、代码和密钥，并指导用户创建 Email Routing 规则。"
              />
            ) : null}
            {form.type === "email_forward" ? (
              <Input
                label="转发目标模板"
                description="必须包含 {tenant}；可选 {domain}。用户会看到渲染后的具体地址。"
                value={form.forwardingAddressTemplate}
                onChange={(event) =>
                  setForm({ ...form, forwardingAddressTemplate: event.target.value })
                }
                placeholder="{tenant}@inbound.example.com"
              />
            ) : null}
            {form.type === "donemail" ? (
              <>
                <Input
                  label="DoneMail Base URL"
                  description="填写站点根地址，不要填写 /api/overview 文档地址。"
                  value={form.baseUrl}
                  onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                  placeholder="https://sow.us.kg"
                />
                <SensitiveInput
                  label="X-Admin-Key"
                  description={editingId ? "已配置时留空不会覆盖" : "DoneMail 管理员 Key"}
                  value={form.adminKey}
                  onValueChange={(adminKey) => setForm({ ...form, adminKey })}
                  placeholder={editingId ? "已配置" : "X-Admin-Key"}
                />
                <Input
                  label="同步间隔（秒）"
                  type="number"
                  min={30}
                  max={3600}
                  value={String(form.pollIntervalSeconds)}
                  onChange={(event) =>
                    setForm({ ...form, pollIntervalSeconds: Number(event.target.value) || 60 })
                  }
                />
              </>
            ) : null}
            {form.type === "api_push" ? (
              <SensitiveInput
                label="API Token（可选）"
                description={
                  editingId ? "留空保留原 Token；填写后可轮换" : "留空由系统生成，并仅显示一次"
                }
                value={form.pushToken}
                onValueChange={(pushToken) => setForm({ ...form, pushToken })}
                placeholder="留空自动生成"
              />
            ) : null}

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
