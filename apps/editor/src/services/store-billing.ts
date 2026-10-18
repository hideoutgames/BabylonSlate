import {
  cloneElement,
  useCallback,
  useEffect,
  useState,
  type MouseEvent,
  type ReactElement,
} from "react";
import {
  createStorePurchases,
  getHostPlatform,
  type StoreEntitlementStatus,
} from "@babylonslate/vfs";
import {
  unconfiguredBilling,
  type BillingController,
} from "../components/homepage-account-types";

/** RevenueCat entitlement that unlocks Haptic Pro; defaults to "pro". */
const PRO_ENTITLEMENT =
  import.meta.env.VITE_REVENUECAT_PRO_ENTITLEMENT?.trim() || "pro";

function storeApiKey(): string | undefined {
  const host = getHostPlatform();
  const key =
    host === "ios"
      ? import.meta.env.VITE_REVENUECAT_IOS_API_KEY
      : host === "android"
        ? import.meta.env.VITE_REVENUECAT_ANDROID_API_KEY
        : undefined;
  return key?.trim() || undefined;
}

function withClick(
  button: ReactElement<{ onClick?: (event: MouseEvent) => void; disabled?: boolean }>,
  onClick: () => void,
  disabled = false,
) {
  return cloneElement(button, {
    disabled: disabled || button.props.disabled,
    onClick: () => onClick(),
  });
}

/**
 * App Store and Google Play billing for the iOS and Android apps, through
 * RevenueCat. Purchases are tied to the signed-in account so one Haptic Pro
 * subscription covers every device.
 */
export function useStoreBilling(appUserId: string | undefined): BillingController {
  const apiKey = storeApiKey();
  const [entitlement, setEntitlement] = useState<StoreEntitlementStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!apiKey) return;
    const store = createStorePurchases();
    await store.configure({ apiKey, appUserId });
    setEntitlement(await store.status(PRO_ENTITLEMENT));
  }, [apiKey, appUserId]);

  useEffect(() => {
    refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Purchases could not be loaded."),
    );
  }, [refresh]);

  if (!apiKey) return unconfiguredBilling("revenuecat");

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void action()
      .then(refresh)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "The store request failed."),
      )
      .finally(() => setBusy(false));
  };
  const store = createStorePurchases();
  return {
    provider: "revenuecat",
    unavailableReason: error,
    currentPlan: entitlement?.active ? "pro" : "free",
    status: entitlement?.active
      ? entitlement.willRenew
        ? "Active"
        : "Ends at Period End"
      : undefined,
    renewsAt: entitlement?.expiresAt ? new Date(entitlement.expiresAt) : undefined,
    renderSubscribe: (button) =>
      withClick(button, () => run(() => store.purchase(PRO_ENTITLEMENT)), busy),
    renderManage: (button) =>
      withClick(
        button,
        () => {
          if (entitlement?.managementUrl) window.open(entitlement.managementUrl, "_blank");
        },
        busy || !entitlement?.managementUrl,
      ),
    onRestore: () => run(() => store.restore(PRO_ENTITLEMENT)),
  };
}
