import { useCallback, useEffect, useState } from "react";
import { getElectronGameShellBridge, type AndroidPackagingChange, type AndroidPackagingStatus } from "@haptic/vfs";

/**
 * This computer's Android packaging settings as the desktop app's main
 * process keeps them, and the JDK and Android SDK they find. Read when
 * `active` turns on; `change` asks the main process to pick, reset or set
 * one, and shows what it then holds. Null outside the desktop app.
 */
export function useAndroidPackaging(active: boolean): {
  status: AndroidPackagingStatus | null;
  error: string | null;
  change: (change: AndroidPackagingChange) => Promise<void>;
} {
  const [status, setStatus] = useState<AndroidPackagingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settle = useCallback(async (request: Promise<AndroidPackagingStatus>, isCurrent: () => boolean = () => true) => {
    try {
      const next = await request;
      if (isCurrent()) {
        setStatus(next);
        setError(null);
      }
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    const bridge = getElectronGameShellBridge();
    if (!active || !bridge?.androidSettings) return;
    let current = true;
    void settle(bridge.androidSettings(null), () => current);
    return () => { current = false; };
  }, [active, settle]);
  const change = useCallback(async (next: AndroidPackagingChange) => {
    const bridge = getElectronGameShellBridge();
    if (bridge?.androidSettings) await settle(bridge.androidSettings(next));
  }, [settle]);
  return { status, error, change };
}
