import { Component, Suspense, lazy, useState, type ReactNode } from "react";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CircleUserRoundIcon,
  LogOutIcon,
} from "lucide-react";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@babylonslate/ui/components/dialog";
import { HomepageSubscription } from "./homepage-subscription";
import {
  useNativeHomepageAccount,
  type NativeHomepageAccount,
} from "./homepage-account-context";

const ClerkAccount = lazy(() => import("./homepage-account-clerk"));

export type HomepageAccountView = "overview" | "sign-in" | "settings";

function NativeAccountDetails({ account }: { account: NativeHomepageAccount }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="homepage-profile-account">
      <div className="homepage-profile-identity">
        <CircleUserRoundIcon aria-hidden="true" />
        <div>
          <h3>{account.session.name || "Your Account"}</h3>
          <p>{account.session.email}</p>
        </div>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Button
        variant="outline"
        size="touch"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void account.signOut().catch((reason: unknown) => {
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not sign out. Please try again.",
            );
            setBusy(false);
          });
        }}
      >
        <LogOutIcon data-icon="inline-start" />
        {busy ? "Signing Out…" : "Sign Out"}
      </Button>
    </div>
  );
}

class AccountErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <Alert>
          <AlertDescription>
            Sign-in is unavailable right now. Your local projects are ready to
            use.
          </AlertDescription>
        </Alert>
      );
    }
    return this.props.children;
  }
}

export function HomepageAccount() {
  const nativeAccount = useNativeHomepageAccount();
  const [open, setOpen] = useState(false);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [accountView, setAccountView] =
    useState<HomepageAccountView>("overview");
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSubscriptionOpen(false);
          setAccountView("overview");
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="touch"
            className="homepage-account"
            aria-label="Profile"
            data-testid="homepage-account"
          />
        }
      >
        <CircleUserRoundIcon data-icon="inline-start" />
        <span>Profile</span>
      </DialogTrigger>
      <DialogContent
        className="homepage-theme homepage-profile"
        data-testid="homepage-profile"
        data-auth-open={accountView !== "overview"}
        data-subscription-open={subscriptionOpen}
      >
        {subscriptionOpen ? (
          <HomepageSubscription onBack={() => setSubscriptionOpen(false)} />
        ) : (
          <>
            <DialogHeader>
              <Badge variant="outline">Your Slate</Badge>
              <DialogTitle>Profile</DialogTitle>
              <DialogDescription>
                A little space for you. Your projects stay on this device.
              </DialogDescription>
            </DialogHeader>
            {accountView !== "overview" ? (
              <Button
                variant="ghost"
                className="homepage-profile-back"
                onClick={() => setAccountView("overview")}
              >
                <ArrowLeftIcon data-icon="inline-start" />
                Back to Profile
              </Button>
            ) : null}
            {nativeAccount ? (
              <NativeAccountDetails account={nativeAccount} />
            ) : open && publishableKey ? (
              <AccountErrorBoundary>
                <Suspense
                  fallback={
                    <p role="status" className="text-muted-foreground">
                      Connecting your account…
                    </p>
                  }
                >
                  <ClerkAccount
                    publishableKey={publishableKey}
                    view={accountView}
                    onViewChange={setAccountView}
                  />
                </Suspense>
              </AccountErrorBoundary>
            ) : (
              <div className="homepage-profile-identity">
                <CircleUserRoundIcon aria-hidden="true" />
                <div>
                  <h3>Make Yourself at Home</h3>
                  <p>
                    Keep creating as a guest. Sign-in is not enabled in this
                    build.
                  </p>
                </div>
              </div>
            )}
            {accountView === "overview" ? (
              <Button
                variant="outline"
                size="touch"
                className="homepage-profile-subscription"
                onClick={() => setSubscriptionOpen(true)}
              >
                Manage Subscription
                <ArrowUpRightIcon data-icon="inline-end" />
              </Button>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
