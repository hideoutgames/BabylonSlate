import { beforeEach, describe, expect, it, vi } from "vitest";

const configure = vi.fn();

// Only the SDK entry point is replaced: its real PurchasesError and ErrorCode stay, so the
// cancellation check sees the same classes the browser SDK throws.
vi.mock("@revenuecat/purchases-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@revenuecat/purchases-js")>()),
  Purchases: { configure },
}));

const { ErrorCode, PurchasesError } = await import("@revenuecat/purchases-js");
const { WebPurchases } = await import("./web-purchases");

const MANAGE_URL = "https://pay.rev.cat/manage/abc";

function entitlement(identifier: string, overrides: Record<string, unknown> = {}) {
  return {
    identifier,
    isActive: true,
    willRenew: true,
    expirationDate: new Date("2027-03-01T12:00:00.000Z"),
    productIdentifier: "haptic_pro_monthly",
    ...overrides,
  };
}

/** The slice of RevenueCat CustomerInfo the web SDK returns that billing reads. */
function customerInfo({
  active = {},
  managementURL = null,
}: {
  active?: Record<string, unknown>;
  managementURL?: string | null;
} = {}) {
  return { entitlements: { active, all: active }, managementURL };
}

/** A configured web SDK instance that remembers which customer it is identified as. */
function sdkInstance(appUserId: string) {
  let identified = appUserId;
  return {
    getAppUserId: vi.fn(() => identified),
    changeUser: vi.fn(async (next: string) => {
      identified = next;
      return customerInfo();
    }),
    getCustomerInfo: vi.fn(),
    getOfferings: vi.fn(),
    purchase: vi.fn(),
    close: vi.fn(),
  };
}

let instance: ReturnType<typeof sdkInstance>;

const monthly = { identifier: "$rc_monthly" };
const annual = { identifier: "$rc_annual" };
const options = { apiKey: "rcb_key", appUserId: "user_1" };
const monthlyPro = { entitlementId: "pro", packageId: "$rc_monthly" } as const;

async function configured() {
  const purchases = new WebPurchases();
  await purchases.ensureConfigured(options);
  return purchases;
}

