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
  ANNUAL_PACKAGE,
  MONTHLY_PACKAGE,
  type EntitlementStatus,
  type PurchasesAccount,
  type SubscriptionPackageId,
  type SubscriptionPlan,
} from "@haptic/vfs";
import {
  unconfiguredBilling,
  type BillingButton,
  type BillingController,
} from "../components/homepage-account-types";

/** RevenueCat entitlement that unlocks Haptic Pro; defaults to "pro". */
const PRO_ENTITLEMENT =
  import.meta.env.VITE_REVENUECAT_PRO_ENTITLEMENT?.trim() || "pro";

/** How the Subscription page names each plan's period. */
const PLAN_PERIODS: Record<SubscriptionPackageId, string> = {
  [MONTHLY_PACKAGE]: "Monthly",
  [ANNUAL_PACKAGE]: "Annual",
};

/** Neither plan is in the current offering, so there is nothing to buy. */
const NO_PLANS = `The subscription packages "${MONTHLY_PACKAGE}" and "${ANNUAL_PACKAGE}" are not available right now.`;

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
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
  /** The offering's plans; null until they load (and while a failed load waits for a retry). */
  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null);
  const [chosen, setChosen] = useState<SubscriptionPackageId>(MONTHLY_PACKAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A slower lookup for a previous account must not land after a newer one.
  const latestRequest = useRef(0);
  const loading = useRef(false);
  const previousUser = useRef(appUserId);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    if (!account) {
      setEntitlement(null);
      setPlans(null);
      return;
    }
    loading.current = true;
    try {
      const purchases = createPurchases();
      const status = await purchases.status(account, PRO_ENTITLEMENT);
      const offered = await purchases.plans(account);
      if (request === latestRequest.current) {
        setEntitlement(status);
        setPlans(offered);
      }
    } catch (cause) {
      if (request === latestRequest.current) throw cause;
    } finally {
      if (request === latestRequest.current) loading.current = false;
    }
  }, [account]);

  const load = useCallback(() => {
    setError(null);
    refresh().catch((cause: unknown) => setError(message(cause, "Billing could not be loaded.")));
  }, [refresh]);

  useEffect(() => {
    setEntitlement(null);
    setPlans(null);
    setChosen(MONTHLY_PACKAGE);
    load();
  }, [load]);

  // Stable, so showing the page retries once instead of on every render.
  const failed = useRef(false);
  failed.current = error !== null || plans === null;
  const onShow = useCallback(() => {
    if (!loading.current && failed.current) load();
  }, [load]);

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
      .catch((cause: unknown) => setError(message(cause, "The purchase did not go through.")))
      .finally(() => setBusy(false));
  };
  const restore = purchases.restore?.bind(purchases);
  const manageUrl = managementPage(entitlement?.managementUrl);
  // Monthly unless the person chose otherwise or the offering lacks it.
  const selected = plans?.find((plan) => plan.packageId === chosen) ?? plans?.[0];
  const subscribed = entitlement?.active === true;
  return {
    // Subscribers do not see Subscribe, so an offering without plans is no error for them.
    unavailableReason: error ?? (!subscribed && plans?.length === 0 ? NO_PLANS : null),
    plans: plans?.map((plan) => ({
      id: plan.packageId,
      period: PLAN_PERIODS[plan.packageId],
      price: plan.priceString,
    })),
    selectedPlan: selected?.packageId,
    onSelectPlan: (id) => {
      if (id === MONTHLY_PACKAGE || id === ANNUAL_PACKAGE) setChosen(id);
    },
    // Showing the Subscription page retries a load that failed (offline at mount).
    onShow,
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
        () => {
          if (!selected) return;
          run(() =>
            purchases.purchase(account, {
              entitlementId: PRO_ENTITLEMENT,
              packageId: selected.packageId,
              email,
            }),
          );
        },
        busy || !selected,
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
