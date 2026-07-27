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
  Select,
  Tabs,
  Text,
} from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  BookOpenIcon,
  CheckCircleIcon,
  PlusIcon,
  RobotIcon,
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
  type DomainSetupGuide,
  type DomainVisibility,
  type ReceiveChannel,
  type SmtpStatus,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useStableToast } from "@/lib/toast";

type WizardStep = "configure" | "scope" | "guide" | "test";
type RoutingScope = "specific" | "all";
type TestState = "idle" | "sending" | "waiting" | "success" | "timeout";

const CHANNEL_LABEL: Record<ReceiveChannel["type"], string> = {
  worker: "Cloudflare Worker",
  email_forward: "邮箱转发",
  donemail: "DoneMail API",
  api_push: "API 主动上报",
};

function makeWorkerName(tenant: string, domain: string): string {
  const suffix = domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `touch-mail-${tenant}-${suffix || "domain"}`.slice(0, 63).replace(/-+$/, "");
}

export default function DomainsPage() {
  const { user } = useAuth();
  const toast = useStableToast();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<Domain[]>([]);
  const [channels, setChannels] = useState<ReceiveChannel[]>([]);
  const [smtp, setSmtp] = useState<SmtpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>("configure");
  const [domain, setDomain] = useState("");
  const [note, setNote] = useState("");
  const [visibility, setVisibility] = useState<DomainVisibility>("private");
  const [receiveChannelId, setReceiveChannelId] = useState("");
  const [workerName, setWorkerName] = useState("");
  const [workerNameTouched, setWorkerNameTouched] = useState(false);
  const [savedDomain, setSavedDomain] = useState<Domain | null>(null);
  const [saving, setSaving] = useState(false);
  const [guide, setGuide] = useState<DomainSetupGuide | null>(null);
  const [guideStepIndex, setGuideStepIndex] = useState(0);
  const [codeTab, setCodeTab] = useState("javascript");
  const [routingScope, setRoutingScope] = useState<RoutingScope>("all");
  const [specificRecipient, setSpecificRecipient] = useState("");
  const [testRecipient, setTestRecipient] = useState("");
  const [testState, setTestState] = useState<TestState>("idle");
  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = qs({ q, page, pageSize });
      const result = isAdmin ? await api.adminDomains(params) : await api.domains(params);
      setRows(result.items ?? []);
      setTotal(result.total ?? 0);
    } catch (error) {
      toast.error("加载失败", error instanceof Error ? error.message : "");
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, isAdmin, toast]);

  useEffect(() => {
    if (!user) return;
    void load();
    api
      .receiveChannels()
      .then((result) => {
        setChannels(result.items || []);
        setReceiveChannelId((current) => current || result.items?.[0]?.id || "");
      })
      .catch((error) =>
        toast.error("无法加载收件渠道", error instanceof Error ? error.message : ""),
      );
    api.smtpStatus().then(setSmtp).catch(() => setSmtp(null));
  }, [user, load, toast]);

  const selectedChannel = channels.find((channel) => channel.id === receiveChannelId) || null;
  const canManageSavedDomain = !savedDomain || !isAdmin || savedDomain.userId === user?.id;

  async function loadGuide(
    domainId: string,
    scope: RoutingScope = routingScope,
    address: string = specificRecipient,
  ) {
    try {
      const result = await api.domainSetupGuide(domainId, scope, address.trim().toLowerCase());
      setGuide(result);
      setGuideStepIndex(0);
      setTestRecipient(result.testRecipient);
      setStep("guide");
    } catch (error) {
      toast.error("接入向导加载失败", error instanceof Error ? error.message : "");
    }
  }

  function resetWizard() {
    setStep("configure");
    setDomain("");
    setNote("");
    setVisibility("private");
    setReceiveChannelId(channels[0]?.id || "");
    setWorkerName("");
    setWorkerNameTouched(false);
    setSavedDomain(null);
    setGuide(null);
    setGuideStepIndex(0);
    setCodeTab("javascript");
    setRoutingScope("all");
    setSpecificRecipient("");
    setTestRecipient("");
    setTestState("idle");
  }

  function openWizard(item?: Domain) {
    if (!item) {
      resetWizard();
      setOpen(true);
      return;
    }
    setDomain(item.domain);
    setNote(item.note || "");
    setVisibility(item.visibility);
    setReceiveChannelId(item.receiveChannelId || "");
    setWorkerName(item.workerName || "");
    setWorkerNameTouched(Boolean(item.workerName));
    setSavedDomain(item);
    setGuide(null);
    setGuideStepIndex(0);
    setRoutingScope("all");
    setSpecificRecipient("");
    setTestRecipient(`test@${item.domain}`);
    setTestState("idle");
    setCodeTab("javascript");
    const channel = channels.find((candidate) => candidate.id === item.receiveChannelId);
    const needsScope = channel?.type === "worker" || channel?.type === "email_forward";
    setStep(needsScope ? "scope" : "guide");
    setOpen(true);
    if (channel && !needsScope && (!isAdmin || item.userId === user?.id)) {
      void loadGuide(item.id, "all", "");
    }
  }

  async function saveDomain() {
    const normalizedDomain = domain.trim().toLowerCase();
    if (!normalizedDomain) {
      toast.error("请填写域名");
      return;
    }
    if (!selectedChannel) {
      toast.error("请选择管理员已启用的收件渠道");
      return;
    }
    if (selectedChannel.type === "worker" && !workerName.trim()) {
      toast.error("必须填写 Worker Name");
      return;
    }
    setSaving(true);
    try {
      const result = savedDomain
        ? await api.updateDomain(savedDomain.id, {
            note,
            visibility,
            receiveChannelId: selectedChannel.id,
            workerName,
          })
        : await api.createDomain(
            normalizedDomain,
            note,
            visibility,
            selectedChannel.id,
            workerName,
          );
      setSavedDomain(result.domain);
      setDomain(result.domain.domain);
      setWorkerName(result.domain.workerName || workerName);
      setTestRecipient(`test@${result.domain.domain}`);
      setGuide(null);
      setGuideStepIndex(0);
      setTestState("idle");
      toast.success(savedDomain ? "域名接入配置已更新" : "域名已登记");
      await load();
      if (selectedChannel.type === "worker" || selectedChannel.type === "email_forward") {
        setStep("scope");
      } else {
        await loadGuide(result.domain.id, "all", "");
      }
    } catch (error) {
      toast.error("保存失败", error instanceof Error ? error.message : "");
    } finally {
      setSaving(false);
    }
  }

  async function runDomainTest() {
    if (!savedDomain) return;
    if (!smtp?.enabled) {
      toast.error("无法发送测试邮件", "管理员尚未启用 SMTP");
      return;
    }
    setTestState("sending");
    try {
      const sent = await api.sendDomainTest(savedDomain.id, testRecipient);
      setTestRecipient(sent.recipient);
      setTestState("waiting");
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const status = await api.domainTestStatus(savedDomain.id, sent.token);
        if (status.received) {
          setTestState("success");
          toast.success("域名接入成功", "测试邮件已经从所选收件渠道回到系统");
          return;
        }
      }
      setTestState("timeout");
    } catch (error) {
      setTestState("idle");
      toast.error("接入测试失败", error instanceof Error ? error.message : "");
    }
  }

  async function copyCode(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label}已复制`);
    } catch {
      toast.error("复制失败", "请手动选择代码复制");
    }
  }

  async function toggleVisibility(item: Domain) {
    if (isAdmin && item.userId !== user?.id) {
      toast.error("只能修改自己的域名可见性");
      return;
    }
    const next: DomainVisibility = item.visibility === "public" ? "private" : "public";
    try {
      await api.updateDomain(item.id, { visibility: next });
      toast.success(next === "public" ? "已设为公开" : "已设为私有");
      void load();
    } catch (error) {
      toast.error("更新失败", error instanceof Error ? error.message : "");
    }
  }

  const columns: Column<Domain>[] = [
    {
      key: "domain",
      header: "域名",
      cell: (item) => <Text size="sm">{item.domain}</Text>,
    },
    {
      key: "channel",
      header: "收件渠道",
      cell: (item) => {
        const channel = channels.find((candidate) => candidate.id === item.receiveChannelId);
        return channel ? (
          <div className="flex flex-col gap-1">
            <Text size="sm">{channel.name}</Text>
            <Badge variant="outline">{CHANNEL_LABEL[channel.type]}</Badge>
          </div>
        ) : (
          <Badge variant="secondary">未配置</Badge>
        );
      },
    },
    {
      key: "visibility",
      header: "可见性",
      cell: (item) => (
        <Badge variant={item.visibility === "public" ? "primary" : "secondary"}>
          {item.visibility === "public" ? "公开" : "私有"}
        </Badge>
      ),
    },
    ...(isAdmin
      ? [
          {
            key: "owner",
            header: "所属用户",
            cell: (item: Domain) => (
              <Text size="sm" variant="secondary">
                {item.username || item.userId} / {item.tenant || "—"}
              </Text>
            ),
          } as Column<Domain>,
        ]
      : []),
    {
      key: "createdAt",
      header: "添加时间",
      cell: (item) => (
        <Text size="sm" variant="secondary">
          {formatDate(item.createdAt)}
        </Text>
      ),
    },
    {
      key: "actions",
      header: "操作",
      cell: (item) => (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={BookOpenIcon}
            onClick={() => openWizard(item)}
          >
            接入配置
          </Button>
          {(!isAdmin || item.userId === user?.id) && (
            <Button size="sm" variant="ghost" onClick={() => void toggleVisibility(item)}>
              {item.visibility === "public" ? "改私有" : "改公开"}
            </Button>
          )}
          <Button
            size="sm"
            variant="destructive"
            icon={TrashIcon}
            onClick={async () => {
              if (!confirm(`删除域名 ${item.domain}？`)) return;
              try {
                if (isAdmin && item.userId !== user?.id) await api.adminDeleteDomain(item.id);
                else await api.deleteDomain(item.id);
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

  const needsScope = selectedChannel?.type === "worker" || selectedChannel?.type === "email_forward";
  const guideProgressSteps = guide?.steps.length
    ? guide.steps.map((item, index) => ({
        key: `guide-${item.id}`,
        kind: "guide" as const,
        label: item.title,
        guideIndex: index,
      }))
    : [{ key: "guide", kind: "guide" as const, label: "接入配置", guideIndex: 0 }];
  const progressSteps = [
    { key: "configure", kind: "configure" as const, label: "域名与渠道" },
    ...(needsScope
      ? [{ key: "scope", kind: "scope" as const, label: "收件范围" }]
      : []),
    ...guideProgressSteps,
    { key: "test", kind: "test" as const, label: "自动测试" },
  ];
  const currentProgressIndex =
    step === "configure"
      ? 0
      : step === "scope"
        ? 1
        : step === "guide"
          ? (needsScope ? 2 : 1) + guideStepIndex
          : progressSteps.length - 1;
  const normalizedSpecificRecipient = specificRecipient.trim().toLowerCase();
  const specificRecipientValid = Boolean(
    savedDomain &&
      normalizedSpecificRecipient.split("@").length === 2 &&
      normalizedSpecificRecipient.endsWith(`@${savedDomain.domain}`),
  );
  const currentGuideStep = guide?.steps[guideStepIndex] || null;
  const busyTesting = testState === "sending" || testState === "waiting";

  return (
    <AdminShell>
      <PageHeader
        title="域名"
        description="为域名选择管理员发布的收件渠道，并按渠道完成接入"
        actions={
          <Button icon={PlusIcon} onClick={() => openWizard()} disabled={channels.length === 0}>
            添加域名
          </Button>
        }
      />
      {channels.length === 0 ? (
        <Banner
          className="mb-4"
          variant="alert"
          title="暂无可用收件渠道"
          description="需要管理员先在“收件渠道”中创建并启用至少一个渠道。"
        />
      ) : (
        <Banner
          className="mb-4"
          variant="secondary"
          title="先选收件渠道，再按渠道配置"
          description="Worker 直连不需要邮箱转发；只有选择邮箱转发渠道时，才需要把原邮箱转到管理员配置的目标地址。"
        />
      )}

      <div className="mb-4">
        <SearchBar
          value={q}
          placeholder="搜索域名 / 备注"
          onSearch={(value) => {
            setPage(1);
            setQ(value);
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
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) resetWizard();
        }}
      >
        <Dialog size="xl" className="max-h-[90vh] overflow-y-auto p-6">
          <Dialog.Title>域名接入</Dialog.Title>
          <div className="mt-1">
            <Text size="sm" variant="secondary">
              收件渠道由管理员维护；配置完成后系统使用 SMTP 自动发信验证整条链路。
            </Text>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {progressSteps.map((item, index) => (
              <Button
                key={item.key}
                size="sm"
                variant={index === currentProgressIndex ? "primary" : index < currentProgressIndex ? "secondary" : "ghost"}
                icon={index < currentProgressIndex ? CheckCircleIcon : undefined}
                disabled={!savedDomain && item.kind !== "configure"}
                onClick={() => {
                  if (item.kind === "guide") {
                    setGuideStepIndex(item.guideIndex);
                    setStep("guide");
                  } else {
                    setStep(item.kind);
                  }
                }}
              >
                {index + 1}. {item.label}
              </Button>
            ))}
          </div>

          <div className="mt-6 flex flex-col gap-4">
            {step === "configure" ? (
              <>
                {!canManageSavedDomain ? (
                  <Banner
                    variant="alert"
                    title="只读配置"
                    description="管理员正在查看其他用户的域名；请由域名所属用户修改接入配置。"
                  />
                ) : null}
                <Input
                  label="域名"
                  value={domain}
                  disabled={Boolean(savedDomain) || !canManageSavedDomain}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDomain(value);
                    if (!workerNameTouched && user) setWorkerName(makeWorkerName(user.tenant, value));
                  }}
                  placeholder="example.com"
                  required
                />
                <Input
                  label="备注"
                  value={note}
                  disabled={!canManageSavedDomain}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="例如：客户 A 的业务邮箱"
                />
                <Select
                  label="收件渠道"
                  description="只能选择管理员已经启用的渠道"
                  hideLabel={false}
                  value={receiveChannelId}
                  disabled={!canManageSavedDomain}
                  onValueChange={(value) => {
                    const channelId = String(value);
                    const channel = channels.find((candidate) => candidate.id === channelId);
                    setReceiveChannelId(channelId);
                    if (channel?.type === "worker" && !workerNameTouched && user) {
                      setWorkerName(makeWorkerName(user.tenant, domain));
                    }
                  }}
                >
                  {channels.map((channel) => (
                    <Select.Option key={channel.id} value={channel.id}>
                      {channel.name} · {CHANNEL_LABEL[channel.type]}
                    </Select.Option>
                  ))}
                </Select>
                {selectedChannel ? (
                  <Banner
                    variant="secondary"
                    title={CHANNEL_LABEL[selectedChannel.type]}
                    description={selectedChannel.description || "管理员已启用该收件渠道"}
                  />
                ) : null}
                {selectedChannel?.type === "worker" ? (
                  <>
                    <Input
                      label="Worker Name"
                      description="必须与 Cloudflare 中创建的 Worker 名称完全一致；可修改，但两边必须同步。"
                      value={workerName}
                      disabled={!canManageSavedDomain}
                      onChange={(event) => {
                        setWorkerNameTouched(true);
                        setWorkerName(event.target.value.toLowerCase());
                      }}
                      placeholder="touch-mail-tenant-example-com"
                      required
                    />
                    {workerName ? (
                      <ClipboardText
                        text={workerName}
                        size="base"
                        tooltip={{ text: "复制", copiedText: "已复制" }}
                        labels={{ copyAction: "复制 Worker Name" }}
                      />
                    ) : null}
                  </>
                ) : null}
                <Select
                  label="DuckMail /domains 可见性"
                  hideLabel={false}
                  value={visibility}
                  disabled={!canManageSavedDomain}
                  onValueChange={(value) =>
                    setVisibility(value === "public" ? "public" : "private")
                  }
                >
                  <Select.Option value="private">私有（推荐）</Select.Option>
                  <Select.Option value="public">公开</Select.Option>
                </Select>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setOpen(false)}>
                    取消
                  </Button>
                  <Button
                    loading={saving}
                    disabled={!canManageSavedDomain || !selectedChannel}
                    icon={ArrowRightIcon}
                    onClick={() => void saveDomain()}
                  >
                    保存并查看接入配置
                  </Button>
                </div>
              </>
            ) : null}

            {step === "scope" && savedDomain ? (
              <>
                <Banner
                  title="选择要接收的邮箱范围"
                  description="向导会根据选择生成 Cloudflare 或邮箱服务商中需要填写的精确值。"
                />
                <Select
                  label="收件范围"
                  hideLabel={false}
                  value={routingScope}
                  onValueChange={(value) => {
                    const scope = value === "specific" ? "specific" : "all";
                    setRoutingScope(scope);
                    setGuide(null);
                    setTestState("idle");
                    setTestRecipient(scope === "all" ? `test@${savedDomain.domain}` : specificRecipient);
                  }}
                >
                  <Select.Option value="all">整个域名的所有邮箱（Catch-all）</Select.Option>
                  <Select.Option value="specific">仅一个特定邮箱地址</Select.Option>
                </Select>
                {routingScope === "specific" ? (
                  <Input
                    label="要接收的完整邮箱地址"
                    description={`必须属于 ${savedDomain.domain}，例如 support@${savedDomain.domain}`}
                    type="email"
                    value={specificRecipient}
                    onChange={(event) => {
                      const value = event.target.value.toLowerCase();
                      setSpecificRecipient(value);
                      setTestRecipient(value);
                      setGuide(null);
                      setTestState("idle");
                    }}
                    placeholder={`support@${savedDomain.domain}`}
                    required
                  />
                ) : (
                  <Banner
                    variant="alert"
                    title="匹配全部邮箱不等于填写星号"
                    description="Cloudflare 中不要在 Custom address 填 * 或 *@域名；后续步骤会引导你编辑 Catch-all address。"
                  />
                )}
                <div className="flex justify-between gap-2">
                  <Button variant="ghost" onClick={() => setStep("configure")}>上一步</Button>
                  <Button
                    icon={ArrowRightIcon}
                    disabled={routingScope === "specific" && !specificRecipientValid}
                    onClick={() => void loadGuide(savedDomain.id)}
                  >
                    生成分步配置
                  </Button>
                </div>
              </>
            ) : null}

            {step === "guide" && savedDomain ? (
              <>
                {currentGuideStep ? (
                  <>
                    <Banner
                      title={currentGuideStep.title}
                      description={`步骤 ${guideStepIndex + 1} / ${guide?.steps.length || 1}，完成本页操作后再继续。`}
                    />
                    {guideStepIndex === 0 && guide?.agentPrompt ? (
                      <LayerCard>
                        <LayerCard.Secondary>AI 自动接入</LayerCard.Secondary>
                        <LayerCard.Primary>
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <Text size="sm" variant="secondary">
                              已包含当前域名、Worker、DNS、Email Routing、Rules、验证与回滚要求。
                            </Text>
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={RobotIcon}
                              onClick={() => void copyCode(guide.agentPrompt, "AI 接入 Prompt")}
                            >
                              复制 AI Prompt
                            </Button>
                          </div>
                        </LayerCard.Primary>
                      </LayerCard>
                    ) : null}
                    {currentGuideStep.warning ? (
                      <Banner
                        variant="alert"
                        title="请注意"
                        description={currentGuideStep.warning}
                      />
                    ) : null}
                    {currentGuideStep.instructions?.length ? (
                      <LayerCard>
                        <LayerCard.Secondary>操作路径</LayerCard.Secondary>
                        <LayerCard.Primary>
                          <div className="flex flex-col gap-2">
                            {currentGuideStep.instructions.map((line, index) => (
                              <Text key={`${index}-${line}`} size="sm">
                                {index + 1}. {line}
                              </Text>
                            ))}
                          </div>
                        </LayerCard.Primary>
                      </LayerCard>
                    ) : null}
                    {currentGuideStep.fields?.length ? (
                      <div className="grid gap-3 md:grid-cols-2">
                        {currentGuideStep.fields.map((field) => (
                          <LayerCard key={field.name}>
                            <LayerCard.Secondary>
                              <div className="flex items-center justify-between gap-2">
                                <span>{field.name}</span>
                                {field.kind === "secret" ? <Badge variant="primary">Secret</Badge> : null}
                              </div>
                            </LayerCard.Secondary>
                            <LayerCard.Primary>
                              {field.copyable ? (
                                <ClipboardText
                                  text={String(field.value)}
                                  size="sm"
                                  tooltip={{ text: "复制", copiedText: "已复制" }}
                                  labels={{ copyAction: `复制 ${field.name}` }}
                                />
                              ) : (
                                <Text size="sm">{String(field.value)}</Text>
                              )}
                            </LayerCard.Primary>
                          </LayerCard>
                        ))}
                      </div>
                    ) : null}
                    {currentGuideStep.code ? (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Tabs
                            tabs={[
                              { value: "javascript", label: "Worker 代码" },
                              { value: "wranglerToml", label: "wrangler.toml" },
                            ]}
                            value={codeTab}
                            onValueChange={setCodeTab}
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              void copyCode(
                                codeTab === "javascript"
                                  ? currentGuideStep.code?.javascript || ""
                                  : currentGuideStep.code?.wranglerToml || "",
                                codeTab === "javascript" ? "Worker 代码" : "wrangler.toml",
                              )
                            }
                          >
                            复制当前代码
                          </Button>
                        </div>
                        <div className="max-h-80 overflow-auto">
                          <CodeBlock
                            code={
                              codeTab === "javascript"
                                ? currentGuideStep.code.javascript
                                : currentGuideStep.code.wranglerToml
                            }
                            lang={codeTab === "javascript" ? "ts" : "bash"}
                          />
                        </div>
                      </>
                    ) : null}
                    <div className="flex justify-between gap-2">
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (guideStepIndex > 0) setGuideStepIndex(guideStepIndex - 1);
                          else setStep(needsScope ? "scope" : "configure");
                        }}
                      >
                        上一步
                      </Button>
                      <Button
                        icon={ArrowRightIcon}
                        onClick={() => {
                          if (guide && guideStepIndex < guide.steps.length - 1) {
                            setGuideStepIndex(guideStepIndex + 1);
                          } else {
                            setStep("test");
                          }
                        }}
                      >
                        {guide && guideStepIndex < guide.steps.length - 1
                          ? "已完成，下一步"
                          : "配置已完成，去测试"}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <Banner
                      variant="alert"
                      title="向导尚未加载"
                      description="请重新加载当前渠道的结构化接入步骤。"
                    />
                    <Button variant="secondary" onClick={() => void loadGuide(savedDomain.id)}>
                      重新加载接入向导
                    </Button>
                  </>
                )}
              </>
            ) : null}

            {step === "test" && savedDomain ? (
              <>
                <Banner
                  title="系统自动发送并验证测试邮件"
                  description="系统通过管理员 SMTP 发一封带唯一标识的邮件，然后自动等待它从当前收件渠道回到后台。"
                />
                {!smtp?.enabled ? (
                  <Banner
                    variant="alert"
                    title="SMTP 尚未配置"
                    description="管理员必须先在 SMTP 配置中启用发信，域名接入测试才能运行。"
                  />
                ) : null}
                <Input
                  label="测试收件地址"
                  description={`必须属于 ${savedDomain.domain}；如果你创建了精确地址路由，请填写与路由一致的地址。`}
                  type="email"
                  value={testRecipient}
                  onChange={(event) => {
                    setTestRecipient(event.target.value);
                    setTestState("idle");
                  }}
                  placeholder={`test@${savedDomain.domain}`}
                />
                <ClipboardText
                  text={testRecipient || `test@${savedDomain.domain}`}
                  size="base"
                  tooltip={{ text: "复制", copiedText: "已复制" }}
                  labels={{ copyAction: "复制测试地址" }}
                />
                {testState === "waiting" ? (
                  <Banner
                    variant="secondary"
                    title="测试邮件已发送，正在等待入站"
                    description="最长等待约 60 秒，请不要关闭本窗口。"
                  />
                ) : null}
                {testState === "success" ? (
                  <Banner
                    title="域名接入成功"
                    description="测试邮件已从所选渠道回到系统，发信、路由、Worker/API 和入库链路均正常。"
                  />
                ) : null}
                {testState === "timeout" ? (
                  <Banner
                    variant="alert"
                    title="暂未收到测试邮件"
                    description="请核对 MX、Email Routing 规则、Worker Name、渠道配置和上游日志，然后重新测试。"
                  />
                ) : null}
                <LayerCard>
                  <LayerCard.Secondary>测试前检查</LayerCard.Secondary>
                  <LayerCard.Primary>
                    <div className="flex flex-col gap-2">
                      <Text size="sm">1. SMTP 已启用并通过连接测试</Text>
                      <Text size="sm">2. 已逐步完成当前渠道的全部配置</Text>
                      <Text size="sm">
                        3. 当前范围：{routingScope === "all" ? "整个域名（Catch-all）" : testRecipient}
                      </Text>
                      <Text size="sm">
                        4. 收集方式：
                        {selectedChannel?.type === "email_forward"
                          ? selectedChannel.collectorType === "donemail"
                            ? "DoneMail API 拉取"
                            : "接收 Worker Webhook 推送"
                          : CHANNEL_LABEL[selectedChannel?.type || "worker"]}
                      </Text>
                    </div>
                  </LayerCard.Primary>
                </LayerCard>
                <div className="flex justify-between gap-2">
                  <Button
                    variant="ghost"
                    disabled={busyTesting}
                    onClick={() => {
                      setGuideStepIndex(Math.max(0, (guide?.steps.length || 1) - 1));
                      setStep("guide");
                    }}
                  >
                    上一步
                  </Button>
                  <div className="flex gap-2">
                    <Button
                      loading={busyTesting}
                      disabled={
                        !isAdmin ||
                        !smtp?.enabled ||
                        !testRecipient.trim() ||
                        !canManageSavedDomain
                      }
                      onClick={() => void runDomainTest()}
                    >
                      {testState === "success" ? "重新测试" : "发送并自动验证"}
                    </Button>
                    {testState === "success" ? (
                      <Button
                        icon={CheckCircleIcon}
                        onClick={() => {
                          setOpen(false);
                          resetWizard();
                        }}
                      >
                        完成
                      </Button>
                    ) : null}
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </Dialog>
      </Dialog.Root>
    </AdminShell>
  );
}
