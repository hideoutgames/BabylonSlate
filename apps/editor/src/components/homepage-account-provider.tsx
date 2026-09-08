import type { ReactNode } from "react";
import { ClerkProvider } from "@clerk/react";
import { useHomepageScheme } from "./homepage-scheme";

/** Owned by the project browser; never mounted inside the editor route. */
export function HomepageClerkProvider({
  publishableKey,
  children,
}: {
  publishableKey: string;
  children: ReactNode;
}) {
  const [scheme] = useHomepageScheme();
  const dark = scheme === "dark";
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
          colorBackground: dark ? "#1b1d24" : "#fbfbfd",
          colorForeground: dark ? "#ededf2" : "#1b1d23",
          colorPrimary: dark ? "#b7c2f0" : "#495b9b",
          colorInputBackground: dark ? "#242730" : "#eeeff2",
          colorInputText: dark ? "#ededf2" : "#1b1d23",
          colorMutedForeground: dark ? "#90939f" : "#737782",
          borderRadius: "12px",
        },
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
