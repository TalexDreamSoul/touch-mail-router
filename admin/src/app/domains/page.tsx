"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  ClipboardText,
  CodeBlock,
  Dialog,
  Input,
  LayerCard,
  Radio,
  Tabs,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  BookOpenIcon,
  CheckCircleIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { AdminShell } from "@/components/admin-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { SearchBar } from "@/components/search-bar";
import {
  api,
  formatDate,
  qs,
  type Domain,
  type DomainVisibility,
  type WorkerSnippet,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useStableToast } from "@/lib/toast";

type WizardStep = "register" | "forward" | "worker" | "test";

const STEP_META: { id: WizardStep; label: string; n: number }[] = [
  { id: "register", label: "登记域名", n: 1 },
  { id: "forward", label: "邮箱转发", n: 2 },
  { id: "worker", label: "绑定 Worker", n: 3 },
  { id: "test", label: "发送测试", n: 4 },
];

export default function DomainsPage() {
  const { user } = useAuth();
  const toast = useStableToast();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>("register");
  const [domain, setDomain] = useState("");
  const [note, setNote] = useState("");
  const [visibility, setVisibility] = useState<DomainVisibility>("private");
  const [savedDomain, setSavedDomain] = useState("");
  const [saving, setSaving] = useState(false);
  const [snippet, setSnippet] = useState<WorkerSnippet | null>(null);
  const [codeTab, setCodeTab] = useState("js");
  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = qs({ q, page, pageSize });
      const res = isAdmin ? await api.adminDomains(params) : await api.domains(params);
      setRows(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (e) {
      toast.error("加载失败", e instanceof Error ? e.message : "");
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, isAdmin, toast]);

  const loadSnippet = useCallback(async () => {
    try {
      const s = await api.workerSnippet();
      setSnippet(s);
    } catch {
      /* page still usable without snippet */
    }
  }, []);

  useEffect(() => {
    if (user) {
      void load();
      void loadSnippet();
    }
  }, [user?.id, user?.role, load, loadSnippet]);

  const inboundAddress = snippet?.inboundAddress || user?.inboundAddress || "";
  const inboundDomain = useMemo(() => {
    const a = inboundAddress;
    const at = a.lastIndexOf("@");
    return at > 0 ? a.slice(at + 1) : "";
  }, [inboundAddress]);

  function openWizard(prefill?: Domain | string) {
    if (typeof prefill === "object" && prefill) {
      setDomain(prefill.domain);
      setNote(prefill.note || "");
      setVisibility(prefill.visibility === "public" ? "public" : "private");
      setSavedDomain(prefill.domain);
      setStep("forward");
    } else {
      setDomain(typeof prefill === "string" ? prefill : "");
      setNote("");
      setVisibility("private");
      setSavedDomain(typeof prefill === "string" ? prefill : "");
      setStep(prefill ? "forward" : "register");
    }
    setCodeTab("js");
    setOpen(true);
    if (!snippet) void loadSnippet();
  }

  function closeWizard() {
    setOpen(false);
    setStep("register");
    setDomain("");
    setNote("");
    setVisibility("private");
    setSavedDomain("");
  }

  async function toggleVisibility(r: Domain) {
    // Admin viewing others' domains: only owner can patch via tenant API
    if (isAdmin && r.userId !== user?.id) {
      toast.error("只能修改自己的域名可见性");
      return;
    }
    const next: DomainVisibility = r.visibility === "public" ? "private" : "public";
    try {
      await api.updateDomain(r.id, { visibility: next });
      toast.success(next === "public" ? "已设为公开" : "已设为私有");
      void load();
    } catch (e) {
      toast.error("更新失败", e instanceof Error ? e.message : "");
    }
  }

  const columns: Column<Domain>[] = [
    {
      key: "domain",
      header: "域名",
      cell: (r) => <Text size="sm">{r.domain}</Text>,
    },
    {
      key: "visibility",
      header: "可见性",
      cell: (r) => (
        <Badge variant={r.visibility === "public" ? "primary" : "secondary"}>
          {r.visibility === "public" ? "公开" : "私有"}
        </Badge>
      ),
    },
    ...(isAdmin
      ? [
          {
            key: "owner",
            header: "所属用户",
            cell: (r: Domain) => (
              <Text size="sm" variant="secondary">
                {r.username || r.userId} / {r.tenant || "—"}
              </Text>
            ),
          } as Column<Domain>,
        ]
      : []),
    {
      key: "note",
      header: "备注",
      cell: (r) => (
        <Text size="sm" variant="secondary">
          {r.note || "—"}
        </Text>
      ),
    },
    {
      key: "createdAt",
      header: "添加时间",
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
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" icon={BookOpenIcon} onClick={() => openWizard(r)}>
            接入指南
          </Button>
          {(!isAdmin || r.userId === user?.id) && (
            <Button size="sm" variant="ghost" onClick={() => void toggleVisibility(r)}>
              {r.visibility === "public" ? "改私有" : "改公开"}
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            icon={TrashIcon}
            onClick={async () => {
              if (!confirm(`删除域名 ${r.domain}？`)) return;
              try {
                if (isAdmin && r.userId !== user?.id) await api.adminDeleteDomain(r.id);
                else await api.deleteDomain(r.id);
                toast.success("已删除");
                void load();
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

  const stepIndex = STEP_META.findIndex((s) => s.id === step);

  return (
    <AdminShell>
      <PageHeader
        title="域名"
        description={
          isAdmin
            ? "全站客户域名台账 · 添加后需完成转发与 Worker 绑定"
            : "绑定客户域名 · 按向导完成转发、Worker 与测试"
        }
        actions={
          <Button icon={PlusIcon} onClick={() => openWizard()}>
            添加域名
          </Button>
        }
      />

      <Banner
        className="mb-4"
        variant="alert"
        title="登记域名 ≠ 邮件已接通"
        description="本页只做台账。客户邮箱必须转发到你的入站地址，且 Cloudflare Email Worker 已部署并绑定入站域后，邮件才会进入系统。"
      />

      <LayerCard className="mb-6">
        <LayerCard.Secondary>接入总览</LayerCard.Secondary>
        <LayerCard.Primary>
          <div className="flex flex-col gap-4">
            <Text size="sm" variant="secondary">
              推荐链路：客户邮箱 → 转发到入站地址 → Email Routing 触发 Worker → HTTPS 推送到本服务。
            </Text>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Text size="sm">你的入站地址</Text>
                {inboundAddress ? (
                  <ClipboardText
                    text={inboundAddress}
                    size="base"
                    tooltip={{ text: "复制", copiedText: "已复制" }}
                    labels={{ copyAction: "复制入站地址" }}
                  />
                ) : (
                  <Text variant="secondary" size="sm">
                    加载中…
                  </Text>
                )}
                <Text size="xs" variant="secondary">
                  客户把 support@客户域 完整转发到此地址（或 {user?.tenant || "tenant"}+orders@
                  {inboundDomain || "入站域"} 做渠道分流）。
                </Text>
              </div>
              <div className="flex flex-col gap-2">
                <Text size="sm">Webhook</Text>
                {snippet?.webhookUrl ? (
                  <ClipboardText
                    text={snippet.webhookUrl}
                    size="base"
                    tooltip={{ text: "复制", copiedText: "已复制" }}
                    labels={{ copyAction: "复制 Webhook" }}
                  />
                ) : (
                  <Text variant="secondary" size="sm">
                    —
                  </Text>
                )}
                <Text size="xs" variant="secondary">
                  Worker 向该地址 POST 原始邮件（HMAC 签名）。本地开发时需公网可达或用模拟脚本。
                </Text>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon={BookOpenIcon}
                onClick={() => openWizard(rows[0])}
              >
                打开接入向导
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  openWizard(rows[0]);
                  setStep("worker");
                }}
              >
                仅查看 Worker 代码
              </Button>
            </div>
          </div>
        </LayerCard.Primary>
      </LayerCard>

      <div className="mb-4">
        <SearchBar
          value={q}
          placeholder="搜索域名 / 备注"
          onSearch={(v) => {
            setPage(1);
            setQ(v);
          }}
        />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
      />

      <Dialog.Root
        open={open}
        onOpenChange={(v) => {
          if (!v) closeWizard();
          else setOpen(true);
        }}
      >
        <Dialog size="xl" className="max-h-[90vh] overflow-y-auto p-6">
          <Dialog.Title>域名接入向导</Dialog.Title>
          <Text variant="secondary" size="sm" className="mt-1">
            按步骤完成登记、转发、Worker 绑定与测试。跳过任一步都可能导致收不到邮件。
          </Text>

          <div className="mt-4 flex flex-wrap gap-2">
            {STEP_META.map((s, i) => {
              const active = s.id === step;
              const done = i < stepIndex;
              return (
                <Button
                  key={s.id}
                  size="sm"
                  variant={active ? "primary" : done ? "secondary" : "ghost"}
                  icon={done ? CheckCircleIcon : undefined}
                  onClick={() => {
                    if (s.id !== "register" && !savedDomain && !domain.trim()) {
                      toast.error("请先登记域名");
                      return;
                    }
                    setStep(s.id);
                  }}
                >
                  {s.n}. {s.label}
                </Button>
              );
            })}
          </div>

          <div className="mt-6 flex flex-col gap-4">
            {step === "register" ? (
              <>
                <Banner
                  title="第 1 步 · 登记客户域名"
                  description="仅写入台账，便于你管理「哪个客户域在用」。真正收信依赖后续转发与 Worker。"
                />
                <Input
                  label="客户域名"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="example.com 或 mail.example.com"
                />
                <Input
                  label="备注"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="例如：客户 A 的 support 邮箱"
                />
                <Radio.Group
                  legend="可见性（DuckMail /domains）"
                  appearance="card"
                  value={visibility}
                  onValueChange={(v) =>
                    setVisibility(v === "public" ? "public" : "private")
                  }
                >
                  <Radio.Item
                    label="私有（推荐）"
                    description="仅你的 API Key 可见，适合正式客户域"
                    value="private"
                  />
                  <Radio.Item
                    label="公开"
                    description="任何人调用 /domains 都能看到，无需 Key 即可在此域创建邮箱"
                    value="public"
                  />
                </Radio.Group>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={closeWizard}>
                    取消
                  </Button>
                  <Button
                    loading={saving}
                    icon={ArrowRightIcon}
                    onClick={async () => {
                      const d = domain.trim().toLowerCase();
                      if (!d) {
                        toast.error("请填写域名");
                        return;
                      }
                      setSaving(true);
                      try {
                        await api.createDomain(d, note, visibility);
                        setSavedDomain(d);
                        toast.success(
                          visibility === "public" ? "域名已登记（公开）" : "域名已登记（私有）",
                        );
                        void load();
                        setStep("forward");
                      } catch (e) {
                        // already exists → still continue wizard with this domain
                        const msg = e instanceof Error ? e.message : "";
                        if (/已存在|exist|duplicate/i.test(msg)) {
                          setSavedDomain(d);
                          toast.success("域名已在台账中，继续配置");
                          setStep("forward");
                        } else {
                          toast.error("登记失败", msg);
                        }
                      } finally {
                        setSaving(false);
                      }
                    }}
                  >
                    保存并下一步
                  </Button>
                </div>
              </>
            ) : null}

            {step === "forward" ? (
              <>
                <Banner
                  title="第 2 步 · 配置邮箱转发"
                  description={`在客户邮箱（或企业邮箱管理后台）把目标地址完整转发到入站地址。域名 ${savedDomain || domain || "（客户域）"} 本身不需要 MX 指向本服务。`}
                />
                <LayerCard>
                  <LayerCard.Secondary>转发目标（入站地址）</LayerCard.Secondary>
                  <LayerCard.Primary>
                    <div className="flex flex-col gap-3">
                      {inboundAddress ? (
                        <ClipboardText
                          text={inboundAddress}
                          size="lg"
                          tooltip={{ text: "复制", copiedText: "已复制" }}
                          labels={{ copyAction: "复制入站地址" }}
                        />
                      ) : (
                        <Text variant="secondary">无法加载入站地址</Text>
                      )}
                      <Text size="sm" variant="secondary">
                        示例：把{" "}
                        <Text as="span" size="sm">
                          support@{savedDomain || domain || "customer.com"}
                        </Text>{" "}
                        的自动转发 / 别名指向上面的地址。
                      </Text>
                      <Text size="sm" variant="secondary">
                        多业务线可用 plus 地址：
                        {user?.tenant || "tenant"}+orders@{inboundDomain || "inbound.example.com"}
                      </Text>
                    </div>
                  </LayerCard.Primary>
                </LayerCard>
                <Banner
                  variant="secondary"
                  title="给客户的一句话"
                  description={
                    inboundAddress
                      ? `请把 support@${savedDomain || domain || "你的公司域名"} 完整转发到：${inboundAddress}`
                      : "加载入站地址后可复制给客户"
                  }
                />
                <div className="flex justify-between gap-2">
                  <Button variant="ghost" onClick={() => setStep("register")}>
                    上一步
                  </Button>
                  <Button icon={ArrowRightIcon} onClick={() => setStep("worker")}>
                    下一步：绑定 Worker
                  </Button>
                </div>
              </>
            ) : null}

            {step === "worker" ? (
              <>
                <Banner
                  variant="alert"
                  title="第 3 步 · 部署并绑定 Cloudflare Email Worker"
                  description={
                    inboundDomain
                      ? `在 Cloudflare 上部署 Worker，把入站域 ${inboundDomain} 的 Email Routing Catch-all 指到该 Worker。没有这一步，转发的邮件到不了本服务。`
                      : "部署 Worker 并将入站域 Email Routing Catch-all 指向它。"
                  }
                />
                <div className="flex flex-col gap-2">
                  {(snippet?.setupSteps || []).map((line, i) => (
                    <Text key={i} size="sm">
                      {i + 1}. {line}
                    </Text>
                  ))}
                </div>
                {snippet?.webhookUrl ? (
                  <div className="flex flex-col gap-1">
                    <Text size="sm">Worker 推送地址</Text>
                    <ClipboardText
                      text={snippet.webhookUrl}
                      size="base"
                      tooltip={{ text: "复制", copiedText: "已复制" }}
                      labels={{ copyAction: "复制 Webhook" }}
                    />
                  </div>
                ) : null}

                <Tabs
                  tabs={[
                    { value: "js", label: "Worker 代码" },
                    { value: "toml", label: "wrangler.toml" },
                  ]}
                  value={codeTab}
                  onValueChange={setCodeTab}
                />
                {codeTab === "js" && snippet?.js ? (
                  <div className="max-h-72 overflow-auto">
                    <CodeBlock code={snippet.js} lang="ts" />
                  </div>
                ) : null}
                {codeTab === "toml" && snippet?.wranglerToml ? (
                  <div className="max-h-72 overflow-auto">
                    <CodeBlock code={snippet.wranglerToml} lang="bash" />
                  </div>
                ) : null}
                {!snippet ? (
                  <Text variant="secondary" size="sm">
                    Worker 代码加载失败，请刷新页面后重试。
                  </Text>
                ) : null}

                <div className="flex justify-between gap-2">
                  <Button variant="ghost" onClick={() => setStep("forward")}>
                    上一步
                  </Button>
                  <Button icon={ArrowRightIcon} onClick={() => setStep("test")}>
                    下一步：发送测试
                  </Button>
                </div>
              </>
            ) : null}

            {step === "test" ? (
              <>
                <Banner
                  title="第 4 步 · 发送测试邮件"
                  description="用任意邮箱向客户业务地址（已配置转发）发一封测试信，然后在「邮件」页确认是否入站。"
                />
                <LayerCard>
                  <LayerCard.Secondary>检查清单</LayerCard.Secondary>
                  <LayerCard.Primary>
                    <div className="flex flex-col gap-2">
                      <Text size="sm">
                        1. 向 support@{savedDomain || domain || "客户域"}（或你配置的别名）发信
                      </Text>
                      <Text size="sm">2. 确认该地址已转发到 {inboundAddress || "入站地址"}</Text>
                      <Text size="sm">
                        3. 确认 Cloudflare Worker 日志有请求，且 Webhook 返回 2xx
                      </Text>
                      <Text size="sm">4. 打开本后台「邮件」列表，应能看到新记录</Text>
                      <Text size="sm" variant="secondary">
                        本地无真实邮件时，可用仓库脚本 scripts/simulate-inbound.sh 模拟 Worker 推送。
                      </Text>
                    </div>
                  </LayerCard.Primary>
                </LayerCard>
                <div className="flex justify-between gap-2">
                  <Button variant="ghost" onClick={() => setStep("worker")}>
                    上一步
                  </Button>
                  <Button
                    icon={CheckCircleIcon}
                    onClick={() => {
                      toast.success("接入配置已完成", "若收不到信，请再核对转发与 Worker");
                      closeWizard();
                    }}
                  >
                    完成
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        </Dialog>
      </Dialog.Root>
    </AdminShell>
  );
}
