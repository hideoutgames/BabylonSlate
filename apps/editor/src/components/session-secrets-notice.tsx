import { useEffect, useState } from "react";
import { FieldDescription } from "@haptic/ui/components/field";
import { getElectronSecretsBridge } from "@haptic/vfs";

/**
 * Live state for settings pages that take tokens or passwords: on a desktop
 * computer without secure OS encryption (Linux without a keyring), secrets
 * are kept only until Haptic quits. Renders nothing elsewhere.
 */
export function SessionSecretsNotice() {
  const [sessionOnly, setSessionOnly] = useState(false);
  useEffect(() => {
    let current = true;
    void getElectronSecretsBridge()?.persistent?.().then(
      (persistent) => { if (current) setSessionOnly(!persistent); },
      () => {},
    );
    return () => { current = false; };
  }, []);
  if (!sessionOnly) return null;
  return (
    <FieldDescription className="settings-row" data-testid="session-secrets-notice">
      This computer has no secure password storage, so tokens and passwords are kept only until Haptic quits.
    </FieldDescription>
  );
}
