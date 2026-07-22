"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  ClipboardText,
  CodeBlock,
  Dialog,
  Input,
  LayerCard,
  Tabs,
  Text,
} from "@cloudflare/kumo";
import {
  BookOpenIcon,
  ClockCounterClockwiseIcon,
  KeyIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { AdminShell } from "@/components/admin-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import {
  api,
  formatDate,
  qs,
  type ApiCallLog,
  type ApiDocsInfo,
  type ApiKeyScope,
  type CreatedUserApiKey,
  type UserApiKey,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useStableToast } from "@/lib/toast";

type TabId = "keys" | "history" | "docs";

export default function ApiKeysPage() {
  const { user } = useAuth();
  const toast = useStableToast();
  const [tab, setTab] = useState<TabId>("keys");

  const [keys, setKeys] = useState<UserApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [scopeRead, setScopeRead] = useState(true);
  const [scopeWrite, setScopeWrite] = useState(true);
  const [created, setCreated] = useState<CreatedUserApiKey | null>(null);

  const [history, setHistory] = useState<ApiCallLog[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histQ, setHistQ] = useState("");
  const [histPage, setHistPage] = useState(1);
  const [histTotal, setHistTotal] = useState(0);

  const [docs, setDocs] = useState<ApiDocsInfo | null>(null);

  const loadKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      const res = await api.listApiKeys();
      setKeys(res.items ?? []);
    } catch (e) {
      toast.error("加载 API Key 失败", e instanceof Error ? e.message : "");
    } finally {
      setKeysLoading(false);
    }
  }, [toast]);

  const loadHistory = useCallback(async () => {
    setHistLoading(true);
    try {
      const res = await api.apiHistory(qs({ q: histQ, page: histPage, pageSize: 20 }));
      setHistory(res.items ?? []);
      setHistTotal(res.total ?? 0);
    } catch (e) {
      toast.error("加载调用历史失败", e instanceof Error ? e.message : "");
    } finally {
      setHistLoading(false);
    }
  }, [histQ, histPage, toast]);

  const loadDocs = useCallback(async () => {
    try {
      setDocs(await api.apiDocs());
    } catch (e) {
      toast.error("加载文档失败", e instanceof Error ? e.message : "");
    }
  }, [toast]);

  useEffect(() => {
    if (!user) return;
    void loadKeys();
  }, [user?.id, loadKeys]);

  useEffect(() => {
    if (!user || tab !== "history") return;
    void loadHistory();
  }, [user?.id, tab, loadHistory]);

  useEffect(() => {
    if (!user || tab !== "docs") return;
    void loadDocs();
  }, [user?.id, tab, loadDocs]);

  const keyColumns: Column<UserApiKey>[] = [
    {
      key: "name",
      header: "名称",
      cell: (r) => <Text size="sm">{r.name}</Text>,
    },
    {
      key: "preview",
      header: "Key",
      cell: (r) => (
        <Text size="sm" variant="secondary">
          {r.keyPreview}
        </Text>
      ),
    },
    {
      key: "scopes",
      header: "权限",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          {(r.scopes || []).map((s) => (
            <Badge key={s} variant={s === "write" ? "primary" : "secondary"}>
              {s}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      key: "status",
      header: "状态",
      cell: (r) => (
        <Badge variant={r.status === "active" ? "primary" : "secondary"}>
          {r.status === "active" ? "启用" : "已吊销"}
        </Badge>
      ),
    },
    {
      key: "lastUsedAt",
      header: "最近使用",
      cell: (r) => (
        <Text size="sm" variant="secondary">
          {r.lastUsedAt ? formatDate(r.lastUsedAt) : "—"}
        </Text>
      ),
    },
    {
      key: "createdAt",
      header: "创建时间",
      cell: (r) => (
        <Text size="sm" variant="secondary">
          {formatDate(r.createdAt)}
        </Text>
      ),
    },
    {
      key: "actions",
      header: "操作",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const next = r.status === "active" ? "revoked" : "active";
              try {
                await api.updateApiKey(r.id, { status: next });
                toast.success(next === "active" ? "已启用" : "已吊销");
                void loadKeys();
              } catch (e) {
                toast.error("更新失败", e instanceof Error ? e.message : "");
              }
            }}
          >
            {r.status === "active" ? "吊销" : "启用"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const hasWrite = (r.scopes || []).includes("write");
              const scopes: ApiKeyScope[] = hasWrite ? ["read"] : ["read", "write"];
              try {
                await api.updateApiKey(r.id, { scopes });
                toast.success(hasWrite ? "已改为仅读取" : "已开启写入");
                void loadKeys();
              } catch (e) {
                toast.error("更新权限失败", e instanceof Error ? e.message : "");
              }
            }}
          >
            {(r.scopes || []).includes("write") ? "仅 read" : "read+write"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            icon={TrashIcon}
            onClick={async () => {
              if (!confirm(`删除 API Key「${r.name}」？`)) return;
              try {
                await api.deleteApiKey(r.id);
                toast.success("已删除");
                void loadKeys();
              } catch (e) {
                toast.error("删除失败", e instanceof Error ? e.message : "");
              }
            }}
          >
            删除
          </Button>
        </div>
      ),
    },
  ];

  const histColumns: Column<ApiCallLog>[] = [
    {
      key: "time",
      header: "时间",
      cell: (r) => (
        <Text size="sm" variant="secondary">
          {formatDate(r.createdAt)}
        </Text>
      ),
    },
    {
      key: "method",
      header: "方法",
      cell: (r) => <Badge variant="secondary">{r.method}</Badge>,
    },
    {
      key: "path",
      header: "路径",
      cell: (r) => (
        <Text size="sm" truncate>
          {r.path}
        </Text>
      ),
    },
    {
      key: "status",
      header: "状态",
      cell: (r) => (
        <Badge variant={r.status < 400 ? "primary" : "secondary"}>{r.status}</Badge>
      ),
    },
    {
      key: "ms",
      header: "耗时",
      cell: (r) => (
        <Text size="sm" variant="secondary">
          {r.durationMs}ms
        </Text>
      ),
    },
    {
      key: "key",
      header: "Key",
      cell: (r) => (
        <Text size="sm" variant="secondary">
          {r.apiKeyName || "—"}
        </Text>
      ),
    },
  ];

  const exampleCurl = docs
    ? `curl -sS ${docs.endpoints.me} \\\n  -H "Authorization: Bearer dk_你的密钥"`
    : "";

  return (
    <AdminShell>
      <PageHeader
        title="API Keys"
        description="个人密钥、读写权限、调用历史与 AI-native 文档"
        actions={
          tab === "keys" ? (
            <Button
              icon={PlusIcon}
              onClick={() => {
                setKeyName("");
                setScopeRead(true);
                setScopeWrite(true);
                setShowCreate(true);
              }}
            >
              新建 Key
            </Button>
          ) : null
        }
      />

      <Banner
        className="mb-4"
        title="AI-native 优先"
        description="Agent / Skill 请走 /ai/v1/*（结构化 ok/error）。DuckMail 兼容路径 /domains /accounts 等仍可用。密钥在此创建，不要放进代码仓库。"
      />

      <div className="mb-4">
        <Tabs
          tabs={[
            { value: "keys", label: "密钥" },
            { value: "history", label: "调用历史" },
            { value: "docs", label: "API 文档" },
          ]}
          value={tab}
          onValueChange={(v) => setTab(v as TabId)}
        />
      </div>

      {tab === "keys" ? (
        <DataTable
          columns={keyColumns}
          rows={keys}
          loading={keysLoading}
          page={1}
          pageSize={50}
          total={keys.length}
          onPageChange={() => {}}
          emptyTitle="还没有 API Key"
          emptyDescription="创建后用于 AI Skill、DuckMail 私有域名等调用"
        />
      ) : null}

      {tab === "history" ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Input
              label="搜索"
              value={histQ}
              onChange={(e) => setHistQ(e.target.value)}
              placeholder="路径 / 方法 / 状态 / Key 名"
            />
            <div className="flex items-end">
              <Button
                icon={ClockCounterClockwiseIcon}
                onClick={() => {
                  setHistPage(1);
                  void loadHistory();
                }}
              >
                查询
              </Button>
            </div>
          </div>
          <DataTable
            columns={histColumns}
            rows={history}
            loading={histLoading}
            page={histPage}
            pageSize={20}
            total={histTotal}
            onPageChange={setHistPage}
            emptyTitle="暂无调用记录"
            emptyDescription="用 Bearer Key 访问 /ai/v1/* 后会出现在这里"
          />
        </div>
      ) : null}

      {tab === "docs" ? (
        <div className="flex flex-col gap-4">
          <LayerCard>
            <LayerCard.Secondary>文档入口</LayerCard.Secondary>
            <LayerCard.Primary>
              {docs ? (
                <div className="flex flex-col gap-3">
                  <div>
                    <Text size="xs" variant="secondary">
                      OpenAPI
                    </Text>
                    <ClipboardText
                      text={docs.openapiUrl}
                      size="sm"
                      tooltip={{ text: "复制", copiedText: "已复制" }}
                      labels={{ copyAction: "复制 OpenAPI URL" }}
                    />
                  </div>
                  <div>
                    <Text size="xs" variant="secondary">
                      Skill Manifest
                    </Text>
                    <ClipboardText
                      text={docs.skillUrl}
                      size="sm"
                      tooltip={{ text: "复制", copiedText: "已复制" }}
                      labels={{ copyAction: "复制 Skill URL" }}
                    />
                  </div>
                  <div>
                    <Text size="xs" variant="secondary">
                      鉴权
                    </Text>
                    <Text size="sm">{docs.auth}</Text>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <Text size="xs" variant="secondary">
                        read
                      </Text>
                      <Text size="sm">{docs.scopes.read}</Text>
                    </div>
                    <div>
                      <Text size="xs" variant="secondary">
                        write
                      </Text>
                      <Text size="sm">{docs.scopes.write}</Text>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={BookOpenIcon}
                      onClick={() => window.open(docs.openapiUrl, "_blank")}
                    >
                      打开 OpenAPI
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => window.open(docs.skillUrl, "_blank")}
                    >
                      打开 Skill JSON
                    </Button>
                  </div>
                </div>
              ) : (
                <Text variant="secondary">加载中…</Text>
              )}
            </LayerCard.Primary>
          </LayerCard>

          {docs ? (
            <LayerCard>
              <LayerCard.Secondary>常用端点</LayerCard.Secondary>
              <LayerCard.Primary>
                <div className="flex flex-col gap-2">
                  {Object.entries(docs.endpoints).map(([k, url]) => (
                    <div key={k} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                      <div className="w-24 shrink-0">
                        <Text size="sm">{k}</Text>
                      </div>
                      <ClipboardText
                        text={url}
                        size="sm"
                        tooltip={{ text: "复制", copiedText: "已复制" }}
                        labels={{ copyAction: `复制 ${k}` }}
                      />
                    </div>
                  ))}
                </div>
              </LayerCard.Primary>
            </LayerCard>
          ) : null}

          {exampleCurl ? (
            <LayerCard>
              <LayerCard.Secondary>示例</LayerCard.Secondary>
              <LayerCard.Primary>
                <CodeBlock code={exampleCurl} lang="bash" />
              </LayerCard.Primary>
            </LayerCard>
          ) : null}
        </div>
      ) : null}

      <Dialog.Root open={showCreate} onOpenChange={setShowCreate}>
        <Dialog size="base" className="p-6">
          <Dialog.Title>新建 API Key</Dialog.Title>
          <div className="mt-4 flex flex-col gap-4">
            <Input
              label="名称"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="例如：Claude Skill / CI"
            />
            <div className="flex flex-col gap-2">
              <Text size="sm">权限 scopes</Text>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={scopeRead}
                  onChange={(e) => setScopeRead(e.target.checked)}
                />
                read — 查询域名 / 邮件 / 历史
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={scopeWrite}
                  onChange={(e) => setScopeWrite(e.target.checked)}
                />
                write — 创建 / 修改资源
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowCreate(false)}>
                取消
              </Button>
              <Button
                loading={creating}
                icon={KeyIcon}
                onClick={async () => {
                  const scopes: ApiKeyScope[] = [];
                  if (scopeRead) scopes.push("read");
                  if (scopeWrite) scopes.push("write");
                  if (!scopes.length) {
                    toast.error("至少选择一个权限");
                    return;
                  }
                  setCreating(true);
                  try {
                    const res = await api.createApiKey(keyName || "default", scopes);
                    setCreated(res.key);
                    setShowCreate(false);
                    void loadKeys();
                    toast.success("已创建，请立即复制完整 Key");
                  } catch (e) {
                    toast.error("创建失败", e instanceof Error ? e.message : "");
                  } finally {
                    setCreating(false);
                  }
                }}
              >
                创建
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root open={Boolean(created)} onOpenChange={(v) => !v && setCreated(null)}>
        <Dialog size="lg" className="p-6">
          <Dialog.Title>请保存 API Key</Dialog.Title>
          <div className="mt-4 flex flex-col gap-3">
            <Banner
              variant="alert"
              title="仅显示一次"
              description="完整 Key 不会再次展示，请立即复制并妥善保管。"
            />
            {created ? (
              <>
                <Text size="sm">
                  名称：{created.name} · 权限：{(created.scopes || []).join(", ")}
                </Text>
                <ClipboardText
                  text={created.key}
                  size="base"
                  tooltip={{ text: "复制", copiedText: "已复制" }}
                  labels={{ copyAction: "复制完整 Key" }}
                />
              </>
            ) : null}
            <div className="flex justify-end">
              <Button onClick={() => setCreated(null)}>我已保存</Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </AdminShell>
  );
}
