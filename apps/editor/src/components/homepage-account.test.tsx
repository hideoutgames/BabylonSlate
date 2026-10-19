import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  openSignUp: vi.fn(),
  openUserProfile: vi.fn(),
  signOut: vi.fn(() => Promise.resolve()),
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
          id: "user_ada",
          fullName: "Ada Lovelace",
          primaryEmailAddress: { emailAddress: "ada@example.test" },
          hasImage: true,
          imageUrl: "https://img.example.test/ada.png",
          passwordEnabled: false,
          externalAccounts: [{ provider: "google" }],
          createdAt: new Date("2025-03-01T12:00:00Z"),
          lastSignInAt: new Date("2026-10-01T12:00:00Z"),
        }
      : null,
  }),
  useClerk: () => ({
    openSignIn: clerk.openSignIn,
    openSignUp: clerk.openSignUp,
    openUserProfile: clerk.openUserProfile,
    signOut: clerk.signOut,
  }),
}));

const purchases = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@babylonslate/vfs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/vfs")>();
  return {
    ...actual,
    createPurchases: () => {
      purchases.create();
      return actual.createPurchases();
    },
  };
});

// The Clerk account UI is lazy-loaded. Transform it once up front so a cold
// module graph cannot outlast the default findBy timeout under worker load.
beforeAll(async () => {
  await import("./homepage-account-clerk");
});

afterEach(() => {
  cleanup();
  clerk.provider.mockClear();
  clerk.openSignIn.mockClear();
  clerk.openSignUp.mockClear();
  clerk.openUserProfile.mockClear();
  clerk.signOut.mockClear();
  clerk.signedIn = false;
  clerk.failed = false;
  purchases.create.mockClear();
  vi.unstubAllEnvs();
});

/** Profile → Manage Account opens the Account dialog on one of its sections. */
async function openAccountSection(section: "Account" | "Subscription") {
  fireEvent.click(await screen.findByTestId("homepage-account"));
  fireEvent.click(await screen.findByRole("menuitem", { name: /Manage Account/ }));
  const dialog = await screen.findByRole("dialog", { name: "Account" });
  fireEvent.click(
    within(within(dialog).getByRole("navigation", { name: "Categories" })).getByRole(
      "button",
      { name: section },
    ),
  );
  return dialog;
}

describe("Homepage account", () => {
  it("keeps the plans available when configured authentication fails", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    clerk.failed = true;
    render(<HomepageAccount />);
    await screen.findByTestId("clerk-failed");
    const dialog = await openAccountSection("Subscription");
    expect(within(dialog).getByRole("heading", { name: "Haptic Pro", level: 4 })).toBeTruthy();
  });

  it("shows a guest the plans without purchases while billing is not configured", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    render(<HomepageAccount />);
    fireEvent.click(screen.getByRole("button", { name: "Guest, Not Signed In" }));
    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(clerk.provider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("homepage-account"));
    const dialog = await openAccountSection("Subscription");
    for (const plan of ["Haptic", "Haptic Pro", "Enterprise"]) {
      expect(within(dialog).getByRole("heading", { name: plan, level: 4 })).toBeTruthy();
    }
    expect(
      within(dialog).getByRole("button", { name: "Subscribe" }),
    ).toHaveProperty("disabled", true);
    expect(within(dialog).getByRole("alert").textContent).toMatch(/not set up/i);
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("asks guests to sign in before subscribing when billing is configured", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_REVENUECAT_WEB_API_KEY", "rcb_test_example");
    render(<HomepageAccount />);
    const dialog = await openAccountSection("Subscription");
    expect(within(dialog).getByRole("alert").textContent).toBe("Sign in to subscribe.");
    expect(
      within(dialog).getByRole("button", { name: "Subscribe" }),
    ).toHaveProperty("disabled", true);
    expect(within(dialog).queryByRole("button", { name: "Restore Purchases" })).toBeNull();
    expect(purchases.create).not.toHaveBeenCalled();
  });

  it("restores configured Clerk on mount and opens its sign-in flow from the menu", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    render(<HomepageAccount />);
    await waitFor(() => expect(clerk.provider).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("homepage-account"));
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

  it("drives signed-in Clerk accounts from the launcher profile menu", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    clerk.signedIn = true;
    const onEngineSettings = vi.fn();
    const onChangelog = vi.fn();
    const { unmount } = render(
      <HomepageAccount
        onEngineSettings={onEngineSettings}
        onChangelog={onChangelog}
      />,
    );
    const trigger = await screen.findByRole("button", {
      name: "Ada Lovelace, ada@example.test",
    });
    await waitFor(() =>
      expect(trigger.querySelector("img")?.getAttribute("src")).toBe(
        "https://img.example.test/ada.png",
      ),
    );
    expect(trigger.textContent).toContain("ada@example.test");
    const open = async () => {
      fireEvent.click(trigger);
      return screen.findByRole("menu");
    };
    let menu = await open();
    expect(within(menu).getByText("Ada Lovelace")).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Sign In" })).toBeNull();
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Engine Settings" }),
    );
    expect(onEngineSettings).toHaveBeenCalledOnce();

    menu = await open();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Changelog" }));
    expect(onChangelog).toHaveBeenCalledOnce();

    const dialog = await openAccountSection("Account");
    expect(within(dialog).getByText("ada@example.test", { selector: "dd" })).toBeTruthy();
    expect(within(dialog).getByText("Email, Google")).toBeTruthy();
    // Clerk's own account screen edits the profile and deletes the account.
    expect(within(dialog).queryByLabelText("First Name")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Delete Account" })).toBeNull();
    expect(
      within(dialog).getByText(/change your name, picture and connected accounts, or delete your account/i),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Manage Account" }),
    );
    expect(clerk.openUserProfile).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign Out" }));
    await waitFor(() => expect(clerk.signOut).toHaveBeenCalledOnce());
    unmount();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
