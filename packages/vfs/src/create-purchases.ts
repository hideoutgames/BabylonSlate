import { CapacitorPurchases } from "./capacitor-purchases";
import { getHostPlatform } from "./platform";
import type { PurchasesPort } from "./purchases-port";
import { WebPurchases } from "./web-purchases";

let shared: PurchasesPort | null = null;

/** The RevenueCat purchases port for this host; shared so it is configured once. */
export function createPurchases(): PurchasesPort {
  if (shared) return shared;
  const platform = getHostPlatform();
  shared =
    platform === "ios"
      ? new CapacitorPurchases("app-store")
      : platform === "android"
        ? new CapacitorPurchases("play-store")
        : new WebPurchases();
  return shared;
}
