/** One store entitlement as the account's billing needs it. */
export interface StoreEntitlementStatus {
  active: boolean;
  willRenew: boolean;
  /** ISO date, or null for lifetime or inactive entitlements. */
  expiresAt: string | null;
  /** The store's own subscription management page, when it offers one. */
  managementUrl: string | null;
}

/**
 * App Store and Google Play subscriptions (RevenueCat on iOS and Android).
 * Other hosts get the unavailable port.
 */
export interface StorePurchasesPort {
  readonly available: boolean;
  /** Configures the store SDK once and identifies the signed-in account. */
  configure(options: { apiKey: string; appUserId?: string }): Promise<void>;
  status(entitlementId: string): Promise<StoreEntitlementStatus>;
  /** Buys the current offering's package; resolves false when the user cancels. */
  purchase(entitlementId: string): Promise<boolean>;
  restore(entitlementId: string): Promise<StoreEntitlementStatus>;
}

export const INACTIVE_ENTITLEMENT: StoreEntitlementStatus = {
  active: false,
  willRenew: false,
  expiresAt: null,
  managementUrl: null,
};

export class UnavailableStorePurchases implements StorePurchasesPort {
  readonly available = false;
  async configure(): Promise<void> {
    throw new Error("In-app purchases are only available in the iOS and Android apps.");
  }
  async status(): Promise<StoreEntitlementStatus> {
    return INACTIVE_ENTITLEMENT;
  }
  async purchase(): Promise<boolean> {
    throw new Error("In-app purchases are only available in the iOS and Android apps.");
  }
  async restore(): Promise<StoreEntitlementStatus> {
    return INACTIVE_ENTITLEMENT;
  }
}
