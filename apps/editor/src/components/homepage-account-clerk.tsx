import { useEffect, type ReactNode } from "react";
import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  useClerk,
  useUser,
} from "@clerk/react";
import { HomepageClerkProvider } from "./homepage-account-provider";
import { HomepageProfileMenu } from "./homepage-profile-menu";

type Props = {
  disabled?: boolean;
  onSubscription: () => void;
  onApplicationSettings?: () => void;
  onEngineSettings?: () => void;
  onOpenChange: (open: boolean) => void;
  onOverlayChange: (open: boolean) => void;
};
function AccountButton({ onOverlayChange, ...props }: Props) {
  const { isSignedIn, user } = useUser();
  const clerk = useClerk();
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
  if (!isSignedIn || !user)
    return (
      <HomepageProfileMenu {...props} onSignIn={() => clerk.openSignIn()} />
    );
  const email = user.primaryEmailAddress?.emailAddress;
  return (
    <HomepageProfileMenu
      {...props}
      name={user.fullName || user.username || email || "Your Account"}
      email={email}
      imageUrl={user.hasImage ? user.imageUrl : undefined}
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
      <ClerkFailed>{fallback}</ClerkFailed>
      <ClerkLoaded>
        <AccountButton {...props} />
      </ClerkLoaded>
    </HomepageClerkProvider>
  );
}
