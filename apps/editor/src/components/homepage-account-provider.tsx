import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/react";

/** Owned by the project browser; never mounted inside the editor route. */
export function HomepageClerkProvider({
  publishableKey,
  children,
}: {
  publishableKey: string;
  children: ReactNode;
}) {
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      polling={false}
      telemetry={false}
      touchSession={false}
      signInFallbackRedirectUrl={import.meta.env.BASE_URL}
      signUpFallbackRedirectUrl={import.meta.env.BASE_URL}
      afterSignOutUrl={import.meta.env.BASE_URL}
      appearance={{
        elements: {
          rootBox: "homepage-theme homepage-clerk",
          cardBox: "homepage-clerk-card",
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
