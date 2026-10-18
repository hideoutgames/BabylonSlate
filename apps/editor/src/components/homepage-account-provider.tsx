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
        variables: {
          // The dark editor tokens (popover, foreground, primary, muted).
          colorBackground: "#1d1b19",
          colorForeground: "#f6f5f4",
          colorPrimary: "#f6f5f4",
          colorPrimaryForeground: "#0c0b09",
          colorMutedForeground: "#a3a19d",
          borderRadius: "12px",
        },
        elements: {
          formFieldInput: {
            backgroundColor: "#0a0907",
            color: "#f6f5f4",
          },
          modalContent: "slate-clerk-overlay",
          rootBox: "homepage-theme homepage-clerk",
          cardBox: "homepage-clerk-card",
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
