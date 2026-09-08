import { Component, Suspense, lazy, useState, type ReactNode } from "react";
import { getHostPlatform } from "@babylonslate/vfs";
import { Button } from "@babylonslate/ui/components/button";
import { BrandIcon } from "./brand-icon";
import homepageStyles from "./homepage.css?inline";

const NativeAccountGate = lazy(() => import("./homepage-account-native"));

class NativeAccountErrorBoundary extends Component<
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

export function HomepageMobileAccountFrame({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <main
      className="homepage-theme homepage-mobile-auth safe-frame"
      data-testid="homepage-mobile-auth"
    >
      <style data-slate-home-styles>{homepageStyles}</style>
      <div className="homepage-mobile-auth-brand">
        <BrandIcon />
        <span>Slate</span>
      </div>
      <section className="homepage-mobile-auth-content">{children}</section>
    </main>
  );
}

export function HomepageMobileAccountFailure({
  onRetry,
}: {
  onRetry: () => void;
}) {
  return (
    <HomepageMobileAccountFrame>
      <h1>Let’s Get You Connected</h1>
      <p role="alert">
        We could not connect to your account. Check your connection and try
        again.
      </p>
      <Button size="touch" onClick={onRetry}>
        Try Again
      </Button>
    </HomepageMobileAccountFrame>
  );
}

export function HomepageMobileAccountGate({
  children,
}: {
  children: ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  const host = getHostPlatform();
  if (host !== "ios" && host !== "android") return children;
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
  if (!publishableKey) {
    return (
      <HomepageMobileAccountFrame>
        <h1>Sign-In Is Not Set Up</h1>
        <p>
          This mobile build is not connected to Slate accounts yet. Please use
          an updated build with account sign-in enabled.
        </p>
      </HomepageMobileAccountFrame>
    );
  }
  const retry = () => setAttempt((current) => current + 1);
  return (
    <NativeAccountErrorBoundary
      key={attempt}
      fallback={<HomepageMobileAccountFailure onRetry={retry} />}
    >
      <Suspense
        fallback={
          <HomepageMobileAccountFrame>
            <p role="status">Connecting your account…</p>
          </HomepageMobileAccountFrame>
        }
      >
        <NativeAccountGate publishableKey={publishableKey} onRetry={retry}>
          {children}
        </NativeAccountGate>
      </Suspense>
    </NativeAccountErrorBoundary>
  );
}
