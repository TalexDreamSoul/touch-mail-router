"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Text, useKumoToastManager } from "@cloudflare/kumo";
import { AdminShell } from "@/components/admin-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { SearchBar } from "@/components/search-bar";
import { api, formatDate, qs, type MailMeta } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function MailsPage() {
  const { user } = useAuth();
  const toast = useKumoToastManager();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<MailMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = qs({ q, page, pageSize });
      const res = isAdmin ? await api.adminMails(params) : await api.mails(params);
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      toast.add({
        title: "加载失败",
        description: e instanceof Error ? e.message : "",
      });
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, isAdmin, toast]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const columns: Column<MailMeta>[] = [
    {
      key: "subject",
      header: "主题",
      cell: (r) => (
        <div className="max-w-xs">
          <Text size="sm" truncate>
            {r.subject || "(无主题)"}
          </Text>
          <Text variant="secondary" size="xs" truncate>
            {r.textPreview}
          </Text>
        </div>
      ),
    },
    {
      key: "from",
      header: "发件人",
      cell: (r) => (
        <Text size="sm" truncate>
          {r.from}
        </Text>
      ),
    },
    ...(isAdmin
      ? [
          {
            key: "tenant",
            header: "租户",
            cell: (r: MailMeta) => (
              <Text variant="mono">
                {r.tenant}
              </Text>
            ),
          } as Column<MailMeta>,
        ]
      : []),
    {
      key: "channel",
      header: "渠道",
      cell: (r) => <Badge variant="outline">{r.channel}</Badge>,
    },
    {
      key: "size",
      header: "大小",
      cell: (r) => (
        <Text size="sm" variant="secondary">
          {(r.size / 1024).toFixed(1)} KB
          {r.hasAttachments ? ` · ${r.attachmentCount} 附件` : ""}
        </Text>
      ),
    },
    {
      key: "receivedAt",
      header: "时间",
      cell: (r) => (
        <Text size="sm" variant="secondary">
          {formatDate(r.receivedAt)}
        </Text>
      ),
    },
  ];

  return (
    <AdminShell>
      <PageHeader
        title="邮件"
        description={isAdmin ? "全站入站邮件" : "本租户入站邮件"}
      />
      <div className="mb-4">
        <SearchBar
          value={q}
          placeholder="搜索主题 / 发件人 / 收件人"
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
        emptyTitle="暂无邮件"
        emptyDescription="配置 Worker 并转发邮件后，入站记录会出现在这里"
      />
    </AdminShell>
  );
}
