"use client";

import { useKumoToastManager } from "@cloudflare/kumo";
import { useMemo, useRef } from "react";

/**
 * Stable toast helpers.
 * useKumoToastManager() may return a new object each render; putting it in
 * useCallback / useEffect deps causes infinite reload loops ("加载中" forever
 * and eventually Failed to fetch from request storms).
 */
export function useStableToast() {
  const toast = useKumoToastManager();
  const ref = useRef(toast);
  ref.current = toast;

  return useMemo(
    () => ({
      success: (title: string, description?: string) => {
        ref.current.add({ title, ...(description ? { description } : {}) });
      },
      error: (title: string, description?: string) => {
        ref.current.add({ title, ...(description ? { description } : {}) });
      },
    }),
    [],
  );
}
