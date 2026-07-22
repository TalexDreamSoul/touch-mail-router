"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  EnvelopeSimpleIcon,
  GearIcon,
  GlobeIcon,
  HouseIcon,
  KeyIcon,
  ListBulletsIcon,
  MoonIcon,
  PaletteIcon,
  SignOutIcon,
  SunIcon,
  UserCircleIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import {
  Badge,
  Button,
  DropdownMenu,
  Loader,
  Sidebar,
  Surface,
  Text,
} from "@cloudflare/kumo";
import { useAuth } from "@/lib/auth";
import { useTheme, type ThemeMode } from "@/lib/theme";
import type { ReactNode } from "react";

type NavItem = {
  href: string;
  label: string;
  icon: typeof HouseIcon;
  admin?: boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    label: "工作台",
    items: [
      { href: "/dashboard", label: "概览", icon: HouseIcon },
      { href: "/domains", label: "域名", icon: GlobeIcon },
      { href: "/mails", label: "邮件", icon: EnvelopeSimpleIcon },
    ],
  },
  {
    label: "个人",
    items: [
      { href: "/settings", label: "个人设置", icon: UserCircleIcon },
      { href: "/api-keys", label: "API Keys", icon: KeyIcon },
    ],
  },
  {
    label: "管理",
    items: [
      { href: "/users", label: "用户管理", icon: UsersIcon, admin: true },
      { href: "/audit", label: "审计日志", icon: ListBulletsIcon, admin: true },
      { href: "/settings/feishu", label: "飞书配置", icon: GearIcon, admin: true },
    ],
  },
];

function initials(name: string): string {
  const s = (name || "?").trim();
  if (!s) return "?";
  const parts = s.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, logout } = useAuth();
  const { theme, setTheme } = useTheme();

  if (loading) {
    return (
      <Surface className="flex min-h-screen items-center justify-center gap-2">
        <Loader />
        <Text variant="secondary">加载中…</Text>
      </Surface>
    );
  }

  if (!user) {
    if (typeof window !== "undefined" && pathname !== "/login") {
      router.replace("/login");
    }
    return (
      <Surface className="flex min-h-screen items-center justify-center">
        <Text variant="secondary">跳转登录…</Text>
      </Surface>
    );
  }

  const groups = navGroups
    .map((g) => ({
      ...g,
      items: g.items.filter((n) => !n.admin || user.role === "admin"),
    }))
    .filter((g) => g.items.length > 0);

  const displayName = user.displayName || user.username;

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  return (
    <Sidebar.Provider defaultOpen className="min-h-screen">
      <Sidebar className="flex h-screen flex-col">
        <Sidebar.Header className="!flex !w-full !items-center !justify-between !gap-2">
          <div className="min-w-0 flex-1">
            <Text variant="heading3" as="span">
              Touch Mail
            </Text>
            <Text variant="secondary" size="xs">
              管理后台
            </Text>
          </div>
          <Sidebar.Trigger className="shrink-0" />
        </Sidebar.Header>

        <Sidebar.Content className="flex-1 overflow-y-auto">
          {groups.map((group) => (
            <Sidebar.Group key={group.label}>
              <Sidebar.GroupLabel>{group.label}</Sidebar.GroupLabel>
              <Sidebar.Menu>
                {group.items.map((item) => {
                  const active =
                    pathname === item.href ||
                    (item.href !== "/settings" && pathname.startsWith(`${item.href}/`)) ||
                    (item.href === "/settings" && pathname === "/settings");
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
          ))}
        </Sidebar.Content>

        {/*
          Kumo Sidebar.Footer 默认是 h-12 + 横向 flex + overflow-hidden，
          多行内容会被裁切/叠在一起，这里强制改成纵向自适应高度。
        */}
        <Sidebar.Footer className="!h-auto !min-h-0 !w-full !flex-col !items-stretch !gap-0 !overflow-visible !whitespace-normal !px-2 !py-2">
          <div className="flex w-full min-w-0 items-center gap-1">
            {/* 头像 + 名称（点进个人设置） */}
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1 py-1 text-left hover:bg-kumo-contrast/5"
              onClick={() => router.push("/settings")}
              title="打开个人设置"
            >
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-kumo-contrast/10 text-xs font-semibold"
                aria-hidden
              >
                {initials(displayName)}
              </div>
              <div className="min-w-0 flex-1 overflow-hidden">
                <Text size="sm" truncate>
                  {displayName}
                </Text>
                <div className="flex min-w-0 items-center gap-1">
                  <Text variant="secondary" size="xs" truncate>
                    @{user.username}
                  </Text>
                  <Badge variant={user.role === "admin" ? "primary" : "secondary"}>
                    {user.role}
                  </Badge>
                </div>
              </div>
            </button>

            {/* 右侧齿轮：账号菜单（Trigger 自带 button，勿再嵌套 Button） */}
            <DropdownMenu>
              <DropdownMenu.Trigger
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-kumo-contrast/10"
                aria-label="账号菜单"
                title="账号菜单"
              >
                <GearIcon size={18} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content side="top" align="end" sideOffset={8}>
                <DropdownMenu.Label>账号</DropdownMenu.Label>
                <DropdownMenu.Item
                  icon={UserCircleIcon}
                  onClick={() => router.push("/settings")}
                >
                  个人设置
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  icon={KeyIcon}
                  onClick={() => router.push("/api-keys")}
                >
                  API Keys
                </DropdownMenu.Item>

                <DropdownMenu.Separator />
                <DropdownMenu.Label>个性化 · 主题</DropdownMenu.Label>
                <DropdownMenu.Item
                  icon={PaletteIcon}
                  onClick={() => setTheme("system")}
                >
                  跟随系统{theme === "system" ? " ✓" : ""}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  icon={SunIcon}
                  onClick={() => setTheme("light")}
                >
                  浅色{theme === "light" ? " ✓" : ""}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  icon={MoonIcon}
                  onClick={() => setTheme("dark")}
                >
                  深色{theme === "dark" ? " ✓" : ""}
                </DropdownMenu.Item>

                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  icon={SignOutIcon}
                  variant="danger"
                  onClick={() => void handleLogout()}
                >
                  退出登录
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          </div>
        </Sidebar.Footer>
      </Sidebar>

      <Surface as="main" className="min-h-screen flex-1">
        <div className="mx-auto w-full max-w-6xl p-6 md:p-8">{children}</div>
      </Surface>
    </Sidebar.Provider>
  );
}
