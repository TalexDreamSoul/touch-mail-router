"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Dialog, Input, Text, useKumoToastManager } from "@cloudflare/kumo";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { AdminShell } from "@/components/admin-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { SearchBar } from "@/components/search-bar";
import { api, formatDate, qs, type Domain } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function DomainsPage() {
  const { user } = useAuth();
  const toast = useKumoToastManager();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = qs({ q, page, pageSize });
      const res = isAdmin ? await api.adminDomains(params) : await api.domains(params);
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

  const columns: Column<Domain>[] = [
    {
      key: "domain",
      header: "域名",
      cell: (r) => <Text size="sm">{r.domain}</Text>,
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
        <Button
          size="sm"
          variant="destructive"
          icon={TrashIcon}
          onClick={async () => {
            if (!confirm(`删除域名 ${r.domain}？`)) return;
            try {
              if (isAdmin) await api.adminDeleteDomain(r.id);
              else await api.deleteDomain(r.id);
              toast.add({ title: "已删除" });
              void load();
            } catch (e) {
              toast.add({
                title: "删除失败",
                description: e instanceof Error ? e.message : "",
              });
            }
          }}
        >
          删除
        </Button>
      ),
    },
  ];

  return (
    <AdminShell>
      <PageHeader
        title="域名"
        description={isAdmin ? "全站客户域名台账" : "你绑定的客户域名"}
        actions={
          !isAdmin || true ? (
            <Button icon={PlusIcon} onClick={() => setOpen(true)}>
              添加域名
            </Button>
          ) : null
        }
      />

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

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog size="base" className="p-6">
          <Dialog.Title>添加域名</Dialog.Title>
          <div className="mt-4 flex flex-col gap-3">
            <Input
              label="域名"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
            />
            <Input
              label="备注"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="可选"
            />
            <div className="mt-2 flex justify-end gap-2">
              <Dialog.Close render={(p) => <Button {...p} variant="secondary">取消</Button>} />
              <Button
                loading={saving}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await api.createDomain(domain, note);
                    toast.add({ title: "已添加" });
                    setOpen(false);
                    setDomain("");
                    setNote("");
                    void load();
                  } catch (e) {
                    toast.add({
                      title: "失败",
                      description: e instanceof Error ? e.message : "",
                    });
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                保存
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </AdminShell>
  );
}
