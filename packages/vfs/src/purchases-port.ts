/** One RevenueCat entitlement as the account's billing needs it. */
export interface EntitlementStatus {
  active: boolean;
  willRenew: boolean;
  /** ISO date, or null for lifetime or inactive entitlements. */
  expiresAt: string | null;
  /** The store's own subscription management page, when it offers one. */
  managementUrl: string | null;
}

/** Where a host's purchases are made; all of them run through RevenueCat. */
export type PurchasesStore = "app-store" | "play-store" | "web";

/** The RevenueCat key for this host and the signed-in account billing runs for. */
export interface PurchasesAccount {
  apiKey: string;
  appUserId: string;
}

/** RevenueCat's well-known package identifiers for Haptic Pro's two plans. */
export const MONTHLY_PACKAGE = "$rc_monthly";
export const ANNUAL_PACKAGE = "$rc_annual";
/** The plans the app sells, in display order. */
export const SUBSCRIPTION_PACKAGES = [MONTHLY_PACKAGE, ANNUAL_PACKAGE] as const;
export type SubscriptionPackageId = (typeof SUBSCRIPTION_PACKAGES)[number];

/** One plan of the current offering, as the store reports it. */
export interface SubscriptionPlan {
  packageId: SubscriptionPackageId;
  /** The store's localized price, verbatim (currency included); never formatted by Haptic. */
  priceString: string;
  /** The store's billing period in ISO 8601 (`P1M`, `P1Y`), or null when it reports none. */
  billingPeriod: string | null;
}

/** What to buy: one package of the current offering, chosen by its identifier. */
export interface PurchaseRequest {
  entitlementId: string;
  /** The plan the person chose; adapters have no default. */
  packageId: SubscriptionPackageId;
  email?: string;
}

/**
 * Subscriptions on every host through RevenueCat: the App Store and Google
 * Play in the mobile apps, RevenueCat Web Billing on web and desktop. One
 * RevenueCat customer per account keeps entitlements shared across devices.
 *
 * Every call runs in one queue per port, and each call first makes sure the
 * SDK is configured and identified as `account`, so a configure for one
 * account can never finish after, and undo, a switch to another. A failed
 * configure is retried by the next call.
 */
export interface PurchasesPort {
  readonly store: PurchasesStore;
  /** Configures RevenueCat once and identifies the account; idempotent. */
  ensureConfigured(account: PurchasesAccount): Promise<void>;
  status(account: PurchasesAccount, entitlementId: string): Promise<EntitlementStatus>;
  /**
   * The current offering's plans among `SUBSCRIPTION_PACKAGES`, in that order;
   * empty when the offering has neither (or there is no current offering).
   */
  plans(account: PurchasesAccount): Promise<SubscriptionPlan[]>;
  /** Buys `packageId` from the current offering; resolves false when the user cancels. */
  purchase(account: PurchasesAccount, request: PurchaseRequest): Promise<boolean>;
  /** Store hosts restore purchases made on another install; web has nothing to restore. */
  restore?(account: PurchasesAccount, entitlementId: string): Promise<EntitlementStatus>;
  /** Unbinds the signed-out account; the next call identifies the next one. Never rejects. */
  logOut(): Promise<void>;
}

export const INACTIVE_ENTITLEMENT: EntitlementStatus = {
  active: false,
  willRenew: false,
  expiresAt: null,
  managementUrl: null,
};
