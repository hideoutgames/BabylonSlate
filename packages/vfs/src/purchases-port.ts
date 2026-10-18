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

/**
 * Subscriptions on every host through RevenueCat: the App Store and Google
 * Play in the mobile apps, RevenueCat Web Billing on web and desktop. One
 * RevenueCat customer per account keeps entitlements shared across devices.
 */
export interface PurchasesPort {
  readonly store: PurchasesStore;
  /** Configures RevenueCat once and identifies the signed-in account. */
  configure(options: { apiKey: string; appUserId: string }): Promise<void>;
  status(entitlementId: string): Promise<EntitlementStatus>;
  /** Buys the current offering's first package; resolves false when the user cancels. */
  purchase(entitlementId: string, options?: { email?: string }): Promise<boolean>;
  /** Store hosts restore purchases made on another install; web has nothing to restore. */
  restore?(entitlementId: string): Promise<EntitlementStatus>;
}

export const INACTIVE_ENTITLEMENT: EntitlementStatus = {
  active: false,
  willRenew: false,
  expiresAt: null,
  managementUrl: null,
};
