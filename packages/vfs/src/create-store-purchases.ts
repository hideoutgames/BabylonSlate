import { CapacitorStorePurchases } from "./capacitor-store-purchases";
import { getHostPlatform } from "./platform";
import {
  UnavailableStorePurchases,
  type StorePurchasesPort,
} from "./store-purchases-port";

let shared: StorePurchasesPort | null = null;

/** The store purchases port for this host; shared so the SDK is configured once. */
export function createStorePurchases(): StorePurchasesPort {
  if (shared) return shared;
  const platform = getHostPlatform();
  shared =
    platform === "ios" || platform === "android"
      ? new CapacitorStorePurchases()
      : new UnavailableStorePurchases();
  return shared;
}
