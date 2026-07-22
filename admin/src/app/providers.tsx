"use client";

import { Toasty } from "@cloudflare/kumo";
import { AuthProvider } from "@/lib/auth";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <Toasty>{children}</Toasty>
    </AuthProvider>
  );
}
