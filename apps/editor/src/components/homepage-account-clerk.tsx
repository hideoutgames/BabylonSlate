import { useEffect, type ReactNode } from "react";
import {
  ClerkFailed,
  ClerkLoaded,
  ClerkLoading,
  useClerk,
  useUser,
} from "@clerk/react";
import {
  CheckoutButton,
  SubscriptionDetailsButton,
  usePlans,
  useSubscription,
} from "@clerk/react/experimental";
import { HomepageClerkProvider } from "./homepage-account-provider";
import type { BillingController, HapticPlanId } from "./homepage-account-types";
import { HomepageProfileMenu } from "./homepage-profile-menu";

/** The Clerk Billing plan slug for Haptic Pro. */
const PRO_PLAN_SLUG = import.meta.env.VITE_CLERK_PRO_PLAN_SLUG?.trim() || "pro";

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Clerk Billing state for the signed-in user: current plan, checkout and billing details. */
function useClerkBilling(): BillingController {
  const subscription = useSubscription();
  const plans = usePlans({ for: "user" });
  const proPlan = plans.data?.find((plan) => plan.slug === PRO_PLAN_SLUG);
  const item = subscription.data?.subscriptionItems.find(
    (entry) => entry.status === "active" || entry.status === "past_due",
  );
  const slug = item?.plan.slug;
  const currentPlan: HapticPlanId =
    slug === PRO_PLAN_SLUG ? "pro" : slug === "enterprise" ? "enterprise" : "free";
  const unavailableReason =
    subscription.error || plans.error
      ? "Billing could not be loaded. Try again later."
      : !plans.isLoading && !proPlan
        ? "Haptic Pro is not available for purchase yet."
        : null;
  return {
    provider: "clerk",
    unavailableReason,
    currentPlan,
    status: item ? titleCase(item.status) : undefined,
    renewsAt: item?.periodEnd ?? undefined,
    renderSubscribe: proPlan
      ? (button) => (
          <CheckoutButton
            planId={proPlan.id}
            onSubscriptionComplete={() => void subscription.revalidate()}
          >
            {button}
          </CheckoutButton>
        )
      : undefined,
    renderManage: (button) => (
      <SubscriptionDetailsButton
        onSubscriptionCancel={() => void subscription.revalidate()}
      >
        {button}
      </SubscriptionDetailsButton>
    ),
  };
}

type Props = {
  disabled?: boolean;
  onEngineSettings?: () => void;
  onChangelog?: () => void;
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
      <HomepageProfileMenu
        {...props}
        onSignIn={() => clerk.openSignIn()}
        onSignUp={() => clerk.openSignUp()}
      />
    );
  return <SignedInAccount {...props} user={user} />;
}

function SignedInAccount({
  user,
  ...props
}: Omit<Props, "onOverlayChange"> & {
  user: NonNullable<ReturnType<typeof useUser>["user"]>;
}) {
  const clerk = useClerk();
  const billing = useClerkBilling();
  const email = user.primaryEmailAddress?.emailAddress;
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
      <ClerkFailed>{fallback}</ClerkFailed>
      <ClerkLoaded>
        <AccountButton {...props} />
      </ClerkLoaded>
    </HomepageClerkProvider>
  );
}
