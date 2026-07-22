"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  EnvelopeSimpleIcon,
  GearIcon,
  GlobeIcon,
  HouseIcon,
  ListBulletsIcon,
  SignOutIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import { Badge, Button, Sidebar, Text } from "@cloudflare/kumo";
import { useAuth } from "@/lib/auth";
import type { ReactNode } from "react";

const nav = [
  { href: "/dashboard", label: "概览", icon: HouseIcon },
  { href: "/users", label: "用户管理", icon: UsersIcon, admin: true },
  { href: "/domains", label: "域名", icon: GlobeIcon },
  { href: "/mails", label: "邮件", icon: EnvelopeSimpleIcon },
  { href: "/audit", label: "审计日志", icon: ListBulletsIcon, admin: true },
  { href: "/settings/feishu", label: "飞书配置", icon: GearIcon, admin: true },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, logout } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-kumo-canvas">
        <Text variant="secondary">加载中…</Text>
      </div>
    );
  }

  if (!user) {
    if (typeof window !== "undefined" && pathname !== "/login") {
      router.replace("/login");
    }
    return (
      <div className="flex min-h-screen items-center justify-center bg-kumo-canvas">
        <Text variant="secondary">跳转登录…</Text>
      </div>
    );
  }

  const items = nav.filter((n) => !n.admin || user.role === "admin");

  return (
    <Sidebar.Provider defaultOpen className="min-h-screen">
      <Sidebar>
        <Sidebar.Header>
          <div className="flex flex-col gap-0.5 px-1">
            <Text variant="heading3" as="span">
              Touch Mail
            </Text>
            <Text variant="secondary" size="xs">
              管理后台
            </Text>
          </div>
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.GroupLabel>菜单</Sidebar.GroupLabel>
            <Sidebar.Menu>
              {items.map((item) => {
                const active =
                  pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <Sidebar.MenuItem key={item.href}>
                    <Sidebar.MenuButton
                      icon={item.icon}
                      active={active}
                      onClick={() => router.push(item.href)}
                    >
                      {item.label}
                    </Sidebar.MenuButton>
                  </Sidebar.MenuItem>
                );
              })}
            </Sidebar.Menu>
          </Sidebar.Group>
        </Sidebar.Content>
        <Sidebar.Footer>
          <div className="flex w-full flex-col gap-2 px-1">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <Text size="sm" truncate>
                  {user.displayName || user.username}
                </Text>
                <Text variant="secondary" size="xs" truncate>
                  {user.tenant}
                </Text>
              </div>
              <Badge variant={user.role === "admin" ? "primary" : "secondary"}>
                {user.role}
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon={SignOutIcon}
              onClick={async () => {
                await logout();
                router.replace("/login");
              }}
            >
              退出
            </Button>
            <Sidebar.Trigger />
          </div>
        </Sidebar.Footer>
      </Sidebar>
      <main className="flex min-h-screen flex-1 flex-col bg-kumo-canvas">
        <div className="mx-auto w-full max-w-6xl flex-1 p-6 md:p-8">{children}</div>
      </main>
    </Sidebar.Provider>
  );
}
