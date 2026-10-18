import { Purchases } from "@revenuecat/purchases-capacitor";
import {
  INACTIVE_ENTITLEMENT,
  type StoreEntitlementStatus,
  type StorePurchasesPort,
} from "./store-purchases-port";

type CustomerInfo = Awaited<ReturnType<typeof Purchases.getCustomerInfo>>["customerInfo"];

function entitlementStatus(
  info: CustomerInfo,
  entitlementId: string,
): StoreEntitlementStatus {
  const entitlement = info.entitlements.active[entitlementId];
  if (!entitlement) return { ...INACTIVE_ENTITLEMENT, managementUrl: info.managementURL };
  return {
    active: entitlement.isActive,
    willRenew: entitlement.willRenew,
    expiresAt: entitlement.expirationDate,
    managementUrl: info.managementURL,
  };
}

/** RevenueCat through its Capacitor plugin (App Store and Google Play). */
export class CapacitorStorePurchases implements StorePurchasesPort {
  readonly available = true;
  private configured: Promise<void> | null = null;
  private userId: string | undefined;

  async configure({ apiKey, appUserId }: { apiKey: string; appUserId?: string }): Promise<void> {
    if (!this.configured) {
      this.userId = appUserId;
      this.configured = Purchases.configure({ apiKey, appUserID: appUserId }).catch(
        (error: unknown) => {
          this.configured = null;
          throw error;
        },
      );
      return this.configured;
    }
    await this.configured;
    if (appUserId && appUserId !== this.userId) {
      await Purchases.logIn({ appUserID: appUserId });
      this.userId = appUserId;
    } else if (!appUserId && this.userId) {
      await Purchases.logOut();
      this.userId = undefined;
    }
  }

  async status(entitlementId: string): Promise<StoreEntitlementStatus> {
    const { customerInfo } = await Purchases.getCustomerInfo();
    return entitlementStatus(customerInfo, entitlementId);
  }

  async purchase(entitlementId: string): Promise<boolean> {
    const offering = (await Purchases.getOfferings()).current;
    const pkg = offering?.availablePackages[0];
    if (!pkg) throw new Error("No subscription is available to buy right now.");
    try {
      const { customerInfo } = await Purchases.purchasePackage({ aPackage: pkg });
      return entitlementStatus(customerInfo, entitlementId).active;
    } catch (error) {
      if ((error as { userCancelled?: boolean }).userCancelled) return false;
      throw error;
    }
  }

  async restore(entitlementId: string): Promise<StoreEntitlementStatus> {
    const { customerInfo } = await Purchases.restorePurchases();
    return entitlementStatus(customerInfo, entitlementId);
  }
}
