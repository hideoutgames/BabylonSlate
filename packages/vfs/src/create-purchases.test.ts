import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPlatform = vi.fn(() => "web");
const capacitorConfigure = vi.fn();
const webConfigure = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => getPlatform() },
}));
vi.mock("@revenuecat/purchases-capacitor", () => ({
  Purchases: { configure: capacitorConfigure },
}));
vi.mock("@revenuecat/purchases-js", () => ({
  Purchases: { configure: webConfigure },
}));

const options = { apiKey: "public_key", appUserId: "user_1" };

/** `createPurchases` shares one port per module instance, so each host loads a fresh copy. */
async function createPurchasesOn(platform: "ios" | "android" | "web") {
  getPlatform.mockReturnValue(platform);
  vi.resetModules();
  return (await import("./create-purchases")).createPurchases;
}

describe("createPurchases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capacitorConfigure.mockResolvedValue(undefined);
    webConfigure.mockReturnValue({});
    delete (globalThis as { babylonslate?: unknown }).babylonslate;
  });

  afterEach(() => {
    delete (globalThis as { babylonslate?: unknown }).babylonslate;
  });

  it.each([
    { platform: "ios", store: "app-store" },
    { platform: "android", store: "play-store" },
  ] as const)("uses the $store through the RevenueCat Capacitor plugin on $platform and offers restore", async ({ platform, store }) => {
    const purchases = (await createPurchasesOn(platform))();

    expect(purchases.store).toBe(store);
    expect(purchases.restore).toBeTypeOf("function");
    await purchases.configure(options);
    expect(capacitorConfigure.mock.calls).toEqual([[{ apiKey: "public_key", appUserID: "user_1" }]]);
    expect(webConfigure).not.toHaveBeenCalled();
  });

  it("uses Web Billing without restore in the browser", async () => {
    const purchases = (await createPurchasesOn("web"))();

    expect(purchases.store).toBe("web");
    expect(purchases.restore).toBeUndefined();
    await purchases.configure(options);
    expect(webConfigure.mock.calls).toEqual([[{ apiKey: "public_key", appUserId: "user_1" }]]);
    expect(capacitorConfigure).not.toHaveBeenCalled();
  });

  it("uses Web Billing in the desktop app, which reports as web to Capacitor", async () => {
    (globalThis as { babylonslate?: unknown }).babylonslate = { userData: {} };
    const purchases = (await createPurchasesOn("web"))();

    expect(purchases.store).toBe("web");
    expect(purchases.restore).toBeUndefined();
    await purchases.configure(options);
    expect(webConfigure).toHaveBeenCalledTimes(1);
    expect(capacitorConfigure).not.toHaveBeenCalled();
  });

  it("shares one port so the SDK is configured once however often callers ask for it", async () => {
    const createPurchases = await createPurchasesOn("ios");

    await createPurchases().configure(options);
    await createPurchases().configure(options);

    expect(createPurchases()).toBe(createPurchases());
    expect(capacitorConfigure).toHaveBeenCalledTimes(1);
  });
});
