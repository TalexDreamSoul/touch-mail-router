"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  Input,
  Select,
  SensitiveInput,
  Text,
} from "@cloudflare/kumo";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { AdminShell } from "@/components/admin-shell";
import { DataTable, type Column } from "@/components/data-table";
import { PageHeader } from "@/components/page-header";
import { SearchBar } from "@/components/search-bar";
import { api, formatDate, qs, type User } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useStableToast } from "@/lib/toast";
import { useRouter } from "next/navigation";

export default function UsersPage() {
  const { user } = useAuth();
  const router = useRouter();
  const toast = useStableToast();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({
    username: "",
    password: "",
    displayName: "",
    role: "user",
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.adminUsers(qs({ q, page, pageSize }));
      setRows(res.items ?? []);
      setTotal(res.total ?? 0);
    } catch (e) {
      toast.error("加载失败", e instanceof Error ? e.message : "错误");
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

  const columns: Column<User>[] = [
    {
      key: "username",
      header: "用户名",
      cell: (r) => (
        <div>
          <Text size="sm">{r.username}</Text>
          <Text variant="secondary" size="xs">
            {r.displayName}
          </Text>
        </div>
      ),
    },
    {
      key: "tenant",
      header: "租户",
      cell: (r) => <Text variant="mono">{r.tenant}</Text>,
    },
    {
      key: "role",
      header: "角色",
      cell: (r) => (
        <Badge variant={r.role === "admin" ? "primary" : "secondary"}>{r.role}</Badge>
      ),
    },
    {
      key: "status",
      header: "状态",
      cell: (r) => (
        <Badge variant={r.status === "active" ? "outline" : "destructive"}>
          {r.status}
        </Badge>
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
            variant="secondary"
            onClick={async () => {
              try {
                await api.updateUser(r.id, {
                  status: r.status === "active" ? "disabled" : "active",
                });
                toast.success("已更新状态");
                void load();
              } catch (e) {
                toast.error("失败", e instanceof Error ? e.message : "");
              }
            }}
          >
            {r.status === "active" ? "禁用" : "启用"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              try {
                await api.updateUser(r.id, {
                  role: r.role === "admin" ? "user" : "admin",
                });
                toast.success("已更新角色");
                void load();
              } catch (e) {
                toast.error("失败", e instanceof Error ? e.message : "");
              }
            }}
          >
            {r.role === "admin" ? "降为用户" : "升为管理员"}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            icon={TrashIcon}
            onClick={async () => {
              if (!confirm(`确认删除用户 ${r.username}？`)) return;
              try {
                await api.deleteUser(r.id);
                toast.success("已删除");
                void load();
              } catch (e) {
                toast.error("失败", e instanceof Error ? e.message : "");
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
        title="用户管理"
        description="管理员可创建、禁用、改角色与删除用户"
        actions={
          <Button icon={PlusIcon} onClick={() => setCreateOpen(true)}>
            新建用户
          </Button>
        }
      />

      <div className="mb-4">
        <SearchBar
          value={q}
          placeholder="搜索用户名 / 显示名 / 租户"
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
        emptyTitle="没有用户"
      />

      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog size="base" className="p-6">
          <Dialog.Title>新建用户</Dialog.Title>
          <div className="mt-4 flex flex-col gap-3">
            <Input
              label="用户名"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <Input
              label="显示名"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
            <SensitiveInput
              label="密码"
              value={form.password}
              onValueChange={(v) => setForm({ ...form, password: v })}
            />
            <Select
              label="角色"
              hideLabel={false}
              value={form.role}
              onValueChange={(v) => setForm({ ...form, role: String(v) })}
            >
              <Select.Option value="user">用户</Select.Option>
              <Select.Option value="admin">管理员</Select.Option>
            </Select>
            <div className="mt-2 flex justify-end gap-2">
              <Dialog.Close
                render={(p) => (
                  <Button {...p} variant="secondary">
                    取消
                  </Button>
                )}
              />
              <Button
                loading={saving}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await api.createUser(form);
                    toast.success("用户已创建");
                    setCreateOpen(false);
                    setForm({ username: "", password: "", displayName: "", role: "user" });
                    void load();
                  } catch (e) {
                    toast.error("创建失败", e instanceof Error ? e.message : "");
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                创建
              </Button>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </AdminShell>
  );
}
