import {
  INACTIVE_ENTITLEMENT,
  type EntitlementStatus,
  type PurchaseRequest,
  type PurchasesAccount,
  type PurchasesPort,
} from "./purchases-port";
import { SerialQueue, offeringPackage } from "./purchases-shared";

type WebSdk = typeof import("@revenuecat/purchases-js");
type WebPurchasesInstance = ReturnType<WebSdk["Purchases"]["configure"]>;
type CustomerInfo = Awaited<ReturnType<WebPurchasesInstance["getCustomerInfo"]>>;
type Bound = { sdk: WebSdk; instance: WebPurchasesInstance };

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
  private readonly queue = new SerialQueue();
  private bound: Bound | null = null;

  /** Runs inside the queue only; a failed load or configure leaves nothing behind. */
  private async bind({ apiKey, appUserId }: PurchasesAccount): Promise<Bound> {
    if (!this.bound) {
      const sdk = await import("@revenuecat/purchases-js");
      this.bound = { sdk, instance: sdk.Purchases.configure({ apiKey, appUserId }) };
      return this.bound;
    }
    const { instance } = this.bound;
    if (instance.getAppUserId() !== appUserId) await instance.changeUser(appUserId);
    return this.bound;
  }

  private withAccount<T>(account: PurchasesAccount, operation: (bound: Bound) => Promise<T>): Promise<T> {
    return this.queue.run(async () => operation(await this.bind(account)));
  }

  async ensureConfigured(account: PurchasesAccount): Promise<void> {
    await this.withAccount(account, async () => {});
  }

  status(account: PurchasesAccount, entitlementId: string): Promise<EntitlementStatus> {
    return this.withAccount(account, async ({ instance }) =>
      entitlementStatus(await instance.getCustomerInfo(), entitlementId),
    );
  }

  purchase(account: PurchasesAccount, { entitlementId, packageId, email }: PurchaseRequest): Promise<boolean> {
    return this.withAccount(account, async ({ sdk, instance }) => {
      const pkg = offeringPackage((await instance.getOfferings()).current, packageId);
      try {
        const { customerInfo } = await instance.purchase({
          rcPackage: pkg,
          ...(email ? { customerEmail: email } : {}),
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
    });
  }

  /**
   * Web Billing has no anonymous customer to fall back to, so the SDK instance
   * is closed (no network needed) and the next account configures afresh.
   */
  logOut(): Promise<void> {
    return this.queue.run(async () => {
      const bound = this.bound;
      this.bound = null;
      try {
        bound?.instance.close();
      } catch {
        /* Signing out never fails on billing. */
      }
    });
  }
}
