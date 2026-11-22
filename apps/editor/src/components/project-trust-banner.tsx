import { useState, useSyncExternalStore } from "react";
import { ShieldAlertIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import { useRegistryState } from "../context/document-context";
import { useProjectTrust } from "./use-project-trust";
import { useRegisteredEditorUtilities } from "./use-registered-editor-utilities";

/**
 * Workspace Trust's prompt: shown while project code is held back because this
 * computer does not trust the project: code that would start on its own
 * (enabled Project Extensions, registered Editor Utilities) and Execute
 * JavaScript that Play, Preview Build or packaging refused. It never blocks
 * the editor; Not Now hides it until the project opens again or something new
 * is held back.
 */
export function ProjectTrustBanner() {
  const { extensionService, projectGuid } = useRegistryState();
  const snapshot = useSyncExternalStore(extensionService.subscribe, extensionService.getSnapshot);
  const utilities = useRegisteredEditorUtilities();
  const { ready, trusted, setTrusted } = useProjectTrust();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const held = [
    ...(snapshot.untrusted.length > 0 ? [`Extensions (${snapshot.untrusted.join(", ")})`] : []),
    ...(utilities.length > 0 ? ["Editor Utilities"] : []),
    ...(snapshot.untrustedExecuteJavaScript.length > 0 ? [`Execute JavaScript (${snapshot.untrustedExecuteJavaScript.join(", ")})`] : []),
  ];
  // Not Now hides the prompt only for what it showed: a later refusal shows it again.
  const dismissKey = JSON.stringify([projectGuid, held, snapshot.executeJavaScriptRefusals]);
  if (!ready || trusted || held.length === 0 || dismissed === dismissKey) return null;
  return (
    <Alert className="shrink-0 rounded-none border-x-0 border-t-0" data-testid="project-trust-banner">
      <ShieldAlertIcon />
      <AlertTitle>Project Code Is Not Running</AlertTitle>
      <AlertDescription>
        This project's {held.length > 1 ? `${held.slice(0, -1).join(", ")} and ${held.at(-1)}` : held[0]} would run code on this computer. Trust the project only if you trust where it came from.
      </AlertDescription>
      <AlertAction className="flex gap-2">
        <Button variant="outline" size="sm" data-testid="project-trust-dismiss" onClick={() => setDismissed(dismissKey)}>
          Not Now
        </Button>
        <Button
          size="sm"
          disabled={busy}
          data-testid="project-trust-accept"
          onClick={() => {
            setBusy(true);
            void setTrusted(true).finally(() => setBusy(false));
          }}
        >
          Trust Project
        </Button>
      </AlertAction>
    </Alert>
  );
}
