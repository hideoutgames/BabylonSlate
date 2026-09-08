import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/react";
import { getHostPlatform } from "@babylonslate/vfs";

/** Owned by the project browser; never mounted inside the editor route. */
export function HomepageClerkProvider({
  publishableKey,
  children,
}: {
  publishableKey: string;
  children: ReactNode;
}) {
  const host = getHostPlatform();
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      polling={false}
      telemetry={false}
      touchSession={false}
      standardBrowser={host === "web" || host === "electron"}
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
