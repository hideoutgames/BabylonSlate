import { useState, useSyncExternalStore } from "react";
import { ShieldAlertIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import { useRegistryState } from "../context/document-context";
import { useProjectExtensionTrust } from "./use-project-extension-trust";

/**
 * Workspace Trust's prompt: shown while enabled Extensions that came with the
 * open project are held back because this computer does not trust it. It
 * never blocks the editor; Not Now hides it until the project opens again.
 */
export function ProjectExtensionTrustBanner() {
  const { extensionService, projectGuid } = useRegistryState();
  const snapshot = useSyncExternalStore(extensionService.subscribe, extensionService.getSnapshot);
  const { ready, trusted, setTrusted } = useProjectExtensionTrust();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!ready || trusted || snapshot.untrusted.length === 0 || dismissed === projectGuid) return null;
  return (
    <Alert className="shrink-0 rounded-none border-x-0 border-t-0" data-testid="project-extension-trust-banner">
      <ShieldAlertIcon />
      <AlertTitle>Project Extensions Are Not Running</AlertTitle>
      <AlertDescription>
        {snapshot.untrusted.join(", ")} came with this project and would run code on this computer. Trust them only if you trust where the project came from.
      </AlertDescription>
      <AlertAction className="flex gap-2">
        <Button variant="outline" size="sm" data-testid="project-extension-trust-dismiss" onClick={() => setDismissed(projectGuid)}>
          Not Now
        </Button>
        <Button
          size="sm"
          disabled={busy}
          data-testid="project-extension-trust-accept"
          onClick={() => {
            setBusy(true);
            void setTrusted(true).finally(() => setBusy(false));
          }}
        >
          Trust Project Extensions
        </Button>
      </AlertAction>
    </Alert>
  );
}
