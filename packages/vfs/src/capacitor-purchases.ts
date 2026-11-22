import { Purchases } from "@revenuecat/purchases-capacitor";
import {
  INACTIVE_ENTITLEMENT,
  type EntitlementStatus,
  type PurchaseRequest,
  type PurchasesAccount,
  type PurchasesPort,
  type PurchasesStore,
} from "./purchases-port";
import { SerialQueue, offeringPackage } from "./purchases-shared";

type CustomerInfo = Awaited<ReturnType<typeof Purchases.getCustomerInfo>>["customerInfo"];

function entitlementStatus(info: CustomerInfo, entitlementId: string): EntitlementStatus {
  const entitlement = info.entitlements.active[entitlementId];
  if (!entitlement) return { ...INACTIVE_ENTITLEMENT, managementUrl: info.managementURL };
  return {
    active: entitlement.isActive,
    willRenew: entitlement.willRenew,
    expiresAt: entitlement.expirationDate,
    managementUrl: info.managementURL,
  };
}

/** RevenueCat through its Capacitor plugin: App Store and Google Play. */
export class CapacitorPurchases implements PurchasesPort {
  private readonly queue = new SerialQueue();
  private configured = false;
  /** The account the SDK is identified as; undefined when anonymous or unknown. */
  private userId: string | undefined;

  readonly store: PurchasesStore;

  constructor(store: PurchasesStore) {
    this.store = store;
  }

  /** Runs inside the queue only. Records state only after each SDK call succeeds. */
  private async bind({ apiKey, appUserId }: PurchasesAccount): Promise<void> {
    if (!this.configured) {
      await Purchases.configure({ apiKey, appUserID: appUserId });
      this.configured = true;
      this.userId = appUserId;
      return;
    }
    if (this.userId === appUserId) return;
    await Purchases.logIn({ appUserID: appUserId });
    this.userId = appUserId;
  }

  private withAccount<T>(account: PurchasesAccount, operation: () => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      await this.bind(account);
      return operation();
    });
  }

  ensureConfigured(account: PurchasesAccount): Promise<void> {
    return this.withAccount(account, async () => {});
  }

  status(account: PurchasesAccount, entitlementId: string): Promise<EntitlementStatus> {
    return this.withAccount(account, async () => {
      const { customerInfo } = await Purchases.getCustomerInfo();
      return entitlementStatus(customerInfo, entitlementId);
    });
  }

  purchase(account: PurchasesAccount, { entitlementId, packageId }: PurchaseRequest): Promise<boolean> {
    return this.withAccount(account, async () => {
      const pkg = offeringPackage((await Purchases.getOfferings()).current, packageId);
      try {
        const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg });
        return entitlementStatus(customerInfo, entitlementId).active;
      } catch (error) {
        if ((error as { userCancelled?: boolean }).userCancelled) return false;
        throw error;
      }
    });
  }

  restore(account: PurchasesAccount, entitlementId: string): Promise<EntitlementStatus> {
    return this.withAccount(account, async () => {
      const { customerInfo } = await Purchases.restorePurchases();
      return entitlementStatus(customerInfo, entitlementId);
    });
  }

  logOut(): Promise<void> {
    return this.queue.run(async () => {
      if (!this.configured || this.userId === undefined) return;
      // Forget the account first: when the SDK call fails (offline), the next
      // account still logs in explicitly instead of being taken as bound.
      this.userId = undefined;
      try {
        // RevenueCat refuses to log out an anonymous user.
        if ((await Purchases.isAnonymous()).isAnonymous) return;
        await Purchases.logOut();
      } catch {
        /* Signing out never fails on billing; the next account logs in anyway. */
      }
    });
  }
}
