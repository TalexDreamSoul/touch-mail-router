"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Text } from "@cloudflare/kumo";
import { useAuth } from "@/lib/auth";

export default function HomePage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? "/dashboard" : "/login");
  }, [user, loading, router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-kumo-canvas">
      <Text variant="secondary">跳转中…</Text>
    </div>
  );
}
