"use client";

import { useEffect, useState } from "react";
import { Badge, ClipboardText, LayerCard, Text } from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { api, formatDate, type MailMeta } from "@/lib/api";
import { useAuth } from "@/lib/auth";

type Dash = {
  inboundAddress?: string;
  domainCount?: number;
  mailCount?: number;
  lastMailAt?: string | null;
  recentMails?: MailMeta[];
  global?: {
    userCount: number;
    domainCount: number;
    adminCount: number;
    activeUserCount: number;
  } | null;
};

export default function DashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .dashboard()
      .then((d) => setData(d as Dash))
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"));
  }, []);

  return (
    <AdminShell>
      <PageHeader
        title="概览"
        description={user ? `欢迎，${user.displayName || user.username}` : undefined}
      />

      {error ? <Text variant="error">{error}</Text> : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="本租户域名" value={String(data?.domainCount ?? "—")} />
        <StatCard label="本租户邮件" value={String(data?.mailCount ?? "—")} />
        <StatCard label="最近入站" value={formatDate(data?.lastMailAt)} />
        <StatCard
          label="角色"
          value={user?.role === "admin" ? "管理员" : "用户"}
        />
      </div>

      {user?.role === "admin" && data?.global ? (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="全站用户" value={String(data.global.userCount)} />
          <StatCard label="活跃用户" value={String(data.global.activeUserCount)} />
          <StatCard label="管理员" value={String(data.global.adminCount)} />
          <StatCard label="全站域名" value={String(data.global.domainCount)} />
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <LayerCard className="p-5">
          <Text variant="heading3" as="h2">
            入站地址
          </Text>
          {data?.inboundAddress ? (
            <div>
              <Text variant="secondary" size="sm">
                转发到此地址
              </Text>
              <ClipboardText text={data.inboundAddress} size="base" />
            </div>
          ) : (
            <Text variant="secondary">加载中…</Text>
          )}
          <Text variant="secondary" size="sm">
            客户把邮箱完整转发到该地址，即可经 Cloudflare Worker 入站。
          </Text>
        </LayerCard>

        <LayerCard className="p-5">
          <Text variant="heading3" as="h2">
            最近邮件
          </Text>
          <div className="flex flex-col gap-3">
            {(data?.recentMails || []).length === 0 ? (
              <Text variant="secondary">暂无邮件</Text>
            ) : (
              (data?.recentMails || []).map((m) => (
                <div
                  key={m.id}
                  className="flex flex-col gap-1 border-b border-kumo-hairline pb-3 last:border-0"
                >
                  <div className="flex items-center justify-between gap-2">
                    <Text size="sm" truncate>
                      {m.subject || "(无主题)"}
                    </Text>
                    {m.hasAttachments ? <Badge variant="outline">附件</Badge> : null}
                  </div>
                  <Text variant="secondary" size="xs">
                    {m.from} · {formatDate(m.receivedAt)}
                  </Text>
                </div>
              ))
            )}
          </div>
        </LayerCard>
      </div>
    </AdminShell>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <LayerCard className="p-4">
      <Text variant="secondary" size="sm">
        {label}
      </Text>
      <Text variant="heading2" as="h2" truncate>
        {value}
      </Text>
    </LayerCard>
  );
}
