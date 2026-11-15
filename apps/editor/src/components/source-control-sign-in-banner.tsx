import { useState } from "react";
import { GitBranchIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import { isTestModeEnabled } from "@haptic/vfs";
import { useSourceControl } from "../context/document-context";
import { deviceClientId } from "../lib/source-control-client-ids";
import { SettingsModal } from "./settings-modal";
import { useHostLink } from "./use-host-link";

/**
 * The one prompt a project whose mode is not Off shows while its host has no
 * credential on this device; nothing is requested until one is saved. Sign In
 * starts device sign-in on GitHub and gitlab.com, and opens Engine Settings →
 * Source Control for a host that takes a token. Its dialogs stay mounted when
 * the prompt goes, so a finished sign-in never unmounts them mid-way.
 */
export function SourceControlSignInBanner() {
  const { sourceControl } = useSourceControl();
  const prompt = sourceControl.signIn;
  const { link, dialogs } = useHostLink();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const deviceHost = prompt?.deviceHost && deviceClientId(prompt.deviceHost, isTestModeEnabled()) ? prompt.deviceHost : null;
  return (
    <>
      {prompt ? (
        <Alert className="shrink-0 rounded-none border-x-0 border-t-0" data-testid="source-control-sign-in-banner">
          <GitBranchIcon />
          <AlertTitle>This project uses {prompt.label} file locking.</AlertTitle>
          <AlertDescription>Sign in to lock files as you edit them and see who else is editing.</AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              data-testid="source-control-sign-in-banner-action"
              onClick={() => {
                if (deviceHost) void link({ kind: "sign-in", host: deviceHost });
                else setSettingsOpen(true);
              }}
            >
              Sign In
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {dialogs}
      {settingsOpen ? (
        <SettingsModal open onOpenChange={setSettingsOpen} scope="engine" initialCategoryId="sourceControl" />
      ) : null}
    </>
  );
}