describe("Web purchases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configure.mockImplementation(({ appUserId }: { appUserId: string }) => (instance = sdkInstance(appUserId)));
  });

  describe("ensureConfigured", () => {
    it("configures RevenueCat Web Billing with the API key and the account's app user id", async () => {
      await new WebPurchases().ensureConfigured(options);

      expect(configure.mock.calls).toEqual([[{ apiKey: "rcb_key", appUserId: "user_1" }]]);
      expect(instance.changeUser).not.toHaveBeenCalled();
    });

    it("configures the SDK once for repeated and concurrent calls for the same account", async () => {
      const purchases = new WebPurchases();

      await Promise.all([purchases.ensureConfigured(options), purchases.ensureConfigured(options)]);
      await purchases.ensureConfigured(options);

      expect(configure).toHaveBeenCalledTimes(1);
      expect(instance.changeUser).not.toHaveBeenCalled();
    });

    it("switches the customer when another account signs in, once per change", async () => {
      const purchases = new WebPurchases();

      await purchases.ensureConfigured(options);
      await purchases.ensureConfigured({ ...options, appUserId: "user_2" });
      await purchases.ensureConfigured({ ...options, appUserId: "user_2" });

      expect(configure).toHaveBeenCalledTimes(1);
      expect(instance.changeUser.mock.calls).toEqual([["user_2"]]);
    });

    it("switches the customer when another account signs in during the first configure", async () => {
      const purchases = new WebPurchases();

      await Promise.all([purchases.ensureConfigured(options), purchases.ensureConfigured({ ...options, appUserId: "user_2" })]);

      expect(configure.mock.calls).toEqual([[{ apiKey: "rcb_key", appUserId: "user_1" }]]);
      expect(instance.changeUser.mock.calls).toEqual([["user_2"]]);
    });

    it("configures again on the next call after a failed configure", async () => {
      configure.mockImplementationOnce(() => {
        throw new Error("Invalid API key");
      });
      const purchases = new WebPurchases();

      await expect(purchases.ensureConfigured(options)).rejects.toThrow("Invalid API key");
      configure.mockImplementationOnce(({ appUserId }: { appUserId: string }) => {
        instance = sdkInstance(appUserId);
        instance.getCustomerInfo.mockResolvedValue(customerInfo({ active: { pro: entitlement("pro") } }));
        return instance;
      });

      expect((await purchases.status(options, "pro")).active).toBe(true);
      expect(configure).toHaveBeenCalledTimes(2);
    });

    it("reads another account's status only after switching to it", async () => {
      const purchases = new WebPurchases();

      const first = purchases.ensureConfigured(options);
      const status = purchases.status({ ...options, appUserId: "user_2" }, "pro").catch(() => undefined);
      await Promise.all([first, status]);

      expect(instance.changeUser.mock.calls).toEqual([["user_2"]]);
      expect(instance.changeUser.mock.invocationCallOrder[0]).toBeLessThan(
        instance.getCustomerInfo.mock.invocationCallOrder[0]!,
      );
    });
  });

  describe("status", () => {
    it.each([
      {
        name: "an active renewing subscription",
        info: customerInfo({ active: { pro: entitlement("pro") }, managementURL: MANAGE_URL }),
        entitlementId: "pro",
        expected: { active: true, willRenew: true, expiresAt: "2027-03-01T12:00:00.000Z", managementUrl: MANAGE_URL },
      },
      {
        name: "an active subscription that ends at the period end",
        info: customerInfo({
          active: { pro: entitlement("pro", { willRenew: false, expirationDate: new Date("2027-02-01T00:00:00.000Z") }) },
          managementURL: MANAGE_URL,
        }),
        entitlementId: "pro",
        expected: { active: true, willRenew: false, expiresAt: "2027-02-01T00:00:00.000Z", managementUrl: MANAGE_URL },
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
            pro: entitlement("pro"),
            team: entitlement("team", { willRenew: false, expirationDate: new Date("2028-01-01T00:00:00.000Z") }),
          },
        }),
        entitlementId: "team",
        expected: { active: true, willRenew: false, expiresAt: "2028-01-01T00:00:00.000Z", managementUrl: null },
      },
      {
        name: "a customer without an active entitlement",
        info: customerInfo({ managementURL: MANAGE_URL }),
        entitlementId: "pro",
        expected: { active: false, willRenew: false, expiresAt: null, managementUrl: MANAGE_URL },
      },
    ])("reports $name", async ({ info, entitlementId, expected }) => {
      const purchases = await configured();
      instance.getCustomerInfo.mockResolvedValue(info);

      expect(await purchases.status(options, entitlementId)).toEqual(expected);
    });

    it("surfaces a failure to load the customer", async () => {
      const purchases = await configured();
      instance.getCustomerInfo.mockRejectedValue(new Error("offline"));

      await expect(purchases.status(options, "pro")).rejects.toThrow("offline");
    });
  });

  describe("plans", () => {
    // Web Billing's Package: product.price.formattedPrice and product.normalPeriodDuration.
    const webPackage = (identifier: string, formattedPrice: string, normalPeriodDuration: string) => ({
      identifier,
      product: { price: { formattedPrice }, normalPeriodDuration },
    });
    const webMonthly = webPackage("$rc_monthly", "$9.99", "P1M");
    const webAnnual = webPackage("$rc_annual", "$99.99", "P1Y");
    const webLifetime = webPackage("$rc_lifetime", "$299.99", "P0D");

    it.each([
      {
        name: "both plans, monthly first whatever the offering's order",
        packages: [webAnnual, webLifetime, webMonthly],
        expected: [
          { packageId: "$rc_monthly", priceString: "$9.99", billingPeriod: "P1M" },
          { packageId: "$rc_annual", priceString: "$99.99", billingPeriod: "P1Y" },
        ],
      },
      {
        name: "only the monthly plan",
        packages: [webMonthly],
        expected: [{ packageId: "$rc_monthly", priceString: "$9.99", billingPeriod: "P1M" }],
      },
      { name: "neither plan", packages: [webLifetime], expected: [] },
    ])("lists $name with the store's price string and period", async ({ packages, expected }) => {
      const purchases = await configured();
      instance.getOfferings.mockResolvedValue({ current: { availablePackages: packages }, all: {} });

      expect(await purchases.plans(options)).toEqual(expected);
    });

    it("lists no plans without a current offering", async () => {
      const purchases = await configured();
      instance.getOfferings.mockResolvedValue({ current: null, all: {} });

      expect(await purchases.plans(options)).toEqual([]);
    });

    it("configures billing before listing plans when the first configure failed offline", async () => {
      configure.mockImplementationOnce(() => {
        throw new Error("offline");
      });
      const purchases = new WebPurchases();
      await expect(purchases.plans(options)).rejects.toThrow("offline");
      configure.mockImplementationOnce(({ appUserId }: { appUserId: string }) => {
        instance = sdkInstance(appUserId);
        instance.getOfferings.mockResolvedValue({ current: { availablePackages: [webAnnual] }, all: {} });
        return instance;
      });

      expect(await purchases.plans(options)).toEqual([
        { packageId: "$rc_annual", priceString: "$99.99", billingPeriod: "P1Y" },
      ]);
      expect(configure).toHaveBeenCalledTimes(2);
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
        name: "an offering without the requested package",
        offerings: { current: { availablePackages: [annual] }, all: {} },
        message: 'The subscription package "$rc_monthly" is not available right now.',
      },
    ])("refuses to buy when there is $name", async ({ offerings, message }) => {
      const purchases = await configured();
      instance.getOfferings.mockResolvedValue(offerings);

      await expect(purchases.purchase(options, monthlyPro)).rejects.toThrow(message);
      expect(instance.purchase).not.toHaveBeenCalled();
    });

    it("buys the requested package for the account's email and reports the entitlement as granted", async () => {
      const purchases = await configured();
      instance.getOfferings.mockResolvedValue({ current: { availablePackages: [monthly, annual] }, all: {} });
      instance.purchase.mockResolvedValue({ customerInfo: customerInfo({ active: { pro: entitlement("pro") } }) });

      expect(
        await purchases.purchase(options, { entitlementId: "pro", packageId: "$rc_annual", email: "person@example.com" }),
      ).toBe(true);
      expect(instance.purchase.mock.calls).toEqual([[{ rcPackage: annual, customerEmail: "person@example.com" }]]);
    });

    it("sends no customer email when the account has none, so the checkout asks for it", async () => {
      const purchases = await configured();
      instance.getOfferings.mockResolvedValue({ current: { availablePackages: [monthly] }, all: {} });
      instance.purchase.mockResolvedValue({ customerInfo: customerInfo({ active: { pro: entitlement("pro") } }) });

      expect(await purchases.purchase(options, monthlyPro)).toBe(true);
      expect(instance.purchase.mock.calls).toEqual([[{ rcPackage: monthly }]]);
      expect(Object.keys(instance.purchase.mock.calls[0]![0] as object)).toEqual(["rcPackage"]);
    });

    it("configures billing before buying when the first configure failed offline", async () => {
      configure.mockImplementationOnce(() => {
        throw new Error("offline");
      });
      const purchases = new WebPurchases();
      await expect(purchases.ensureConfigured(options)).rejects.toThrow("offline");
      configure.mockImplementationOnce(({ appUserId }: { appUserId: string }) => {
        instance = sdkInstance(appUserId);
        instance.getOfferings.mockResolvedValue({ current: { availablePackages: [monthly] }, all: {} });
        instance.purchase.mockResolvedValue({ customerInfo: customerInfo({ active: { pro: entitlement("pro") } }) });
        return instance;
      });

      expect(await purchases.purchase(options, monthlyPro)).toBe(true);
      expect(configure).toHaveBeenCalledTimes(2);
    });

    it("resolves false when the user closes the checkout", async () => {
      const purchases = await configured();
      instance.getOfferings.mockResolvedValue({ current: { availablePackages: [monthly] }, all: {} });
      instance.purchase.mockRejectedValue(new PurchasesError(ErrorCode.UserCancelledError, "Purchase cancelled"));

      expect(await purchases.purchase(options, monthlyPro)).toBe(false);
    });

    it.each([
      { name: "a payment error", failure: new PurchasesError(ErrorCode.NetworkError, "Network error") },
      { name: "an unexpected error", failure: new Error("Checkout failed to load") },
    ])("rethrows $name that is not a cancellation", async ({ failure }) => {
      const purchases = await configured();
      instance.getOfferings.mockResolvedValue({ current: { availablePackages: [monthly] }, all: {} });
      instance.purchase.mockRejectedValue(failure);

      await expect(purchases.purchase(options, monthlyPro)).rejects.toBe(failure);
    });
  });

  describe("logOut", () => {
    it("closes the signed-out account's SDK instance and configures afresh for the next account", async () => {
      const purchases = await configured();
      const signedOut = instance;

      await purchases.logOut();
      await purchases.ensureConfigured({ ...options, appUserId: "user_2" });

      expect(signedOut.close).toHaveBeenCalledTimes(1);
      expect(configure.mock.calls).toEqual([
        [{ apiKey: "rcb_key", appUserId: "user_1" }],
        [{ apiKey: "rcb_key", appUserId: "user_2" }],
      ]);
      expect(signedOut.changeUser).not.toHaveBeenCalled();
    });

    it("does nothing before billing was configured", async () => {
      await expect(new WebPurchases().logOut()).resolves.toBeUndefined();
      expect(configure).not.toHaveBeenCalled();
    });
  });
});
