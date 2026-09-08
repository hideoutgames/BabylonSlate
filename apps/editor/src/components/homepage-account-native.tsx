import type { ReactNode } from "react";
import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  SignIn,
  useSession,
} from "@clerk/react";
import { HomepageClerkProvider } from "./homepage-account-provider";
import {
  HomepageMobileAccountFailure,
  HomepageMobileAccountFrame,
} from "./homepage-mobile-account-gate";

function NativeSessionGate({ children }: { children: ReactNode }) {
  const { isLoaded, session } = useSession();
  if (isLoaded && session?.status === "active") return children;
  return (
    <HomepageMobileAccountFrame>
      <h1>Your Studio. Everywhere.</h1>
      <p>
        Sign in to use Slate on this device. Every editor feature is included.
      </p>
      <SignIn routing="hash" withSignUp />
    </HomepageMobileAccountFrame>
  );
}

export default function HomepageNativeAccount({
  publishableKey,
  children,
  onRetry,
}: {
  publishableKey: string;
  children: ReactNode;
  onRetry: () => void;
}) {
  return (
    <HomepageClerkProvider publishableKey={publishableKey}>
      <ClerkLoading>
        <HomepageMobileAccountFrame>
          <p role="status">Connecting your account…</p>
        </HomepageMobileAccountFrame>
      </ClerkLoading>
      <ClerkFailed>
        <HomepageMobileAccountFailure onRetry={onRetry} />
      </ClerkFailed>
      <ClerkLoaded>
        <NativeSessionGate>{children}</NativeSessionGate>
      </ClerkLoaded>
    </HomepageClerkProvider>
  );
}
