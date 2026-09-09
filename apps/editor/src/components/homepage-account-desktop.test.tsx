import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { HomepageAccount } from "./homepage-account";

const auth = vi.hoisted(() => ({
  create: vi.fn(),
  restoreSession: vi.fn(),
  beginEmail: vi.fn(),
  verifyCode: vi.fn(),
  resendCode: vi.fn(),
  signOut: vi.fn(),
  browserProvider: vi.fn(),
}));
const session = {
  id: "session_ada",
  userId: "user_ada",
  email: "ada@example.test",
  name: "Ada Lovelace",
};
const challenge = {
  id: "sign_in_ada",
  kind: "sign-in",
  email: "ada@example.test",
};

vi.mock("@babylonslate/vfs", async (original) => ({
  ...(await original<typeof import("@babylonslate/vfs")>()),
  getHostPlatform: () => "electron",
}));
vi.mock("../services/native-clerk", () => ({
  createNativeClerkClient: (...args: unknown[]) => {
    auth.create(...args);
    return auth;
  },
}));
vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => {
    auth.browserProvider();
    return children;
  },
  ClerkLoaded: ({ children }: { children: ReactNode }) => children,
  ClerkFailed: () => null,
  ClerkLoading: () => null,
  useUser: () => ({ isLoaded: true, isSignedIn: false }),
  SignIn: () => null,
  UserProfile: () => null,
  SignOutButton: () => null,
}));

beforeEach(() => {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
  auth.restoreSession.mockResolvedValue(null);
  auth.beginEmail.mockResolvedValue(challenge);
  auth.verifyCode.mockResolvedValue(session);
  auth.signOut.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("optional desktop account", () => {
  it("signs in through the native flow and exposes the restored identity in its menu", async () => {
    render(
      <>
        <button>Create Project</button>
        <HomepageAccount />
      </>,
    );
    await waitFor(() => expect(auth.restoreSession).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign In" }));
    const email = await screen.findByLabelText("Email Address");
    expect(auth.browserProvider).not.toHaveBeenCalled();
    fireEvent.change(email, { target: { value: "ada@example.test" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue With Email" }),
    );
    fireEvent.change(await screen.findByLabelText("Verification Code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify & Continue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign Out" }));
    await waitFor(() => expect(auth.signOut).toHaveBeenCalledWith(session));
    expect(screen.getByRole("button", { name: "Create Project" })).toBeTruthy();
  });

  it("keeps guests and subscription preview available when restoration fails", async () => {
    auth.restoreSession.mockRejectedValue(
      new Error("Secure account storage is unavailable."),
    );
    render(
      <>
        <button>Create Project</button>
        <HomepageAccount />
      </>,
    );
    await waitFor(() => expect(auth.restoreSession).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Manage Subscription" }),
    );
    expect(await screen.findByRole("dialog", { name: "Plans" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(
      await screen.findByRole("button", { name: "Create Project" }),
    ).toBeTruthy();
  });
});
