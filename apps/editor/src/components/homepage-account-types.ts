import type { MouseEvent, ReactElement } from "react";
import type { NativeClerkSession } from "../services/native-clerk";

/** What the launcher calls a native account: full name, else username, else email. */
export function nativeAccountName(
  session: Pick<NativeClerkSession, "name" | "username" | "email">,
): string {
  return session.name || session.username || session.email;
}

/** Profile changes on a native account; each settles after Clerk has answered. */
export interface NativeProfileActions {
  updateName: (name: { firstName: string; lastName: string }) => Promise<void>;
  setImage: (file: File) => Promise<void>;
  removeImage: () => Promise<void>;
  /** Also signs the account out of this device. */
  deleteAccount: () => Promise<void>;
}

/**
 * What the Account dialog edits for accounts on the email-code client
 * (desktop, iOS, Android). On the web, Clerk's own account screen does this.
 */
export interface NativeProfileEditing extends NativeProfileActions {
  firstName: string;
  lastName: string;
  hasImage: boolean;
  /** Clerk's `delete_self_enabled`; the dashboard decides whether people may delete themselves. */
  canDelete: boolean;
}

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
