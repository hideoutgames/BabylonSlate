import { beforeEach, describe, expect, it, vi } from "vitest";

const configure = vi.fn();
const logIn = vi.fn();
const getCustomerInfo = vi.fn();
const getOfferings = vi.fn();
const purchasePackage = vi.fn();
const restorePurchases = vi.fn();

vi.mock("@revenuecat/purchases-capacitor", () => ({
  Purchases: { configure, logIn, getCustomerInfo, getOfferings, purchasePackage, restorePurchases },
}));

const { CapacitorPurchases } = await import("./capacitor-purchases");

const MANAGE_URL = "https://apps.apple.com/account/subscriptions";

function entitlement(identifier: string, overrides: Record<string, unknown> = {}) {
  return {
    identifier,
    isActive: true,
    willRenew: true,
    expirationDate: "2027-03-01T12:00:00Z",
    productIdentifier: "haptic_pro_monthly",
    ...overrides,
  };
}

/** The slice of RevenueCat CustomerInfo the plugin returns that billing reads. */
function customerInfo({
  active = {},
  all = active,
  managementURL = null,
}: {
  active?: Record<string, unknown>;
  all?: Record<string, unknown>;
  managementURL?: string | null;
} = {}) {
  return { customerInfo: { entitlements: { active, all }, managementURL } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const monthly = { identifier: "$rc_monthly" };
const annual = { identifier: "$rc_annual" };

describe("Capacitor purchases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configure.mockResolvedValue(undefined);
    logIn.mockResolvedValue(undefined);
  });

  describe("configure", () => {
    it("configures RevenueCat with the API key and the account's app user id", async () => {
      await new CapacitorPurchases("app-store").configure({ apiKey: "appl_key", appUserId: "user_1" });

      expect(configure.mock.calls).toEqual([[{ apiKey: "appl_key", appUserID: "user_1" }]]);
      expect(logIn).not.toHaveBeenCalled();
    });

    it("configures the SDK once for repeated and concurrent calls for the same account", async () => {
      const purchases = new CapacitorPurchases("play-store");
      const options = { apiKey: "goog_key", appUserId: "user_1" };

      await Promise.all([purchases.configure(options), purchases.configure(options)]);
      await purchases.configure(options);

      expect(configure).toHaveBeenCalledTimes(1);
      expect(logIn).not.toHaveBeenCalled();
    });

    it("logs in when another account signs in, and again when the first one returns", async () => {
      const purchases = new CapacitorPurchases("app-store");

      await purchases.configure({ apiKey: "appl_key", appUserId: "user_1" });
      await purchases.configure({ apiKey: "appl_key", appUserId: "user_2" });
      await purchases.configure({ apiKey: "appl_key", appUserId: "user_2" });
      await purchases.configure({ apiKey: "appl_key", appUserId: "user_1" });

      expect(configure).toHaveBeenCalledTimes(1);
      expect(logIn.mock.calls).toEqual([[{ appUserID: "user_2" }], [{ appUserID: "user_1" }]]);
    });

    it("waits for the SDK to finish configuring before switching to another account", async () => {
      const configuring = deferred();
      configure.mockReturnValue(configuring.promise);
      const purchases = new CapacitorPurchases("app-store");

      const first = purchases.configure({ apiKey: "appl_key", appUserId: "user_1" });
      const second = purchases.configure({ apiKey: "appl_key", appUserId: "user_2" });
      await Promise.resolve();
      expect(logIn).not.toHaveBeenCalled();

      configuring.resolve();
      await Promise.all([first, second]);

      expect(configure.mock.calls).toEqual([[{ apiKey: "appl_key", appUserID: "user_1" }]]);
      expect(logIn.mock.calls).toEqual([[{ appUserID: "user_2" }]]);
    });

    it("reports a failed configure and configures again on the next attempt", async () => {
      configure.mockRejectedValueOnce(new Error("store unavailable"));
      const purchases = new CapacitorPurchases("app-store");
      const options = { apiKey: "appl_key", appUserId: "user_1" };

      await expect(purchases.configure(options)).rejects.toThrow("store unavailable");
      await purchases.configure(options);

      expect(configure.mock.calls).toEqual([
        [{ apiKey: "appl_key", appUserID: "user_1" }],
        [{ apiKey: "appl_key", appUserID: "user_1" }],
      ]);
    });

    it("retries the log in after it failed instead of treating the account as switched", async () => {
      logIn.mockRejectedValueOnce(new Error("offline"));
      const purchases = new CapacitorPurchases("app-store");
      await purchases.configure({ apiKey: "appl_key", appUserId: "user_1" });

      await expect(purchases.configure({ apiKey: "appl_key", appUserId: "user_2" })).rejects.toThrow("offline");
      await purchases.configure({ apiKey: "appl_key", appUserId: "user_2" });

      expect(logIn.mock.calls).toEqual([[{ appUserID: "user_2" }], [{ appUserID: "user_2" }]]);
    });
  });

  describe("status", () => {
    it.each([
      {
        name: "an active renewing subscription",
        info: customerInfo({ active: { pro: entitlement("pro") }, managementURL: MANAGE_URL }),
        entitlementId: "pro",
        expected: { active: true, willRenew: true, expiresAt: "2027-03-01T12:00:00Z", managementUrl: MANAGE_URL },
      },
      {
        name: "an active subscription that ends at the period end",
        info: customerInfo({
          active: { pro: entitlement("pro", { willRenew: false, expirationDate: "2027-02-01T00:00:00Z" }) },
          managementURL: MANAGE_URL,
        }),
        entitlementId: "pro",
        expected: { active: true, willRenew: false, expiresAt: "2027-02-01T00:00:00Z", managementUrl: MANAGE_URL },
      },
      {
        name: "a lifetime entitlement without an expiry",
        info: customerInfo({ active: { pro: entitlement("pro", { expirationDate: null }) } }),
        entitlementId: "pro",
        expected: { active: true, willRenew: true, expiresAt: null, managementUrl: null },
      },
      {
        name: "another active entitlement but not the requested one",
        info: customerInfo({ active: { team: entitlement("team") }, managementURL: MANAGE_URL }),
        entitlementId: "pro",
        expected: { active: false, willRenew: false, expiresAt: null, managementUrl: MANAGE_URL },
      },
      {
        name: "several active entitlements, reading only the requested one",
        info: customerInfo({
          active: {
            pro: entitlement("pro", { expirationDate: "2027-03-01T12:00:00Z" }),
            team: entitlement("team", { willRenew: false, expirationDate: "2028-01-01T00:00:00Z" }),
          },
        }),
        entitlementId: "team",
        expected: { active: true, willRenew: false, expiresAt: "2028-01-01T00:00:00Z", managementUrl: null },
      },
      {
        name: "an entitlement that has expired",
        info: customerInfo({
          active: {},
          all: { pro: entitlement("pro", { isActive: false, willRenew: false, expirationDate: "2026-01-01T00:00:00Z" }) },
          managementURL: MANAGE_URL,
        }),
        entitlementId: "pro",
        expected: { active: false, willRenew: false, expiresAt: null, managementUrl: MANAGE_URL },
      },
      {
        name: "a customer who never subscribed",
        info: customerInfo(),
        entitlementId: "pro",
        expected: { active: false, willRenew: false, expiresAt: null, managementUrl: null },
      },
    ])("reports $name", async ({ info, entitlementId, expected }) => {
      getCustomerInfo.mockResolvedValue(info);

      expect(await new CapacitorPurchases("app-store").status(entitlementId)).toEqual(expected);
    });

    it("surfaces a failure to load the customer", async () => {
      getCustomerInfo.mockRejectedValue(new Error("offline"));

      await expect(new CapacitorPurchases("app-store").status("pro")).rejects.toThrow("offline");
    });
  });

  describe("purchase", () => {
    it.each([
      { name: "no current offering", offerings: { current: null, all: {} } },
      { name: "an offering without packages", offerings: { current: { availablePackages: [] }, all: {} } },
    ])("refuses to buy when there is $name", async ({ offerings }) => {
      getOfferings.mockResolvedValue(offerings);

      await expect(new CapacitorPurchases("app-store").purchase("pro")).rejects.toThrow(
        "No subscription is available to buy right now.",
      );
      expect(purchasePackage).not.toHaveBeenCalled();
    });

    it("buys the first package of the current offering and reports the entitlement as granted", async () => {
      getOfferings.mockResolvedValue({ current: { availablePackages: [monthly, annual] }, all: {} });
      purchasePackage.mockResolvedValue({
        ...customerInfo({ active: { pro: entitlement("pro") } }),
        transaction: { transactionIdentifier: "tx_1" },
      });

      expect(await new CapacitorPurchases("app-store").purchase("pro")).toBe(true);
      expect(purchasePackage.mock.calls).toEqual([[{ aPackage: monthly }]]);
    });

    it("resolves false when the user cancels the store sheet", async () => {
      getOfferings.mockResolvedValue({ current: { availablePackages: [monthly] }, all: {} });
      purchasePackage.mockRejectedValue(Object.assign(new Error("Purchase was cancelled."), { userCancelled: true }));

      expect(await new CapacitorPurchases("app-store").purchase("pro")).toBe(false);
    });

    it.each([false, null])("rethrows a store failure that is not a cancellation (userCancelled: %s)", async (userCancelled) => {
      const failure = Object.assign(new Error("The payment was declined."), { userCancelled });
      getOfferings.mockResolvedValue({ current: { availablePackages: [monthly] }, all: {} });
      purchasePackage.mockRejectedValue(failure);

      await expect(new CapacitorPurchases("app-store").purchase("pro")).rejects.toBe(failure);
    });
  });

  describe("restore", () => {
    it("restores purchases made on another install and reports the entitlement", async () => {
      restorePurchases.mockResolvedValue(
        customerInfo({ active: { pro: entitlement("pro", { willRenew: false }) }, managementURL: MANAGE_URL }),
      );

      expect(await new CapacitorPurchases("app-store").restore("pro")).toEqual({
        active: true,
        willRenew: false,
        expiresAt: "2027-03-01T12:00:00Z",
        managementUrl: MANAGE_URL,
      });
      expect(restorePurchases).toHaveBeenCalledTimes(1);
    });

    it("reports an inactive entitlement when the account has nothing to restore", async () => {
      restorePurchases.mockResolvedValue(customerInfo({ managementURL: MANAGE_URL }));

      expect(await new CapacitorPurchases("play-store").restore("pro")).toEqual({
        active: false,
        willRenew: false,
        expiresAt: null,
        managementUrl: MANAGE_URL,
      });
    });

    it("surfaces a restore failure", async () => {
      restorePurchases.mockRejectedValue(new Error("offline"));

      await expect(new CapacitorPurchases("app-store").restore("pro")).rejects.toThrow("offline");
    });
  });
});
