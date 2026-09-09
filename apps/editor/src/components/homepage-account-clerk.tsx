import { useEffect, type ReactNode } from "react";
import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  UserButton,
  useClerk,
  useUser,
} from "@clerk/react";
import { CreditCardIcon } from "lucide-react";
import { HomepageClerkProvider } from "./homepage-account-provider";
import { HomepageProfileMenu } from "./homepage-profile-menu";

type Props = {
  disabled?: boolean;
  onSubscription: () => void;
  onOpenChange: (open: boolean) => void;
};
function AccountButton({ disabled, onSubscription, onOpenChange }: Props) {
  const { isSignedIn } = useUser();
  const clerk = useClerk();
  useEffect(() => {
    const update = () =>
      onOpenChange(
        Boolean(
          document.querySelector(
            ".slate-clerk-overlay, [data-testid=homepage-profile-menu]",
          ),
        ),
      );
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    update();
    return () => {
      observer.disconnect();
      onOpenChange(false);
    };
  }, [onOpenChange]);
  if (!isSignedIn)
    return (
      <HomepageProfileMenu
        disabled={disabled}
        onSubscription={onSubscription}
        onOpenChange={onOpenChange}
        onSignIn={() => clerk.openSignIn()}
      />
    );
  return (
    <div className="homepage-clerk-trigger" inert={disabled}>
      <UserButton
        appearance={{
          elements: {
            avatarBox: "homepage-profile-avatar",
            userButtonTrigger: "homepage-clerk-avatar-button",
            userButtonPopoverCard: "slate-clerk-overlay",
            modalContent: "slate-clerk-overlay",
          },
        }}
        userProfileMode="modal"
      >
        <UserButton.MenuItems>
          <UserButton.Action label="manageAccount" />
          <UserButton.Action
            label="Manage Subscription"
            labelIcon={<CreditCardIcon size={16} />}
            onClick={onSubscription}
          />
          <UserButton.Action label="signOut" />
        </UserButton.MenuItems>
      </UserButton>
    </div>
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
