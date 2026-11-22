import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { INACTIVE_ENTITLEMENT, type EntitlementStatus } from "@haptic/vfs";
import { HomepageAccountCenter } from "../components/homepage-account-center";
import { useSubscriptionBilling } from "./subscription-billing";

/** The RevenueCat port is the external boundary; its adapters have their own tests. */
const port = vi.hoisted(() => ({
  store: "web" as const,
  ensureConfigured: vi.fn(),
  status: vi.fn(),
  plans: vi.fn(),
  purchase: vi.fn(),
  logOut: vi.fn(),
}));

const monthlyPlan = { packageId: "$rc_monthly", priceString: "9,99 €", billingPeriod: "P1M" };
const annualPlan = { packageId: "$rc_annual", priceString: "99,99 €", billingPeriod: "P1Y" };

/** The real hook behind the real Account dialog of a signed-in account. */
function SubscriptionPage() {
  const billing = useSubscriptionBilling("user_ada", "ada@example.test");
  return (
    <HomepageAccountCenter
      open
      onOpenChange={() => {}}
      account={{ name: "Ada Lovelace", status: "Signed In", email: "ada@example.test" }}
      billing={billing}
      busy={false}
      onSignOut={() => {}}
    />
  );
}

async function showSubscription(view: RenderResult) {
  const dialog = await view.findByRole("dialog", { name: "Account" });
  fireEvent.click(
    within(within(dialog).getByRole("navigation", { name: "Categories" })).getByRole("button", {
      name: "Subscription",
    }),
  );
  return dialog;
}

async function openSubscription() {
  return showSubscription(render(<SubscriptionPage />));
}

vi.mock("@haptic/vfs", async (original) => ({
  ...(await original<typeof import("@haptic/vfs")>()),
  createPurchases: () => port,
}));

const account = { apiKey: "rcb_key", appUserId: "user_ada" };

function entitlement(overrides: Partial<EntitlementStatus> = {}): EntitlementStatus {
  return { ...INACTIVE_ENTITLEMENT, active: true, willRenew: true, ...overrides };
}

/** Renders the billing button the Account dialog wraps, so clicks go through the real wrapper. */
function BillingButtons({ appUserId }: { appUserId?: string }) {
  const billing = useSubscriptionBilling(appUserId, "ada@example.test");
  return (
    <>
      {billing.renderSubscribe?.(<button type="button">Subscribe</button>)}
      {billing.renderManage?.(<button type="button">Manage Billing</button>)}
      {billing.unavailableReason && <p role="alert">{billing.unavailableReason}</p>}
    </>
  );
}

