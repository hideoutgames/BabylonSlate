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
  };
}

let instance: ReturnType<typeof sdkInstance>;

const monthly = { identifier: "$rc_monthly" };
const annual = { identifier: "$rc_annual" };
const options = { apiKey: "rcb_key", appUserId: "user_1" };

async function configured() {
  const purchases = new WebPurchases();
  await purchases.configure(options);
  return purchases;
}

describe("Web purchases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    configure.mockImplementation(({ appUserId }: { appUserId: string }) => (instance = sdkInstance(appUserId)));
  });

  describe("configure", () => {
    it("configures RevenueCat Web Billing with the API key and the account's app user id", async () => {
      await new WebPurchases().configure(options);

      expect(configure.mock.calls).toEqual([[{ apiKey: "rcb_key", appUserId: "user_1" }]]);
      expect(instance.changeUser).not.toHaveBeenCalled();
    });

    it("configures the SDK once for repeated and concurrent calls for the same account", async () => {
      const purchases = new WebPurchases();

      await Promise.all([purchases.configure(options), purchases.configure(options)]);
      await purchases.configure(options);

      expect(configure).toHaveBeenCalledTimes(1);
      expect(instance.changeUser).not.toHaveBeenCalled();
    });

    it("switches the customer when another account signs in, once per change", async () => {
      const purchases = new WebPurchases();

      await purchases.configure(options);
      await purchases.configure({ ...options, appUserId: "user_2" });
      await purchases.configure({ ...options, appUserId: "user_2" });

      expect(configure).toHaveBeenCalledTimes(1);
      expect(instance.changeUser.mock.calls).toEqual([["user_2"]]);
    });

    it("switches the customer when another account signs in during the first configure", async () => {
      const purchases = new WebPurchases();

      await Promise.all([purchases.configure(options), purchases.configure({ ...options, appUserId: "user_2" })]);

      expect(configure.mock.calls).toEqual([[{ apiKey: "rcb_key", appUserId: "user_1" }]]);
      expect(instance.changeUser.mock.calls).toEqual([["user_2"]]);
    });

    it("leaves billing unconfigured after a failed configure and configures again on the next attempt", async () => {
      configure.mockImplementationOnce(() => {
        throw new Error("Invalid API key");
      });
      const purchases = new WebPurchases();

      await expect(purchases.configure(options)).rejects.toThrow("Invalid API key");
      await expect(purchases.status("pro")).rejects.toThrow("Billing is not configured.");
      await purchases.configure(options);

      expect(configure).toHaveBeenCalledTimes(2);
      instance.getCustomerInfo.mockResolvedValue(customerInfo({ active: { pro: entitlement("pro") } }));
      expect((await purchases.status("pro")).active).toBe(true);
    });

    it("refuses to read the status or buy before billing is configured", async () => {
      const purchases = new WebPurchases();

      await expect(purchases.status("pro")).rejects.toThrow("Billing is not configured.");
      await expect(purchases.purchase("pro")).rejects.toThrow("Billing is not configured.");
      expect(configure).not.toHaveBeenCalled();
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

      expect(await purchases.status(entitlementId)).toEqual(expected);
    });

    it("surfaces a failure to load the customer", async () => {
      const purchases = await configured();
      instance.getCustomerInfo.mockRejectedValue(new Error("offline"));

      await expect(purchases.status("pro")).rejects.toThrow("offline");
    });
  });

  describe("purchase", () => {
    it.each([
      { name: "no current offering", offerings: { current: null, all: {} } },
      { name: "an offering without packages", offerings: { current: { availablePackages: [] }, all: {} } },
    ])("refuses to buy when there is $name", async ({ offerings }) => {
      const purchases = await configured();
      instance.getOfferings.mockResolvedValue(offerings);

      await expect(purchases.purchase("pro")).rejects.toThrow("No subscription is available to buy right now.");
      expect(instance.purchase).not.toHaveBeenCalled();
    });

    it("buys the first package of the current offering for the account's email and reports the entitlement as granted", async () => {
      const purchases = await configured();
      instance.getOfferings.mockResolvedValue({ current: { availablePackages: [monthly, annual] }, all: {} });
      instance.purchase.mockResolvedValue({ customerInfo: customerInfo({ active: { pro: entitlement("pro") } }) });

      expect(await purchases.purchase("pro", { email: "person@example.com" })).toBe(true);
      expect(instance.purchase.mock.calls).toEqual([[{ rcPackage: monthly, customerEmail: "person@example.com" }]]);
    });

    it("sends no customer email when the account has none, so the checkout asks for it", async () => {
      const purchases = await configured();
      instance.getOfferings.mockResolvedValue({ current: { availablePackages: [monthly] }, all: {} });
      instance.purchase.mockResolvedValue({ customerInfo: customerInfo({ active: { pro: entitlement("pro") } }) });

      expect(await purchases.purchase("pro")).toBe(true);
      expect(instance.purchase.mock.calls).toEqual([[{ rcPackage: monthly }]]);
    });

    it("resolves false when the user closes the checkout", async () => {
      const purchases = await configured();
      instance.getOfferings.mockResolvedValue({ current: { availablePackages: [monthly] }, all: {} });
      instance.purchase.mockRejectedValue(new PurchasesError(ErrorCode.UserCancelledError, "Purchase cancelled"));

      expect(await purchases.purchase("pro")).toBe(false);
    });

    it.each([
      { name: "a payment error", failure: new PurchasesError(ErrorCode.NetworkError, "Network error") },
      { name: "an unexpected error", failure: new Error("Checkout failed to load") },
    ])("rethrows $name that is not a cancellation", async ({ failure }) => {
      const purchases = await configured();
      instance.getOfferings.mockResolvedValue({ current: { availablePackages: [monthly] }, all: {} });
      instance.purchase.mockRejectedValue(failure);

      await expect(purchases.purchase("pro")).rejects.toBe(failure);
    });
  });
});
