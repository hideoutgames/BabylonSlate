import {
  cloneElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createPurchases,
  getHostPlatform,
  type EntitlementStatus,
  type PurchasesAccount,
} from "@haptic/vfs";
import {
  unconfiguredBilling,
  type BillingButton,
  type BillingController,
} from "../components/homepage-account-types";

/** RevenueCat entitlement that unlocks Haptic Pro; defaults to "pro". */
const PRO_ENTITLEMENT =
  import.meta.env.VITE_REVENUECAT_PRO_ENTITLEMENT?.trim() || "pro";

/**
 * The RevenueCat package Subscribe buys: Haptic Pro is the only plan sold in
 * the app. Defaults to RevenueCat's monthly package; a missing package is an
 * error, never a silent fallback to another one.
 */
function proPackage(): string {
  return import.meta.env.VITE_REVENUECAT_PRO_PACKAGE?.trim() || "$rc_monthly";
}

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

/** Only an https management page is opened; anything else is ignored. */
function managementPage(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Unbinds the signed-out account from RevenueCat. Every sign-out path calls
 * this (directly or through the hook seeing the account go away); it never
 * rejects, so signing out cannot fail on billing.
 */
export function endSubscriptionBilling(): Promise<void> {
  if (!revenueCatApiKey()) return Promise.resolve();
  return createPurchases().logOut();
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
  const account = useMemo<PurchasesAccount | null>(
    () => (apiKey && appUserId ? { apiKey, appUserId } : null),
    [apiKey, appUserId],
  );
  const [entitlement, setEntitlement] = useState<EntitlementStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A slower lookup for a previous account must not land after a newer one.
  const latestRequest = useRef(0);
  const previousUser = useRef(appUserId);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    if (!account) {
      setEntitlement(null);
      return;
    }
    try {
      const status = await createPurchases().status(account, PRO_ENTITLEMENT);
      if (request === latestRequest.current) setEntitlement(status);
    } catch (cause) {
      if (request === latestRequest.current) throw cause;
    }
  }, [account]);

  useEffect(() => {
    setError(null);
    setEntitlement(null);
    refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Billing could not be loaded."),
    );
  }, [refresh]);

  // Signing out leaves RevenueCat bound to the previous customer until it logs out.
  useEffect(() => {
    const previous = previousUser.current;
    previousUser.current = appUserId;
    if (previous && !appUserId) void endSubscriptionBilling();
  }, [appUserId]);

  if (!apiKey) return unconfiguredBilling();
  // Purchases belong to an account, so guests and the demo session cannot buy or restore.
  if (!account) return { currentPlan: "free", unavailableReason: "Sign in to subscribe." };

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
  const manageUrl = managementPage(entitlement?.managementUrl);
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
      withClick(
        button,
        () =>
          run(() =>
            purchases.purchase(account, {
              entitlementId: PRO_ENTITLEMENT,
              packageId: proPackage(),
              email,
            }),
          ),
        busy,
      ),
    renderManage: (button) =>
      withClick(
        button,
        () => {
          // Electron hands this to the system browser through its allowlist.
          if (manageUrl) window.open(manageUrl, "_blank", "noopener,noreferrer");
        },
        busy || !manageUrl,
      ),
    onRestore: restore ? () => run(() => restore(account, PRO_ENTITLEMENT)) : undefined,
  };
}
