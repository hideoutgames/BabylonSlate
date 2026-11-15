import { useEffect, useState } from "react";
import type { HostCredential } from "@haptic/source-control";
import { isTestModeEnabled } from "@haptic/vfs";
import { sourceControlAccounts, type SourceControlAccounts } from "../services/source-control-accounts";

/**
 * The device's Source Control credentials, kept current as they are saved or
 * removed. Only the lazily loaded Source Control settings use it, so the
 * credential store never loads with the editor.
 */
export function useSourceControlCredentials(): {
  accounts: SourceControlAccounts | null;
  credentials: HostCredential[];
  error: string | null;
} {
  const [accounts, setAccounts] = useState<SourceControlAccounts | null>(null);
  const [credentials, setCredentials] = useState<HostCredential[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let detach = () => {};
    const read = (source: SourceControlAccounts) =>
      source.list().then(
        (list) => {
          if (!alive) return;
          setCredentials(list);
          setError(null);
        },
        (cause: unknown) => {
          if (alive) setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    void sourceControlAccounts(isTestModeEnabled()).then((source) => {
      if (!alive) return;
      setAccounts(source);
      detach = source.subscribe(() => void read(source));
      void read(source);
    });
    return () => {
      alive = false;
      detach();
    };
  }, []);
  return { accounts, credentials, error };
}
