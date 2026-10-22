import {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@haptic/ui/components/dialog";
import { getHostPlatform } from "@haptic/vfs";
import { HomepageProfileMenu } from "./homepage-profile-menu";
import {
  nativeProfileEditing,
  useNativeHomepageAccount,
  type NativeHomepageAccount,
} from "./homepage-account-context";
import { nativeProfileActions } from "./homepage-account-native-actions";
import { nativeAccountName } from "./homepage-account-types";
import type { NativeClerkSession } from "../services/native-clerk";
import { useMobileDemoSession } from "../context/mobile-demo-context";
import { useSubscriptionBilling } from "../services/subscription-billing";

const ClerkAccount = lazy(() => import("./homepage-account-clerk"));
const DesktopAccount = lazy(() => import("./homepage-account-desktop"));

class AccountErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
export function HomepageAccount({
  disabled = false,
  onOpenChange,
  onEngineSettings,
  onChangelog,
}: {
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  onEngineSettings?: () => void;
  onChangelog?: () => void;
}) {
  const nativeAccount = useNativeHomepageAccount();
  const demo = useMobileDemoSession();
  const [desktopAccount, setDesktopAccount] =
    useState<NativeHomepageAccount | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clerkOverlayOpen, setClerkOverlayOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const host = getHostPlatform();
  const demoActive = demo?.active && (host === "ios" || host === "android");
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
  const desktopClient = useMemo(
    () =>
      host === "electron" && publishableKey
        ? import("../services/native-clerk").then(
            ({ createNativeClerkClient }) =>
              createNativeClerkClient(publishableKey),
          )
        : null,
    [host, publishableKey],
  );
  const acceptDesktopSession = useCallback(
    async (session: NativeClerkSession) => {
      const client = await desktopClient;
      if (!client) return;
      const accountFor = (current: NativeClerkSession): NativeHomepageAccount => ({
        session: current,
        signOut: async () => {
          await client.signOut(current);
          setDesktopAccount(null);
        },
        profile: nativeProfileActions(client, current, {
          onSession: (next) => setDesktopAccount(accountFor(next)),
          onDeleted: () => setDesktopAccount(null),
        }),
      });
      setDesktopAccount(accountFor(session));
      setAuthOpen(false);
    },
    [desktopClient],
  );
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const restore = () => {
      if (
        !desktopClient ||
        cancelled ||
        pending ||
        document.visibilityState !== "visible"
      )
        return;
      pending = true;
      void desktopClient
        .then((client) => client.restoreSession())
        .then((session) => {
          if (cancelled) return;
          if (session) void acceptDesktopSession(session);
          else setDesktopAccount(null);
        })
        .catch(() => {
          /* Guests can still open local projects. */
        })
        .finally(() => {
          pending = false;
        });
    };
    restore();
    if (desktopClient) {
      window.addEventListener("focus", restore);
      document.addEventListener("visibilitychange", restore);
    }
    return () => {
      cancelled = true;
      window.removeEventListener("focus", restore);
      document.removeEventListener("visibilitychange", restore);
    };
  }, [desktopClient, acceptDesktopSession]);
  useEffect(() => {
    onOpenChange?.(menuOpen || clerkOverlayOpen || authOpen);
  }, [menuOpen, clerkOverlayOpen, authOpen, onOpenChange]);
  const account = nativeAccount ?? desktopAccount;
  const billing = useSubscriptionBilling(account?.session.userId, account?.session.email);
  const fallback = (
    <HomepageProfileMenu
      disabled={disabled}
      name={
        demoActive
          ? "Temporary Demo"
          : account
            ? nativeAccountName(account.session)
            : "Guest"
      }
      description={demoActive ? "Local Testing Only · Not Signed In" : undefined}
      email={account?.session.email}
      imageUrl={account?.session.imageUrl}
      nativeProfile={account ? nativeProfileEditing(account) : undefined}
      billing={billing}
      onSignOut={demoActive ? async () => demo.end() : account?.signOut}
      signOutLabel={demoActive ? "End Demo" : undefined}
      onSignIn={
        !account && host === "electron" && publishableKey
          ? () => setAuthOpen(true)
          : undefined
      }
      onEngineSettings={onEngineSettings}
      onChangelog={onChangelog}
      onOpenChange={setMenuOpen}
    />
  );
  return (
    <>
      {!nativeAccount && host === "web" && publishableKey ? (
        <AccountErrorBoundary fallback={fallback}>
          <Suspense fallback={fallback}>
            <ClerkAccount
              publishableKey={publishableKey}
              disabled={disabled}
              onEngineSettings={onEngineSettings}
              onChangelog={onChangelog}
              onOpenChange={setMenuOpen}
              onOverlayChange={setClerkOverlayOpen}
              fallback={fallback}
            />
          </Suspense>
        </AccountErrorBoundary>
      ) : (
        fallback
      )}
      <Dialog open={authOpen} onOpenChange={setAuthOpen}>
        <DialogContent
          className="homepage-theme homepage-profile"
          data-auth-open="true"
        >
          <DialogHeader>
            <DialogTitle>Sign In</DialogTitle>
            <DialogDescription className="sr-only">
              Connect your Slate account.
            </DialogDescription>
          </DialogHeader>
          {authOpen && publishableKey && (
            <AccountErrorBoundary
              fallback={<p role="alert">Sign-in is unavailable right now.</p>}
            >
              <Suspense
                fallback={<p role="status">Connecting your account...</p>}
              >
                <DesktopAccount
                  publishableKey={publishableKey}
                  onAuthenticated={acceptDesktopSession}
                />
              </Suspense>
            </AccountErrorBoundary>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
