import { beforeEach, describe, expect, it, vi } from "vitest";

const configure = vi.fn();
const logIn = vi.fn();
const getCustomerInfo = vi.fn();
const getOfferings = vi.fn();
const purchasePackage = vi.fn();
const restorePurchases = vi.fn();
const logOut = vi.fn();
const isAnonymous = vi.fn();

vi.mock("@revenuecat/purchases-capacitor", () => ({
  Purchases: { configure, logIn, logOut, isAnonymous, getCustomerInfo, getOfferings, purchasePackage, restorePurchases },
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
const account = { apiKey: "appl_key", appUserId: "user_1" };
const monthlyPro = { entitlementId: "pro", packageId: "$rc_monthly" } as const;

describe("Capacitor purchases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configure.mockResolvedValue(undefined);
    logIn.mockResolvedValue(undefined);
    logOut.mockResolvedValue(undefined);
    isAnonymous.mockResolvedValue({ isAnonymous: false });
  });

  describe("ensureConfigured", () => {
    it("configures RevenueCat with the API key and the account's app user id", async () => {
      await new CapacitorPurchases("app-store").ensureConfigured({ apiKey: "appl_key", appUserId: "user_1" });

      expect(configure.mock.calls).toEqual([[{ apiKey: "appl_key", appUserID: "user_1" }]]);
      expect(logIn).not.toHaveBeenCalled();
    });

    it("configures the SDK once for repeated and concurrent calls for the same account", async () => {
      const purchases = new CapacitorPurchases("play-store");
      const options = { apiKey: "goog_key", appUserId: "user_1" };

      await Promise.all([purchases.ensureConfigured(options), purchases.ensureConfigured(options)]);
      await purchases.ensureConfigured(options);

      expect(configure).toHaveBeenCalledTimes(1);
      expect(logIn).not.toHaveBeenCalled();
    });

    it("logs in when another account signs in, and again when the first one returns", async () => {
      const purchases = new CapacitorPurchases("app-store");

      await purchases.ensureConfigured({ apiKey: "appl_key", appUserId: "user_1" });
      await purchases.ensureConfigured({ apiKey: "appl_key", appUserId: "user_2" });
      await purchases.ensureConfigured({ apiKey: "appl_key", appUserId: "user_2" });
      await purchases.ensureConfigured({ apiKey: "appl_key", appUserId: "user_1" });

      expect(configure).toHaveBeenCalledTimes(1);
      expect(logIn.mock.calls).toEqual([[{ appUserID: "user_2" }], [{ appUserID: "user_1" }]]);
    });

    it("waits for the SDK to finish configuring before switching to another account", async () => {
      const configuring = deferred();
      configure.mockReturnValue(configuring.promise);
      const purchases = new CapacitorPurchases("app-store");

      const first = purchases.ensureConfigured({ apiKey: "appl_key", appUserId: "user_1" });
      const second = purchases.ensureConfigured({ apiKey: "appl_key", appUserId: "user_2" });
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

      await expect(purchases.ensureConfigured(options)).rejects.toThrow("store unavailable");
      await purchases.ensureConfigured(options);

      expect(configure.mock.calls).toEqual([
        [{ apiKey: "appl_key", appUserID: "user_1" }],
        [{ apiKey: "appl_key", appUserID: "user_1" }],
      ]);
    });

    it("serializes concurrent switches so the last requested account ends up bound", async () => {
      const purchases = new CapacitorPurchases("app-store");
      await purchases.ensureConfigured(account);
      const loggingIn = deferred();
      logIn.mockReturnValueOnce(loggingIn.promise);

      const second = purchases.ensureConfigured({ ...account, appUserId: "user_2" });
      const third = purchases.ensureConfigured({ ...account, appUserId: "user_3" });
      await new Promise((settle) => setTimeout(settle, 0));
      // The switch to user_3 waits for the switch to user_2 to finish.
      expect(logIn.mock.calls).toEqual([[{ appUserID: "user_2" }]]);

      loggingIn.resolve();
      await Promise.all([second, third]);
      expect(logIn.mock.calls).toEqual([[{ appUserID: "user_2" }], [{ appUserID: "user_3" }]]);
    });

    it("reads another account's status only after switching to it, even while the first configure is pending", async () => {
      const configuring = deferred();
      configure.mockReturnValueOnce(configuring.promise);
      getCustomerInfo.mockResolvedValue(customerInfo());
      const purchases = new CapacitorPurchases("app-store");

      const first = purchases.ensureConfigured(account);
      const status = purchases.status({ ...account, appUserId: "user_2" }, "pro");
      configuring.resolve();
      await Promise.all([first, status]);

      expect(logIn.mock.calls).toEqual([[{ appUserID: "user_2" }]]);
      expect(logIn.mock.invocationCallOrder[0]).toBeLessThan(getCustomerInfo.mock.invocationCallOrder[0]!);
    });

    it("retries the log in after it failed instead of treating the account as switched", async () => {
      logIn.mockRejectedValueOnce(new Error("offline"));
      const purchases = new CapacitorPurchases("app-store");
      await purchases.ensureConfigured({ apiKey: "appl_key", appUserId: "user_1" });

      await expect(purchases.ensureConfigured({ apiKey: "appl_key", appUserId: "user_2" })).rejects.toThrow("offline");
      await purchases.ensureConfigured({ apiKey: "appl_key", appUserId: "user_2" });

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

      expect(await new CapacitorPurchases("app-store").status(account, entitlementId)).toEqual(expected);
    });

    it("surfaces a failure to load the customer", async () => {
      getCustomerInfo.mockRejectedValue(new Error("offline"));

      await expect(new CapacitorPurchases("app-store").status(account, "pro")).rejects.toThrow("offline");
    });
  });

  describe("plans", () => {
    // The plugin's PurchasesPackage: the store product carries the localized price and ISO 8601 period.
    const storeMonthly = { identifier: "$rc_monthly", product: { priceString: "9,99 €", subscriptionPeriod: "P1M" } };
    const storeAnnual = { identifier: "$rc_annual", product: { priceString: "99,99 €", subscriptionPeriod: "P1Y" } };
    const storeWeekly = { identifier: "$rc_weekly", product: { priceString: "2,99 €", subscriptionPeriod: "P1W" } };

    it.each([
      {
        name: "both plans, monthly first whatever the offering's order",
        packages: [storeWeekly, storeAnnual, storeMonthly],
        expected: [
          { packageId: "$rc_monthly", priceString: "9,99 €", billingPeriod: "P1M" },
          { packageId: "$rc_annual", priceString: "99,99 €", billingPeriod: "P1Y" },
        ],
      },
      {
        name: "only the annual plan",
        packages: [storeAnnual],
        expected: [{ packageId: "$rc_annual", priceString: "99,99 €", billingPeriod: "P1Y" }],
      },
      { name: "neither plan", packages: [storeWeekly], expected: [] },
    ])("lists $name with the store's price string and period", async ({ packages, expected }) => {
      getOfferings.mockResolvedValue({ current: { availablePackages: packages }, all: {} });

      expect(await new CapacitorPurchases("app-store").plans(account)).toEqual(expected);
    });

    it("lists no plans without a current offering", async () => {
      getOfferings.mockResolvedValue({ current: null, all: {} });

      expect(await new CapacitorPurchases("app-store").plans(account)).toEqual([]);
    });

    it("configures billing before listing plans when the first configure failed offline", async () => {
      configure.mockRejectedValueOnce(new Error("offline"));
      getOfferings.mockResolvedValue({ current: { availablePackages: [storeMonthly] }, all: {} });
      const purchases = new CapacitorPurchases("app-store");
      await expect(purchases.plans(account)).rejects.toThrow("offline");

      expect(await purchases.plans(account)).toEqual([
        { packageId: "$rc_monthly", priceString: "9,99 €", billingPeriod: "P1M" },
      ]);
      expect(configure).toHaveBeenCalledTimes(2);
      expect(getOfferings).toHaveBeenCalledTimes(1);
    });
  });

  describe("purchase", () => {
    it.each([
      {
        name: "no current offering",
        offerings: { current: null, all: {} },
        message: "No subscription is available to buy right now.",
      },
      {
        name: "an offering without packages",
        offerings: { current: { availablePackages: [] }, all: {} },
        message: 'The subscription package "$rc_monthly" is not available right now.',
      },
      {
        name: "an offering without the requested package",
        offerings: { current: { availablePackages: [annual] }, all: {} },
        message: 'The subscription package "$rc_monthly" is not available right now.',
      },
    ])("refuses to buy when there is $name", async ({ offerings, message }) => {
      getOfferings.mockResolvedValue(offerings);

      await expect(new CapacitorPurchases("app-store").purchase(account, monthlyPro)).rejects.toThrow(message);
      expect(purchasePackage).not.toHaveBeenCalled();
    });

    it("buys the requested package of the current offering, not the first one, and reports the entitlement", async () => {
      getOfferings.mockResolvedValue({ current: { availablePackages: [monthly, annual] }, all: {} });
      purchasePackage.mockResolvedValue({
        ...customerInfo({ active: { pro: entitlement("pro") } }),
        transaction: { transactionIdentifier: "tx_1" },
      });

      expect(
        await new CapacitorPurchases("app-store").purchase(account, { entitlementId: "pro", packageId: "$rc_annual" }),
      ).toBe(true);
      expect(purchasePackage.mock.calls).toEqual([[{ aPackage: annual }]]);
    });

    it("configures billing before buying when the first configure failed offline", async () => {
      configure.mockRejectedValueOnce(new Error("offline"));
      getOfferings.mockResolvedValue({ current: { availablePackages: [monthly] }, all: {} });
      purchasePackage.mockResolvedValue(customerInfo({ active: { pro: entitlement("pro") } }));
      const purchases = new CapacitorPurchases("app-store");
      await expect(purchases.ensureConfigured(account)).rejects.toThrow("offline");

      expect(await purchases.purchase(account, monthlyPro)).toBe(true);
      expect(configure).toHaveBeenCalledTimes(2);
      expect(configure.mock.invocationCallOrder[1]).toBeLessThan(getOfferings.mock.invocationCallOrder[0]!);
    });

    it("resolves false when the user cancels the store sheet", async () => {
      getOfferings.mockResolvedValue({ current: { availablePackages: [monthly] }, all: {} });
      purchasePackage.mockRejectedValue(Object.assign(new Error("Purchase was cancelled."), { userCancelled: true }));

      expect(await new CapacitorPurchases("app-store").purchase(account, monthlyPro)).toBe(false);
    });

    it.each([false, null])("rethrows a store failure that is not a cancellation (userCancelled: %s)", async (userCancelled) => {
      const failure = Object.assign(new Error("The payment was declined."), { userCancelled });
      getOfferings.mockResolvedValue({ current: { availablePackages: [monthly] }, all: {} });
      purchasePackage.mockRejectedValue(failure);

      await expect(new CapacitorPurchases("app-store").purchase(account, monthlyPro)).rejects.toBe(failure);
    });
  });

  describe("restore", () => {
    it("restores purchases made on another install and reports the entitlement", async () => {
      restorePurchases.mockResolvedValue(
        customerInfo({ active: { pro: entitlement("pro", { willRenew: false }) }, managementURL: MANAGE_URL }),
      );

      expect(await new CapacitorPurchases("app-store").restore(account, "pro")).toEqual({
        active: true,
        willRenew: false,
        expiresAt: "2027-03-01T12:00:00Z",
        managementUrl: MANAGE_URL,
      });
      expect(restorePurchases).toHaveBeenCalledTimes(1);
    });

    it("configures billing before restoring when the first configure failed offline", async () => {
      configure.mockRejectedValueOnce(new Error("offline"));
      restorePurchases.mockResolvedValue(customerInfo({ active: { pro: entitlement("pro") } }));
      const purchases = new CapacitorPurchases("app-store");
      await expect(purchases.ensureConfigured(account)).rejects.toThrow("offline");

      expect((await purchases.restore(account, "pro")).active).toBe(true);
      expect(configure).toHaveBeenCalledTimes(2);
      expect(configure.mock.invocationCallOrder[1]).toBeLessThan(restorePurchases.mock.invocationCallOrder[0]!);
    });

    it("reports an inactive entitlement when the account has nothing to restore", async () => {
      restorePurchases.mockResolvedValue(customerInfo({ managementURL: MANAGE_URL }));

      expect(await new CapacitorPurchases("play-store").restore(account, "pro")).toEqual({
        active: false,
        willRenew: false,
        expiresAt: null,
        managementUrl: MANAGE_URL,
      });
    });

    it("surfaces a restore failure", async () => {
      restorePurchases.mockRejectedValue(new Error("offline"));

      await expect(new CapacitorPurchases("app-store").restore(account, "pro")).rejects.toThrow("offline");
    });
  });

  describe("logOut", () => {
    it("logs the signed-out account out of RevenueCat and logs the next sign-in in explicitly", async () => {
      const purchases = new CapacitorPurchases("app-store");
      await purchases.ensureConfigured(account);

      await purchases.logOut();
      await purchases.ensureConfigured(account);

      expect(logOut).toHaveBeenCalledTimes(1);
      expect(logIn.mock.calls).toEqual([[{ appUserID: "user_1" }]]);
    });

    it("skips RevenueCat's log out for an anonymous user, which it refuses", async () => {
      isAnonymous.mockResolvedValue({ isAnonymous: true });
      const purchases = new CapacitorPurchases("app-store");
      await purchases.ensureConfigured(account);

      await purchases.logOut();

      expect(logOut).not.toHaveBeenCalled();
    });

    it("still signs out when RevenueCat cannot log out, and binds the next account afterwards", async () => {
      logOut.mockRejectedValue(new Error("offline"));
      const purchases = new CapacitorPurchases("app-store");
      await purchases.ensureConfigured(account);

      await expect(purchases.logOut()).resolves.toBeUndefined();
      await purchases.ensureConfigured(account);

      expect(logIn.mock.calls).toEqual([[{ appUserID: "user_1" }]]);
    });

    it("does nothing before billing was configured", async () => {
      await new CapacitorPurchases("app-store").logOut();

      expect(logOut).not.toHaveBeenCalled();
      expect(isAnonymous).not.toHaveBeenCalled();
    });
  });
});
