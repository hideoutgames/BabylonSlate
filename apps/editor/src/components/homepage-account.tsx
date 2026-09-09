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
} from "@babylonslate/ui/components/dialog";
import { getHostPlatform } from "@babylonslate/vfs";
import { HomepageSubscription } from "./homepage-subscription";
import { HomepageProfileMenu } from "./homepage-profile-menu";
import {
  useNativeHomepageAccount,
  type NativeHomepageAccount,
} from "./homepage-account-context";
import type { NativeClerkSession } from "../services/native-clerk";

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
}: {
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const nativeAccount = useNativeHomepageAccount();
  const [desktopAccount, setDesktopAccount] =
    useState<NativeHomepageAccount | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const host = getHostPlatform();
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
      setDesktopAccount({
        session,
        signOut: async () => {
          await client.signOut(session);
          setDesktopAccount(null);
        },
      });
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
    onOpenChange?.(menuOpen || subscriptionOpen || authOpen);
  }, [menuOpen, subscriptionOpen, authOpen, onOpenChange]);
  const account = nativeAccount ?? desktopAccount;
  const openSubscription = () => setSubscriptionOpen(true);
  const fallback = (
    <HomepageProfileMenu
      disabled={disabled}
      name={account?.session.name || (account ? "Your Account" : "Guest")}
      email={account?.session.email}
      imageUrl={account?.session.imageUrl}
      onSignOut={account?.signOut}
      onSignIn={
        !account && host === "electron" && publishableKey
          ? () => setAuthOpen(true)
          : undefined
      }
      onSubscription={openSubscription}
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
              onSubscription={openSubscription}
              onOpenChange={setMenuOpen}
              fallback={fallback}
            />
          </Suspense>
        </AccountErrorBoundary>
      ) : (
        fallback
      )}
      <Dialog open={subscriptionOpen} onOpenChange={setSubscriptionOpen}>
        <DialogContent
          className="homepage-theme homepage-profile"
          data-subscription-open="true"
        >
          <HomepageSubscription onBack={() => setSubscriptionOpen(false)} />
        </DialogContent>
      </Dialog>
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
