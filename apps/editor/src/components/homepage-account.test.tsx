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
  signedIn: false,
  failed: false,
}));

vi.mock("@clerk/react", () => ({
  ClerkProvider: (props: { children: ReactNode }) => {
    clerk.provider(props);
    return props.children;
  },
  ClerkFailed: ({ children }: { children: ReactNode }) =>
    clerk.failed ? children : null,
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
  SignIn: ({ routing }: { routing: string }) => (
    <div data-testid="clerk-sign-in" data-routing={routing}>
      Clerk Sign In
    </div>
  ),
  UserProfile: ({ routing }: { routing: string }) => (
    <div data-testid="clerk-user-profile" data-routing={routing}>
      Clerk Account Settings
    </div>
  ),
  SignOutButton: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  cleanup();
  clerk.provider.mockClear();
  clerk.signedIn = false;
  clerk.failed = false;
  vi.unstubAllEnvs();
});

describe("Homepage account", () => {
  it("keeps profile and subscription navigation usable when configured authentication fails", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    clerk.failed = true;
    render(<HomepageAccount />);
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByText(/sign-in is unavailable/i)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Manage Subscription" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Room to Create" }),
    ).toBeTruthy();
  });

  it("keeps the guest profile usable without Clerk configuration or a purchase flow", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    render(<HomepageAccount />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByRole("dialog", { name: "Profile" })).toBeTruthy();
    expect(clerk.provider).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Manage Subscription" }),
    );
    const preview = await screen.findByRole("dialog", {
      name: "Room to Create",
    });
    expect(within(preview).getByRole("heading", { name: "Free" })).toBeTruthy();
    expect(within(preview).getByRole("heading", { name: "Pro" })).toBeTruthy();
    expect(within(preview).getAllByText("Full Editor Access")).toHaveLength(2);
    expect(within(preview).getByText("Mobile App Access")).toBeTruthy();
    expect(within(preview).getByText(/preview only/i)).toBeTruthy();
    expect(
      within(preview).queryByRole("button", {
        name: /buy|purchase|subscribe|upgrade/i,
      }),
    ).toBeNull();
    fireEvent.click(
      within(preview).getByRole("button", { name: "Back To Profile" }),
    );
    expect(await screen.findByRole("dialog", { name: "Profile" })).toBeTruthy();
  });

  it("loads configured authentication only after opening Profile and keeps sign-in in the dialog", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    render(<HomepageAccount />);
    expect(clerk.provider).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign In" }));
    expect(await screen.findByTestId("clerk-sign-in")).toHaveProperty(
      "dataset.routing",
      "hash",
    );
    expect(clerk.provider).toHaveBeenCalledWith(
      expect.objectContaining({
        publishableKey: "pk_test_example",
        polling: false,
        telemetry: false,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back To Profile" }));
    expect(screen.queryByTestId("clerk-sign-in")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Manage Subscription" }),
    ).toBeTruthy();
  });

  it("shows the signed-in identity and opens account settings without leaving the project browser", async () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    clerk.signedIn = true;
    const { unmount } = render(<HomepageAccount />);
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("ada@example.test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Account Settings" }));
    expect(await screen.findByTestId("clerk-user-profile")).toHaveProperty(
      "dataset.routing",
      "hash",
    );
    unmount();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
