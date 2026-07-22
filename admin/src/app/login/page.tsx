"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Banner,
  Button,
  Input,
  LayerCard,
  SensitiveInput,
  Surface,
  Text,
} from "@cloudflare/kumo";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const { user, loading, setUser } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [user, loading, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res =
        mode === "login"
          ? await api.login(username, password)
          : await api.register(username, password, displayName);
      setUser(res.user);
      router.replace("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Surface className="flex min-h-screen items-center justify-center p-4">
      <LayerCard className="w-full max-w-md">
        <LayerCard.Primary>
          <div className="flex flex-col gap-6">
            <div>
              <Text variant="heading1" as="h1">
                Touch Mail
              </Text>
              <Text variant="secondary">
                {mode === "login" ? "登录管理后台" : "注册新租户账号"}
              </Text>
            </div>

            {error ? (
              <Banner variant="error" title="操作失败" description={error} />
            ) : null}

            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <Input
                label="用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="3-24 位小写字母数字"
                required
              />
              {mode === "register" ? (
                <Input
                  label="显示名"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="可选"
                />
              ) : null}
              <SensitiveInput
                label="密码"
                value={password}
                onValueChange={setPassword}
                placeholder="至少 8 位"
                required
              />
              <Button type="submit" loading={submitting}>
                {mode === "login" ? "登录" : "注册"}
              </Button>
            </form>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError("");
              }}
            >
              {mode === "login" ? "没有账号？注册" : "已有账号？登录"}
            </Button>
          </div>
        </LayerCard.Primary>
      </LayerCard>
    </Surface>
  );
}
