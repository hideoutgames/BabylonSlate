import {
  INACTIVE_ENTITLEMENT,
  type EntitlementStatus,
  type PurchasesPort,
} from "./purchases-port";

type WebSdk = typeof import("@revenuecat/purchases-js");
type WebPurchasesInstance = ReturnType<WebSdk["Purchases"]["configure"]>;
type CustomerInfo = Awaited<ReturnType<WebPurchasesInstance["getCustomerInfo"]>>;

function entitlementStatus(info: CustomerInfo, entitlementId: string): EntitlementStatus {
  const entitlement = info.entitlements.active[entitlementId];
  if (!entitlement) return { ...INACTIVE_ENTITLEMENT, managementUrl: info.managementURL };
  return {
    active: entitlement.isActive,
    willRenew: entitlement.willRenew,
    expiresAt: entitlement.expirationDate?.toISOString() ?? null,
    managementUrl: info.managementURL,
  };
}

/**
 * RevenueCat Web Billing for the browser and the desktop app. The SDK and its
 * checkout load only when billing is configured.
 */
export class WebPurchases implements PurchasesPort {
  readonly store = "web" as const;
  private sdk: Promise<{ sdk: WebSdk; instance: WebPurchasesInstance }> | null = null;

  async configure({ apiKey, appUserId }: { apiKey: string; appUserId: string }): Promise<void> {
    if (!this.sdk) {
      this.sdk = import("@revenuecat/purchases-js").then((sdk) => ({
        sdk,
        instance: sdk.Purchases.configure({ apiKey, appUserId }),
      }));
      this.sdk.catch(() => {
        this.sdk = null;
      });
      await this.sdk;
      return;
    }
    const { instance } = await this.sdk;
    if (instance.getAppUserId() !== appUserId) await instance.changeUser(appUserId);
  }

  private async instance(): Promise<{ sdk: WebSdk; instance: WebPurchasesInstance }> {
    if (!this.sdk) throw new Error("Billing is not configured.");
    return this.sdk;
  }

  async status(entitlementId: string): Promise<EntitlementStatus> {
    const { instance } = await this.instance();
    return entitlementStatus(await instance.getCustomerInfo(), entitlementId);
  }

  async purchase(entitlementId: string, options?: { email?: string }): Promise<boolean> {
    const { sdk, instance } = await this.instance();
    const pkg = (await instance.getOfferings()).current?.availablePackages[0];
    if (!pkg) throw new Error("No subscription is available to buy right now.");
    try {
      const { customerInfo } = await instance.purchase({
        rcPackage: pkg,
        customerEmail: options?.email,
      });
      return entitlementStatus(customerInfo, entitlementId).active;
    } catch (error) {
      if (
        error instanceof sdk.PurchasesError &&
        error.errorCode === sdk.ErrorCode.UserCancelledError
      )
        return false;
      throw error;
    }
  }
}
