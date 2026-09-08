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
  it("uses the native email flow only inside Profile and restores it on the next visit", async () => {
    render(
      <>
        <button>Create Project</button>
        <HomepageAccount />
      </>,
    );
    expect(auth.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    const email = await screen.findByLabelText("Email Address");
    expect(auth.browserProvider).not.toHaveBeenCalled();
    expect(screen.queryByTestId("homepage-mobile-auth")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create Project", hidden: true }),
    ).toHaveProperty("disabled", false);
    fireEvent.change(email, { target: { value: "ada@example.test" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue With Email" }),
    );
    fireEvent.change(await screen.findByLabelText("Verification Code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify & Continue" }));
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    auth.restoreSession.mockResolvedValue(session);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.focus(window);
    expect(auth.restoreSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(auth.restoreSession).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Sign Out" }));
    expect(await screen.findByLabelText("Email Address")).toBeTruthy();
    expect(auth.signOut).toHaveBeenCalledWith(session);
  });

  it("keeps guests and subscription preview available when desktop authentication fails", async () => {
    auth.restoreSession.mockRejectedValue(
      new Error("Secure account storage is unavailable."),
    );
    render(
      <>
        <button>Create Project</button>
        <HomepageAccount />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Secure account storage is unavailable.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Manage Subscription" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Room to Create" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(
      await screen.findByRole("button", { name: "Create Project" }),
    ).toBeTruthy();
  });
});
