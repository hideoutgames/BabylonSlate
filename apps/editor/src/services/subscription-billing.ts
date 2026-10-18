import {
  cloneElement,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  createPurchases,
  getHostPlatform,
  type EntitlementStatus,
} from "@babylonslate/vfs";
import {
  unconfiguredBilling,
  type BillingButton,
  type BillingController,
} from "../components/homepage-account-types";

/** RevenueCat entitlement that unlocks Haptic Pro; defaults to "pro". */
const PRO_ENTITLEMENT =
  import.meta.env.VITE_REVENUECAT_PRO_ENTITLEMENT?.trim() || "pro";

/** The RevenueCat public key for this host's store. */
function revenueCatApiKey(): string | undefined {
  const host = getHostPlatform();
  const key =
    host === "ios"
      ? import.meta.env.VITE_REVENUECAT_IOS_API_KEY
      : host === "android"
        ? import.meta.env.VITE_REVENUECAT_ANDROID_API_KEY
        : import.meta.env.VITE_REVENUECAT_WEB_API_KEY;
  return key?.trim() || undefined;
}

function withClick(
  button: BillingButton,
  onClick: () => void,
  disabled = false,
) {
  return cloneElement(button, {
    disabled: disabled || button.props.disabled,
    onClick: () => onClick(),
  });
}

/**
 * Haptic Pro billing on every host through RevenueCat: the App Store and
 * Google Play in the mobile apps, Web Billing on web and desktop. Purchases
 * belong to the signed-in account, so one subscription covers every device.
 */
export function useSubscriptionBilling(
  appUserId: string | undefined,
  email?: string,
): BillingController {
  const apiKey = revenueCatApiKey();
  const [entitlement, setEntitlement] = useState<EntitlementStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!apiKey || !appUserId) {
      setEntitlement(null);
      return;
    }
    const purchases = createPurchases();
    await purchases.configure({ apiKey, appUserId });
    setEntitlement(await purchases.status(PRO_ENTITLEMENT));
  }, [apiKey, appUserId]);

  useEffect(() => {
    setError(null);
    refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Billing could not be loaded."),
    );
  }, [refresh]);

  if (!apiKey) return unconfiguredBilling();

  const purchases = createPurchases();
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void action()
      .then(refresh)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "The purchase did not go through."),
      )
      .finally(() => setBusy(false));
  };
  const restore = purchases.restore?.bind(purchases);
  return {
    unavailableReason: error,
    currentPlan: entitlement?.active ? "pro" : "free",
    status: entitlement?.active
      ? entitlement.willRenew
        ? "Active"
        : "Ends at Period End"
      : undefined,
    renewsAt: entitlement?.expiresAt ? new Date(entitlement.expiresAt) : undefined,
    renderSubscribe: (button) =>
      withClick(button, () => run(() => purchases.purchase(PRO_ENTITLEMENT, { email })), busy),
    renderManage: (button) =>
      withClick(
        button,
        () => {
          if (entitlement?.managementUrl) window.open(entitlement.managementUrl, "_blank");
        },
        busy || !entitlement?.managementUrl,
      ),
    onRestore: restore ? () => run(() => restore(PRO_ENTITLEMENT)) : undefined,
  };
}
