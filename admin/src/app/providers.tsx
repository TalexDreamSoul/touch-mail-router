"use client";

import { Toasty } from "@cloudflare/kumo";
import { AuthProvider } from "@/lib/auth";
import { ThemeProvider } from "@/lib/theme";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Toasty>{children}</Toasty>
      </AuthProvider>
    </ThemeProvider>
  );
}
