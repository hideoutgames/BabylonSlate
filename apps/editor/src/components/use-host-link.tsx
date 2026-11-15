import { useCallback, useRef, useState, type ReactNode } from "react";
import { tokenCredential } from "@haptic/source-control";
import type { DeviceSignInHost } from "@haptic/source-control/device-flow";
import { isTestModeEnabled } from "@haptic/vfs";
import { useNativeHomepageAccount } from "./homepage-account-context";
import { HostSignInDialog, LinkHostWarningDialog } from "./source-control-link";

export type HostLinkRequest =
  | { kind: "sign-in"; host: DeviceSignInHost }
  | { kind: "token"; origin: string; token: string; credentialKind: "gitlab-token" | "token" };

const HOST_LABELS: Record<DeviceSignInHost, string> = { github: "GitHub", gitlab: "GitLab" };

function linkLabel(request: HostLinkRequest): string {
  return request.kind === "sign-in" ? HOST_LABELS[request.host] : new URL(request.origin).host;
}

type Settle = (linked: boolean) => void;

/**
 * Linking a host: the warning on every link (no remembered acceptance), then
 * device sign-in or saving the token. `link` resolves true once a credential
 * is saved and false on Decline or Cancel; a token that cannot be saved
 * rejects. While device sign-in waits on the browser, the mobile Homepage's
 * session check is held so returning from it does not unmount the dialog.
 */
export function useHostLink(): { link: (request: HostLinkRequest) => Promise<boolean>; dialogs: ReactNode } {
  const [warning, setWarning] = useState<{ request: HostLinkRequest; settle: Settle; fail: (error: unknown) => void } | null>(null);
  const [signIn, setSignIn] = useState<{ host: DeviceSignInHost; settle: Settle } | null>(null);
  const holdSessionCheck = useNativeHomepageAccount()?.profile.holdSessionCheck;
  const hold = useRef<(() => void) | null>(null);

  const link = useCallback((request: HostLinkRequest) => new Promise<boolean>((settle, fail) => {
    setWarning({ request, settle, fail });
  }), []);

  const decline = () => {
    warning?.settle(false);
    setWarning(null);
  };

  const accept = () => {
    if (!warning) return;
    const { request, settle, fail } = warning;
    setWarning(null);
    if (request.kind === "sign-in") {
      hold.current ??= holdSessionCheck?.() ?? null;
      setSignIn({ host: request.host, settle });
      return;
    }
    void import("../services/source-control-accounts")
      .then(async ({ sourceControlAccounts }) => {
        const accounts = await sourceControlAccounts(isTestModeEnabled());
        await accounts.save(tokenCredential(request.origin, request.token, request.credentialKind));
        settle(true);
      })
      .catch(fail);
  };

  const finishSignIn = (linked: boolean) => {
    hold.current?.();
    hold.current = null;
    signIn?.settle(linked);
    setSignIn(null);
  };

  return {
    link,
    dialogs: (
      <>
        <LinkHostWarningDialog
          label={warning ? linkLabel(warning.request) : ""}
          open={warning !== null}
          onDecline={decline}
          onAccept={accept}
        />
        {signIn ? <HostSignInDialog host={signIn.host} onDone={finishSignIn} /> : null}
      </>
    ),
  };
}
