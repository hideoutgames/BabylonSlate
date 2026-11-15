import { useEffect } from "react";

/**
 * Tells the Homepage which account is signed in once that is known: the
 * account id, or null for a guest. Renders nothing.
 */
export function HomepageAccountReport({
  accountId,
  onAccountChange,
}: {
  accountId: string | null;
  onAccountChange?: (accountId: string | null) => void;
}) {
  useEffect(() => {
    onAccountChange?.(accountId);
  }, [accountId, onAccountChange]);
  return null;
}
