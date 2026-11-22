import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { INACTIVE_ENTITLEMENT, type EntitlementStatus } from "@haptic/vfs";
import { useSubscriptionBilling } from "./subscription-billing";

/** The RevenueCat port is the external boundary; its adapters have their own tests. */
const port = vi.hoisted(() => ({
  store: "web" as const,
  ensureConfigured: vi.fn(),
  status: vi.fn(),
  purchase: vi.fn(),
  logOut: vi.fn(),
}));

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
  port.logOut.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("useSubscriptionBilling", () => {
  it("buys Haptic Pro's monthly package by its identifier for the signed-in account", async () => {
    port.purchase.mockResolvedValue(true);
    render(<BillingButtons appUserId="user_ada" />);
    await waitFor(() => expect(port.status).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    await waitFor(() =>
      expect(port.purchase).toHaveBeenCalledWith(account, {
        entitlementId: "pro",
        packageId: "$rc_monthly",
        email: "ada@example.test",
      }),
    );
  });

  it("buys the package the build names and shows the error when the offering lacks it", async () => {
    vi.stubEnv("VITE_REVENUECAT_PRO_PACKAGE", "$rc_annual");
    port.purchase.mockRejectedValue(new Error('The subscription package "$rc_annual" is not available right now.'));
    render(<BillingButtons appUserId="user_ada" />);
    await waitFor(() => expect(port.status).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      'The subscription package "$rc_annual" is not available right now.',
    );
    expect(port.purchase.mock.calls[0]?.[1]).toMatchObject({ packageId: "$rc_annual" });
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
