import { useEffect, type ReactNode } from "react";
import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  useClerk,
  useUser,
} from "@clerk/react";
import { HomepageAccountReport } from "./homepage-account-report";
import { HomepageClerkProvider } from "./homepage-account-provider";
import { HomepageProfileMenu } from "./homepage-profile-menu";
import { useSubscriptionBilling } from "../services/subscription-billing";

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

type Props = {
  disabled?: boolean;
  onEngineSettings?: () => void;
  onChangelog?: () => void;
  onOpenChange: (open: boolean) => void;
  onOverlayChange: (open: boolean) => void;
  onAccountChange?: (accountId: string | null) => void;
};

function AccountButton({ onOverlayChange, onAccountChange, ...props }: Props) {
  const { isSignedIn, user } = useUser();
  const clerk = useClerk();
  const guestBilling = useSubscriptionBilling(undefined);
  useEffect(() => {
    const update = () =>
      onOverlayChange(Boolean(document.querySelector(".slate-clerk-overlay")));
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    update();
    return () => {
      observer.disconnect();
      onOverlayChange(false);
    };
  }, [onOverlayChange]);
  const signedIn = Boolean(isSignedIn && user);
  return (
    <>
      <HomepageAccountReport
        accountId={signedIn && user ? user.id : null}
        onAccountChange={onAccountChange}
      />
      {signedIn && user ? (
        <SignedInAccount {...props} user={user} />
      ) : (
        <HomepageProfileMenu
          {...props}
          billing={guestBilling}
          onSignIn={() => clerk.openSignIn()}
          onSignUp={() => clerk.openSignUp()}
        />
      )}
    </>
  );
}

function SignedInAccount({
  user,
  ...props
}: Omit<Props, "onOverlayChange" | "onAccountChange"> & {
  user: NonNullable<ReturnType<typeof useUser>["user"]>;
}) {
  const clerk = useClerk();
  const email = user.primaryEmailAddress?.emailAddress;
  const billing = useSubscriptionBilling(user.id, email);
  const signInMethods = [
    ...(user.passwordEnabled ? ["Password"] : []),
    ...(email ? ["Email"] : []),
    ...user.externalAccounts.map((account) => titleCase(account.provider)),
  ];
  return (
    <HomepageProfileMenu
      {...props}
      name={user.fullName || user.username || email || "Your Account"}
      email={email}
      imageUrl={user.hasImage ? user.imageUrl : undefined}
      details={{
        memberSince: user.createdAt ?? undefined,
        lastSignInAt: user.lastSignInAt ?? undefined,
        signInMethods: [...new Set(signInMethods)],
      }}
      billing={billing}
      onManageAccount={() => clerk.openUserProfile()}
      onSignOut={() => clerk.signOut()}
    />
  );
}
export default function HomepageClerkAccount({
  publishableKey,
  fallback,
  ...props
}: Props & { publishableKey: string; fallback: ReactNode }) {
  return (
    <HomepageClerkProvider publishableKey={publishableKey}>
      <ClerkLoading>{fallback}</ClerkLoading>
      <ClerkFailed>
        {fallback}
        <HomepageAccountReport
          accountId={null}
          onAccountChange={props.onAccountChange}
        />
      </ClerkFailed>
      <ClerkLoaded>
        <AccountButton {...props} />
      </ClerkLoaded>
    </HomepageClerkProvider>
  );
}
