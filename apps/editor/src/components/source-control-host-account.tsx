import type { HostCredential } from "@haptic/source-control";
import { Button } from "@haptic/ui/components/button";
import { isTestModeEnabled } from "@haptic/vfs";
import { deviceClientId } from "../lib/source-control-client-ids";
import { signInPromptFor } from "../services/source-control-service";
import { useHostLink } from "./use-host-link";

/**
 * `Signed In As <account>` for the host, or Sign In (device sign-in for
 * github.com and gitlab.com, after the link warning). Clone and Publish
 * show it beside their host choice.
 */
export function HostAccountState({ origin, credential, "data-testid": testId }: { origin: string; credential: HostCredential | null; "data-testid"?: string }) {
  const { link, dialogs } = useHostLink();
  const prompt = signInPromptFor(origin);
  const canSignIn = prompt.deviceHost !== null && deviceClientId(prompt.deviceHost, isTestModeEnabled()) !== null;
  return (
    <span className="flex min-w-0 items-center justify-end gap-2 text-xs text-muted-foreground" data-testid={testId}>
      {credential ? (
        <span className="truncate" data-testid={testId ? `${testId}-signed-in` : undefined}>
          {credential.account ? `Signed In As ${credential.account}` : `Token Saved For ${prompt.label}`}
        </span>
      ) : (
        <>
          <span className="truncate">Not Signed In</span>
          {canSignIn && prompt.deviceHost ? (
            <Button size="sm" data-testid={testId ? `${testId}-sign-in` : undefined} onClick={() => void link({ kind: "sign-in", host: prompt.deviceHost! })}>
              Sign In
            </Button>
          ) : null}
        </>
      )}
      {dialogs}
    </span>
  );
}
