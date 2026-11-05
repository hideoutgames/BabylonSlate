import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { CloudOffIcon, KeyRoundIcon, RotateCwIcon } from "lucide-react";
import { getHostPlatform, isTestModeEnabled } from "@haptic/vfs";
import { Button } from "@haptic/ui/components/button";
import { useLauncherTransition } from "./launcher-transition";
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

/** The boot intro's text wordmark at rest: ink over a red and an amber copy. */
function MobileAccountWordmark() {
  return (
    <span className="homepage-mobile-auth-wordmark" role="img" aria-label="Haptic">
      <span className="homepage-mobile-auth-wordmark-ca homepage-mobile-auth-wordmark-red" aria-hidden="true">
        HAPTIC
      </span>
      <span className="homepage-mobile-auth-wordmark-ca homepage-mobile-auth-wordmark-amber" aria-hidden="true">
        HAPTIC
      </span>
      <span className="homepage-mobile-auth-wordmark-ink" aria-hidden="true">
        HAPTIC
      </span>
    </span>
  );
}

/** Indeterminate amber-to-red line with a status, as the project splash shows. */
export function HomepageAccountProgress({ label }: { label: string }) {
  return (
    <div className="homepage-account-progress">
      <span className="homepage-account-progress-track" aria-hidden="true">
        <span />
      </span>
      <p role="status">{label}</p>
    </div>
  );
}

/** A state heading with an icon tile, for failures and missing setup. */
export function HomepageAccountNotice({
  icon,
  tone = "default",
  title,
  children,
}: {
  icon: ReactNode;
  tone?: "default" | "destructive";
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="homepage-native-auth-intro">
      <span className="homepage-native-auth-notice-icon" data-tone={tone}>
        {icon}
      </span>
      <h1>{title}</h1>
      {children}
    </header>
  );
}

export function HomepageMobileAccountFrame({
  children,
}: {
  children: ReactNode;
}) {
  const { ready } = useLauncherTransition();
  useEffect(() => {
    ready("home");
  }, [ready]);
  return (
    <main
      className="homepage-theme homepage-mobile-auth safe-frame-top"
      data-testid="homepage-mobile-auth"
    >
      <style data-slate-home-styles>{homepageStyles}</style>
      <header className="homepage-mobile-auth-hero">
        <MobileAccountWordmark />
      </header>
      <section className="homepage-mobile-auth-sheet">{children}</section>
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
      <HomepageAccountNotice
        icon={<CloudOffIcon aria-hidden="true" />}
        tone="destructive"
        title="Let’s Get You Connected"
      >
        <p role="alert">
          We could not connect to your account. Check your connection and try
          again.
        </p>
      </HomepageAccountNotice>
      <Button onClick={onRetry}>
        <RotateCwIcon data-icon="inline-start" aria-hidden="true" />
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
  // Test mode, and development builds synced with `--demo`, skip sign-in.
  if (isTestModeEnabled() || import.meta.env.VITE_MOBILE_DEMO === "true")
    return children;
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
  if (!publishableKey) {
    return (
      <HomepageMobileAccountFrame>
        <HomepageAccountNotice
          icon={<KeyRoundIcon aria-hidden="true" />}
          title="Sign-In Is Not Set Up"
        >
          <p>
            This build is not connected to Haptic accounts. Install a build
            with account sign-in enabled.
          </p>
        </HomepageAccountNotice>
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
            <HomepageAccountProgress label="Connecting your account…" />
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
