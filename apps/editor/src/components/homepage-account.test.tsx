import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HomepageAccount } from "./homepage-account";

const clerk = vi.hoisted(() => ({
  provider: vi.fn(),
  openSignIn: vi.fn(),
  signedIn: false,
  failed: false,
}));

vi.mock("@clerk/react", () => ({
  ClerkProvider: (props: { children: ReactNode }) => {
    clerk.provider(props);
    return props.children;
  },
  ClerkFailed: ({ children }: { children: ReactNode }) =>
    clerk.failed ? <div data-testid="clerk-failed">{children}</div> : null,
  ClerkLoaded: ({ children }: { children: ReactNode }) =>
    clerk.failed ? null : children,
  ClerkLoading: () => null,
  useUser: () => ({
    isLoaded: true,
    isSignedIn: clerk.signedIn,
    user: clerk.signedIn
      ? {
          fullName: "Ada Lovelace",
          primaryEmailAddress: { emailAddress: "ada@example.test" },
        }
      : null,
  }),
  useClerk: () => ({ openSignIn: clerk.openSignIn }),
  UserButton: Object.assign(
    ({ children }: { children: ReactNode }) => (
      <div data-testid="clerk-user-button">{children}</div>
    ),
    {
      MenuItems: ({ children }: { children: ReactNode }) => children,
      Action: ({ label, onClick }: { label: string; onClick?: () => void }) => (
        <button onClick={onClick}>{label}</button>
      ),
    },
  ),
}));

afterEach(() => {
  cleanup();
  clerk.provider.mockClear();
  clerk.openSignIn.mockClear();
  clerk.signedIn = false;
  clerk.failed = false;
  vi.unstubAllEnvs();
});

describe("Homepage account", () => {
  it("keeps the subscription preview available when configured authentication fails", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    clerk.failed = true;
    render(<HomepageAccount />);
    await screen.findByTestId("clerk-failed");
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Manage Subscription" }),
    );
    expect(await screen.findByRole("dialog", { name: "Plans" })).toBeTruthy();
  });

  it("opens a guest menu and previews both plans without purchase actions", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    render(<HomepageAccount />);
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(clerk.provider).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Manage Subscription" }),
    );
    const preview = await screen.findByRole("dialog", { name: "Plans" });
    expect(within(preview).getByRole("heading", { name: "Free" })).toBeTruthy();
    expect(within(preview).getByRole("heading", { name: "Pro" })).toBeTruthy();
    expect(within(preview).getAllByText("Full Editor Access")).toHaveLength(2);
    expect(within(preview).getByText("Mobile App Access")).toBeTruthy();
    expect(
      within(preview).queryByRole("button", {
        name: /buy|purchase|subscribe|upgrade/i,
      }),
    ).toBeNull();
    fireEvent.click(within(preview).getByRole("button", { name: "Profile" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("restores configured Clerk on mount and opens its sign-in flow from the menu", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    render(<HomepageAccount />);
    await waitFor(() => expect(clerk.provider).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign In" }));
    expect(clerk.openSignIn).toHaveBeenCalledOnce();
    expect(clerk.provider).toHaveBeenCalledWith(
      expect.objectContaining({
        publishableKey: "pk_test_example",
        polling: false,
        telemetry: false,
      }),
    );
  });

  it("uses Clerk account controls with a subscription action for signed-in users", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    clerk.signedIn = true;
    const { unmount } = render(<HomepageAccount />);
    const controls = await screen.findByTestId("clerk-user-button");
    expect(
      within(controls).getByRole("button", { name: "manageAccount" }),
    ).toBeTruthy();
    expect(
      within(controls).getByRole("button", { name: "signOut" }),
    ).toBeTruthy();
    fireEvent.click(
      within(controls).getByRole("button", { name: "Manage Subscription" }),
    );
    expect(await screen.findByRole("dialog", { name: "Plans" })).toBeTruthy();
    unmount();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