beforeEach(() => {
  vi.stubEnv("VITE_REVENUECAT_WEB_API_KEY", "rcb_key");
  port.status.mockResolvedValue(INACTIVE_ENTITLEMENT);
  port.plans.mockResolvedValue([monthlyPlan, annualPlan]);
  port.logOut.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("useSubscriptionBilling", () => {
  it("offers Monthly by default with the store's prices and buys the plan the person picks", async () => {
    port.purchase.mockResolvedValue(true);
    const dialog = await openSubscription();
    const choice = await within(dialog).findByRole("group", { name: "Billing Period" });
    const monthly = within(choice).getByRole("button", { name: "Monthly, 9,99 €" });
    const annual = within(choice).getByRole("button", { name: "Annual, 99,99 €" });
    expect(monthly.getAttribute("aria-pressed")).toBe("true");
    expect(annual.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(within(dialog).getByRole("button", { name: "Subscribe" }));
    await waitFor(() => expect(port.purchase).toHaveBeenCalledTimes(1));
    expect(port.purchase.mock.calls[0]).toEqual([
      account,
      { entitlementId: "pro", packageId: "$rc_monthly", email: "ada@example.test" },
    ]);

    fireEvent.click(annual);
    expect(annual.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Subscribe" })).toHaveProperty("disabled", false));
    fireEvent.click(within(dialog).getByRole("button", { name: "Subscribe" }));
    await waitFor(() => expect(port.purchase).toHaveBeenCalledTimes(2));
    expect(port.purchase.mock.calls[1]?.[1]).toMatchObject({ packageId: "$rc_annual" });
  });

  it("shows a single plan as text without a choice and buys it", async () => {
    port.plans.mockResolvedValue([annualPlan]);
    port.purchase.mockResolvedValue(true);
    const dialog = await openSubscription();

    expect((await within(dialog).findByTestId("billing-plan")).textContent).toBe("Annual99,99 €");
    expect(within(dialog).queryByRole("group", { name: "Billing Period" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Subscribe" }));
    await waitFor(() => expect(port.purchase.mock.calls[0]?.[1]).toMatchObject({ packageId: "$rc_annual" }));
  });

  it("names both packages and keeps Subscribe disabled when the offering has neither", async () => {
    port.plans.mockResolvedValue([]);
    const dialog = await openSubscription();

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      'The subscription packages "$rc_monthly" and "$rc_annual" are not available right now.',
    );
    expect(within(dialog).getByRole("button", { name: "Subscribe" })).toHaveProperty("disabled", true);
    expect(within(dialog).queryByRole("group", { name: "Billing Period" })).toBeNull();
  });

  it("shows a subscriber no plan choice or Subscribe, and no error for an offering without plans", async () => {
    port.status.mockResolvedValue(entitlement({ managementUrl: "https://pay.rev.cat/manage/abc" }));
    port.plans.mockResolvedValue([]);
    const dialog = await openSubscription();

    await within(dialog).findByText("Active");
    expect(within(dialog).queryByRole("button", { name: "Subscribe" })).toBeNull();
    expect(within(dialog).queryByRole("group", { name: "Billing Period" })).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Manage Billing" })).toHaveProperty("disabled", false);
  });

  it("loads the plans again when the Subscription page shows after an offline launch", async () => {
    port.status.mockRejectedValueOnce(new Error("Network error"));
    const view = render(<SubscriptionPage />);
    await waitFor(() => expect(port.status).toHaveBeenCalledTimes(1));
    expect(port.plans).not.toHaveBeenCalled();

    const dialog = await showSubscription(view);

    expect(await within(dialog).findByRole("group", { name: "Billing Period" })).toBeTruthy();
    expect(port.status).toHaveBeenCalledTimes(2);
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("logs RevenueCat out and forgets the entitlement when the account signs out", async () => {
    port.status.mockResolvedValue(entitlement());
    const { result, rerender } = renderHook(({ user }) => useSubscriptionBilling(user), {
      initialProps: { user: "user_ada" as string | undefined },
    });
    await waitFor(() => expect(result.current.currentPlan).toBe("pro"));
    expect(port.logOut).not.toHaveBeenCalled();

    rerender({ user: undefined });

    await waitFor(() => expect(port.logOut).toHaveBeenCalledTimes(1));
    expect(result.current.currentPlan).toBe("free");
    expect(result.current.unavailableReason).toBe("Sign in to subscribe.");
  });

  it("does not log out on first render as a guest or when switching between accounts", async () => {
    const { rerender } = renderHook(({ user }) => useSubscriptionBilling(user), {
      initialProps: { user: undefined as string | undefined },
    });
    rerender({ user: "user_ada" });
    rerender({ user: "user_bob" });
    await waitFor(() => expect(port.status).toHaveBeenLastCalledWith({ ...account, appUserId: "user_bob" }, "pro"));

    expect(port.logOut).not.toHaveBeenCalled();
  });

  it.each([
    { name: "an https page", url: "https://pay.rev.cat/manage/abc", opened: true },
    { name: "an http page", url: "http://pay.rev.cat/manage/abc", opened: false },
    { name: "a script URL", url: "javascript:alert(1)", opened: false },
    { name: "a malformed URL", url: "not a url", opened: false },
  ])("opens the management page only when it is $name", async ({ url, opened }) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    port.status.mockResolvedValue(entitlement({ managementUrl: url }));
    render(<BillingButtons appUserId="user_ada" />);
    await waitFor(() => expect(port.status).toHaveBeenCalled());
    await act(async () => {});
    const manage = screen.getByRole("button", { name: "Manage Billing" }) as HTMLButtonElement;

    expect(manage.disabled).toBe(!opened);
    fireEvent.click(manage);

    expect(open.mock.calls).toEqual(opened ? [[url, "_blank", "noopener,noreferrer"]] : []);
    open.mockRestore();
  });
});
