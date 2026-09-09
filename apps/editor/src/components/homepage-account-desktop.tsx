import type { NativeClerkSession } from "../services/native-clerk";
import { useEffect, useState, type ReactNode } from "react";
import HomepageNativeAccount from "./homepage-account-native";
import { useNativeHomepageAccount } from "./homepage-account-context";
import { NativeAccountDetails } from "./homepage-account-native-details";

function DesktopAccountFrame({ children }: { children: ReactNode }) {
  return (
    <div className="homepage-mobile-auth-content homepage-desktop-auth">
      {children}
    </div>
  );
}

function DesktopIdentity({
  onAuthenticated,
}: {
  onAuthenticated?: (session: NativeClerkSession) => void;
}) {
  const account = useNativeHomepageAccount();
  useEffect(() => {
    if (account) onAuthenticated?.(account.session);
  }, [account?.session.id, onAuthenticated]);
  return account ? <NativeAccountDetails account={account} /> : null;
}

/** Native transport on app://; never gates desktop project access. */
export default function HomepageDesktopAccount({
  publishableKey,
  onAuthenticated,
}: {
  publishableKey: string;
  onAuthenticated?: (session: NativeClerkSession) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <HomepageNativeAccount
      key={attempt}
      publishableKey={publishableKey}
      onRetry={() => setAttempt((current) => current + 1)}
      frame={DesktopAccountFrame}
      optional
    >
      <DesktopIdentity onAuthenticated={onAuthenticated} />
    </HomepageNativeAccount>
  );
}
