"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Text } from "@cloudflare/kumo";
import { useRouter } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { SearchBar } from "@/components/search-bar";
import { api, formatDate, qs, type AuditLog } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useStableToast } from "@/lib/toast";

export default function AuditPage() {
  const { user } = useAuth();
  const router = useRouter();
  const toast = useStableToast();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.auditLogs(qs({ q, page, pageSize }));
      setRows(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (e) {
      toast.error("加载失败", e instanceof Error ? e.message : "");
    } finally {
      setLoading(false);
    }
  }, [q, page, pageSize, toast]);

  useEffect(() => {
    if (user && user.role !== "admin") {
      router.replace("/dashboard");
      return;
    }
    if (user?.role === "admin") void load();
  }, [user?.id, user?.role, load, router]);

  const columns: Column<AuditLog>[] = [
    {
      key: "createdAt",
      header: "时间",
      cell: (r) => (
        <Text size="sm" variant="secondary">
          {formatDate(r.createdAt)}
        </Text>
      ),
    },
    {
      key: "actor",
      header: "操作者",
      cell: (r) => <Text size="sm">{r.actorUsername || "—"}</Text>,
    },
    {
      key: "action",
      header: "动作",
      cell: (r) => <Badge variant="secondary">{r.action}</Badge>,
    },
    {
      key: "resource",
      header: "资源",
      cell: (r) => (
        <div>
          <Text size="sm">{r.resource}</Text>
          {r.resourceId ? (
            <Text variant="mono-secondary">{r.resourceId}</Text>
          ) : null}
        </div>
      ),
    },
    {
      key: "detail",
      header: "详情",
      cell: (r) => (
        <Text size="sm" variant="secondary" truncate>
          {r.detail || "—"}
        </Text>
      ),
    },
    {
      key: "ip",
      header: "IP",
      cell: (r) => <Text variant="mono-secondary">{r.ip || "—"}</Text>,
    },
  ];

  return (
    <AdminShell>
      <PageHeader title="审计日志" description="登录、用户变更、配置与入站等操作记录" />
      <div className="mb-4">
        <SearchBar
          value={q}
          placeholder="搜索操作者 / 动作 / 资源 / 详情"
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
        emptyTitle="暂无审计记录"
      />
    </AdminShell>
  );
}
