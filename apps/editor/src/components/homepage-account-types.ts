import type { ReactElement } from "react";

/** What the Account dialog shows about the signed-in person. */
export interface AccountDetails {
  name: string;
  /** "Signed In", "Not Signed In" or a provider-specific description. */
  status: string;
  email?: string;
  imageUrl?: string;
  memberSince?: Date;
  lastSignInAt?: Date;
  /** Human-readable sign-in methods, such as "Email" or "Google". */
  signInMethods?: string[];
}

export type HapticPlanId = "free" | "pro" | "enterprise";

/**
 * Billing for the signed-in account. Clerk Billing serves web and desktop;
 * RevenueCat serves the iOS and Android stores. Without keys, purchases stay
 * unavailable and `unavailableReason` says why.
 */
export interface BillingController {
  provider: "clerk" | "revenuecat";
  unavailableReason: string | null;
  currentPlan: HapticPlanId;
  /** Provider status for the current paid plan, such as "Active" or "Past Due". */
  status?: string;
  renewsAt?: Date;
  /** Wraps the Haptic Pro button so it opens the provider's checkout. */
  renderSubscribe?: (button: ReactElement) => ReactElement;
  /** Wraps the Manage Billing button so it opens the provider's billing page. */
  renderManage?: (button: ReactElement) => ReactElement;
}

/** Billing before any provider keys are configured for this build. */
export function unconfiguredBilling(
  provider: BillingController["provider"],
): BillingController {
  return {
    provider,
    currentPlan: "free",
    unavailableReason:
      provider === "revenuecat"
        ? "In-app purchases are not set up for this build yet."
        : "Billing is not connected for this build yet.",
  };
}
