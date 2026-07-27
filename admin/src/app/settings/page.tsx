"use client";

import {
  Button,
  LayerCard,
  Text,
} from "@cloudflare/kumo";
import { KeyIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { AdminShell } from "@/components/admin-shell";
import { PageHeader } from "@/components/page-header";
import { useAuth } from "@/lib/auth";
import { useTheme, type ThemeMode } from "@/lib/theme";

export default function SettingsPage() {
  const { user } = useAuth();
  const { theme, setTheme, resolved } = useTheme();
  const router = useRouter();

  return (
    <AdminShell>
      <PageHeader title="个人设置" description="账号信息与外观主题" />

      <div className="flex flex-col gap-6">
        <LayerCard>
          <LayerCard.Secondary>账号</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Text size="xs" variant="secondary">
                  显示名
                </Text>
                <Text size="sm">{user?.displayName || user?.username}</Text>
              </div>
              <div>
                <Text size="xs" variant="secondary">
                  用户名
                </Text>
                <Text size="sm">{user?.username}</Text>
              </div>
              <div>
                <Text size="xs" variant="secondary">
                  租户
                </Text>
                <Text size="sm">{user?.tenant}</Text>
              </div>
              <div>
                <Text size="xs" variant="secondary">
                  收件方式
                </Text>
                <Text size="sm">按域名选择管理员收件渠道</Text>
              </div>
            </div>
            <div className="mt-4">
              <Button
                size="sm"
                variant="secondary"
                icon={KeyIcon}
                onClick={() => router.push("/api-keys")}
              >
                管理 API Keys
              </Button>
            </div>
          </LayerCard.Primary>
        </LayerCard>

        <LayerCard>
          <LayerCard.Secondary>主题</LayerCard.Secondary>
          <LayerCard.Primary>
            <div className="flex flex-col gap-3">
              <Text size="sm" variant="secondary">
                当前生效：{resolved === "dark" ? "深色" : "浅色"}
                {theme === "system" ? "（跟随系统）" : ""}
              </Text>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["system", "跟随系统"],
                    ["light", "浅色"],
                    ["dark", "深色"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={theme === value ? "primary" : "secondary"}
                    onClick={() => setTheme(value as ThemeMode)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          </LayerCard.Primary>
        </LayerCard>
      </div>
    </AdminShell>
  );
}
