import type { MouseEvent, ReactElement } from "react";

/** A plan action button that billing wraps with its own click handler. */
export type BillingButton = ReactElement<{
  onClick?: (event: MouseEvent) => void;
  disabled?: boolean;
}>;

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
 * Billing for the signed-in account, through RevenueCat on every host. Without
 * keys, purchases stay unavailable and `unavailableReason` says why.
 */
export interface BillingController {
  unavailableReason: string | null;
  currentPlan: HapticPlanId;
  /** Provider status for the current paid plan, such as "Active" or "Past Due". */
  status?: string;
  renewsAt?: Date;
  /** Wraps the Haptic Pro button so it opens the provider's checkout. */
  renderSubscribe?: (button: BillingButton) => ReactElement;
  /** Wraps the Manage Billing button so it opens the provider's billing page. */
  renderManage?: (button: BillingButton) => ReactElement;
  /** Store builds must offer restoring purchases made on another install. */
  onRestore?: () => void;
}

/** Billing before RevenueCat keys are configured for this build. */
export function unconfiguredBilling(): BillingController {
  return {
    currentPlan: "free",
    unavailableReason: "Subscriptions are not set up for this build yet.",
  };
}
