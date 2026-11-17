import { useState } from "react";
import { GitBranchIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@haptic/ui/components/alert";
import { Button } from "@haptic/ui/components/button";
import { isTestModeEnabled } from "@haptic/vfs";
import { useIntegratedSync, useSourceControl } from "../context/document-context";
import { deviceClientId } from "../lib/source-control-client-ids";
import { SettingsModal } from "./settings-modal";
import { useHostLink } from "./use-host-link";

/**
 * The one prompt a project whose mode is not Off shows while its host has no
 * working credential on this device: none saved (nothing is requested until
 * one is), or the saved one refused by its host or past its expiry. Sign In
 * starts device sign-in on GitHub and gitlab.com, and opens Engine Settings →
 * Source Control for a host that takes a token; a new sign-in then reads the
 * Integrated changes again, so a failure the old one caused clears. Its
 * dialogs stay mounted when the prompt goes, so a finished sign-in never
 * unmounts them mid-way.
 */
export function SourceControlSignInBanner() {
  const { sourceControl } = useSourceControl();
  const sync = useIntegratedSync();
  const prompt = sourceControl.signIn;
  const { link, dialogs } = useHostLink();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const deviceHost = prompt?.deviceHost && deviceClientId(prompt.deviceHost, isTestModeEnabled()) ? prompt.deviceHost : null;
  const signIn = async (host: NonNullable<typeof deviceHost>) => {
    if ((await link({ kind: "sign-in", host })) && sync.getSnapshot().active) await sync.refresh();
  };
  return (
    <>
      {prompt ? (
        <Alert className="shrink-0 rounded-none border-x-0 border-t-0" data-testid="source-control-sign-in-banner" data-reason={prompt.reason}>
          <GitBranchIcon />
          <AlertTitle>
            {prompt.reason === "refused"
              ? `${prompt.label} refused the saved sign-in.`
              : prompt.reason === "expired"
                ? `The ${prompt.label} sign-in expired.`
                : `This project uses ${prompt.label} file locking.`}
          </AlertTitle>
          <AlertDescription>
            {prompt.reason === "signed-out"
              ? "Sign in to lock files as you edit them and see who else is editing."
              : "Sign in again to keep using source control on this device."}
          </AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              data-testid="source-control-sign-in-banner-action"
              onClick={() => {
                if (deviceHost) void signIn(deviceHost);
                else setSettingsOpen(true);
              }}
            >
              {prompt.reason === "signed-out" ? "Sign In" : "Sign In Again"}
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
