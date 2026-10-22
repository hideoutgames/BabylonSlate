import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HomepageAccount } from "./homepage-account";

const auth = vi.hoisted(() => ({
  create: vi.fn(),
  restoreSession: vi.fn(),
  beginEmail: vi.fn(),
  verifyCode: vi.fn(),
  resendCode: vi.fn(),
  signOut: vi.fn(),
  updateName: vi.fn(),
  setProfileImage: vi.fn(),
  removeProfileImage: vi.fn(),
  beginReverification: vi.fn(),
  resendReverificationCode: vi.fn(),
  completeReverification: vi.fn(),
  deleteAccount: vi.fn(),
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
const reverification = {
  sessionId: "session_ada",
  emailAddressId: "email_ada",
  email: "ada@example.test",
};
const editable = {
  ...session,
  firstName: "Ada",
  lastName: "Lovelace",
  deleteSelfEnabled: true,
};

vi.mock("@haptic/vfs", async (original) => ({
  ...(await original<typeof import("@haptic/vfs")>()),
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

// The desktop account UI is lazy-loaded. Transform it once up front so a cold
// module graph cannot outlast the default findBy timeout under worker load.
beforeAll(async () => {
  await import("./homepage-account-desktop");
});

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
    fireEvent.click(screen.getByTestId("homepage-account"));
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
    fireEvent.click(
      screen.getByRole("button", { name: "Ada Lovelace, ada@example.test" }),
    );
    expect(within(await screen.findByRole("menu")).getByText("Ada Lovelace")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign Out" }));
    await waitFor(() => expect(auth.signOut).toHaveBeenCalledWith(session));
    expect(screen.getByRole("button", { name: "Create Project" })).toBeTruthy();
  });

  it("keeps guests and the plans available when restoration fails", async () => {
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
    fireEvent.click(screen.getByTestId("homepage-account"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Manage Account/ }));
    const dialog = await screen.findByRole("dialog", { name: "Account" });
    fireEvent.click(
      within(within(dialog).getByRole("navigation", { name: "Categories" })).getByRole(
        "button",
        { name: "Subscription" },
      ),
    );
    expect(within(dialog).getByRole("heading", { name: "Haptic Pro", level: 4 })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(
      await screen.findByRole("button", { name: "Create Project" }),
    ).toBeTruthy();
  });
});

describe("desktop account profile", () => {
  /** Profile → Manage Account for a restored session, on the Account section. */
  async function openAccount() {
    fireEvent.click(await screen.findByRole("button", { name: /ada@example.test/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Manage Account/ }));
    return screen.findByRole("dialog", { name: "Account" });
  }
  const launcher = () => screen.getByTestId("homepage-account");

  it("edits the name and picture in the dialog and shows them where the launcher shows the account", async () => {
    const renamed = { ...editable, name: "Ada King", lastName: "King" };
    const pictured = { ...renamed, imageUrl: "https://img.example.test/ada.png" };
    auth.restoreSession.mockResolvedValue(editable);
    auth.updateName.mockResolvedValue(renamed);
    auth.setProfileImage.mockResolvedValue(pictured);
    auth.removeProfileImage.mockResolvedValue(renamed);
    render(<HomepageAccount />);
    const dialog = await openAccount();
    expect((within(dialog).getByLabelText("First Name") as HTMLInputElement).value).toBe("Ada");
    const save = within(dialog).getByRole("button", { name: "Save Name" });
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(within(dialog).getByLabelText("Last Name"), { target: { value: " King " } });
    fireEvent.click(save);
    await waitFor(() => expect(launcher().getAttribute("aria-label")).toBe("Ada King, ada@example.test"));
    expect(auth.updateName).toHaveBeenCalledWith(editable, { firstName: "Ada", lastName: " King " });
    expect(within(dialog).getByRole("heading", { name: "Ada King" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Save Name" })).toHaveProperty("disabled", true);
    expect(within(dialog).queryByRole("button", { name: "Remove Picture" })).toBeNull();

    const picture = new File([Uint8Array.of(1, 2, 3)], "me.png", { type: "image/png" });
    fireEvent.change(within(dialog).getByLabelText("Profile Picture"), { target: { files: [picture] } });
    await waitFor(() =>
      expect(launcher().querySelector("img")?.getAttribute("src")).toBe("https://img.example.test/ada.png"),
    );
    expect(auth.setProfileImage).toHaveBeenCalledWith(renamed, picture);
    expect(within(dialog).getByRole("button", { name: "Replace Picture" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Picture" }));
    await waitFor(() => expect(launcher().querySelector("img")).toBeNull());
    expect(auth.removeProfileImage).toHaveBeenCalledWith(pictured);
    expect(within(dialog).getByRole("button", { name: "Upload Picture" })).toBeTruthy();
  });

  it("shows the username, then the email, when the account has no name", async () => {
    auth.restoreSession.mockResolvedValue({ id: "session_ada", userId: "user_ada", email: "ada@example.test", username: "ada" });
    const view = render(<HomepageAccount />);
    await waitFor(() => expect(launcher().getAttribute("aria-label")).toBe("ada, ada@example.test"));
    view.unmount();
    auth.restoreSession.mockResolvedValue({ id: "session_ada", userId: "user_ada", email: "ada@example.test" });
    render(<HomepageAccount />);
    await waitFor(() => expect(launcher().getAttribute("aria-label")).toBe("ada@example.test, ada@example.test"));
  });

  it("keeps the dialog editable and shows why when Clerk refuses a name or a picture", async () => {
    auth.restoreSession.mockResolvedValue(editable);
    auth.updateName.mockRejectedValue(new Error("That first name is too long."));
    auth.setProfileImage.mockRejectedValue(new Error("That picture is too large. Choose one under 10 MB."));
    render(<HomepageAccount />);
    const dialog = await openAccount();
    fireEvent.change(within(dialog).getByLabelText("First Name"), { target: { value: "A".repeat(300) } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Name" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("That first name is too long.");
    expect(within(dialog).getByRole("button", { name: "Save Name" })).toHaveProperty("disabled", false);
    expect(launcher().getAttribute("aria-label")).toBe("Ada Lovelace, ada@example.test");
    fireEvent.change(within(dialog).getByLabelText("Profile Picture"), {
      target: { files: [new File(["x"], "big.png", { type: "image/png" })] },
    });
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toBe("That picture is too large. Choose one under 10 MB."),
    );
  });

  it("offers Delete Account only when Clerk lets people delete themselves", async () => {
    auth.restoreSession.mockResolvedValue({ ...editable, deleteSelfEnabled: undefined });
    render(<HomepageAccount />);
    const dialog = await openAccount();
    expect(within(dialog).getByLabelText("First Name")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Delete Account" })).toBeNull();
  });

  async function startDeletion(dialog: HTMLElement) {
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Account" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Delete Account?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Send Code" }));
    return { confirm, code: await within(confirm).findByLabelText("Verification Code") };
  }

  it("asks for confirmation, says local projects stay and that subscriptions are not cancelled", async () => {
    auth.restoreSession.mockResolvedValue(editable);
    render(<HomepageAccount />);
    const dialog = await openAccount();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Account" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Delete Account?" });
    expect(confirm.textContent).toMatch(/Projects stored on this device are not deleted/);
    expect(confirm.textContent).toMatch(/does not cancel an active subscription/);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(auth.beginReverification).not.toHaveBeenCalled();
    expect(auth.deleteAccount).not.toHaveBeenCalled();
  });

  it("deletes only after the emailed code is verified, then returns the launcher to guest", async () => {
    auth.restoreSession.mockResolvedValue(editable);
    auth.beginReverification.mockResolvedValue(reverification);
    auth.completeReverification.mockResolvedValue(undefined);
    auth.deleteAccount.mockResolvedValue(undefined);
    render(<HomepageAccount />);
    const dialog = await openAccount();
    const { confirm, code } = await startDeletion(dialog);
    expect(auth.beginReverification).toHaveBeenCalledWith(editable);
    expect(confirm.textContent).toMatch(/code sent to ada@example\.test/);
    expect(within(confirm).getByRole("button", { name: "Delete Account" })).toHaveProperty("disabled", true);
    expect(auth.deleteAccount).not.toHaveBeenCalled();

    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete Account" }));
    await waitFor(() => expect(launcher().getAttribute("aria-label")).toBe("Guest, Not Signed In"));
    expect(auth.completeReverification).toHaveBeenCalledWith(reverification, "123456");
    expect(auth.deleteAccount).toHaveBeenCalledWith(editable);
    expect(auth.completeReverification.mock.invocationCallOrder[0]).toBeLessThan(
      auth.deleteAccount.mock.invocationCallOrder[0]!,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the account when the code is wrong and never asks Clerk to delete it", async () => {
    auth.restoreSession.mockResolvedValue(editable);
    auth.beginReverification.mockResolvedValue(reverification);
    auth.completeReverification.mockRejectedValue(new Error("That code is not correct. Please try again."));
    render(<HomepageAccount />);
    const { confirm, code } = await startDeletion(await openAccount());
    fireEvent.change(code, { target: { value: "000000" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete Account" }));
    expect((await within(confirm).findByRole("alert")).textContent).toBe(
      "That code is not correct. Please try again.",
    );
    expect(auth.deleteAccount).not.toHaveBeenCalled();
    expect(launcher().getAttribute("aria-label")).toBe("Ada Lovelace, ada@example.test");
    expect(within(confirm).getByLabelText("Verification Code")).toBeTruthy();
  });

  it("sends the code again to the same verification", async () => {
    auth.restoreSession.mockResolvedValue(editable);
    auth.beginReverification.mockResolvedValue(reverification);
    auth.resendReverificationCode.mockResolvedValue(reverification);
    render(<HomepageAccount />);
    const { confirm } = await startDeletion(await openAccount());
    fireEvent.click(within(confirm).getByRole("button", { name: "Resend Code" }));
    await waitFor(() => expect(auth.resendReverificationCode).toHaveBeenCalledWith(reverification));
    expect(auth.beginReverification).toHaveBeenCalledOnce();
  });

  it("keeps the account and explains when Clerk refuses the deletion", async () => {
    auth.restoreSession.mockResolvedValue(editable);
    auth.beginReverification.mockResolvedValue(reverification);
    auth.completeReverification.mockResolvedValue(undefined);
    auth.deleteAccount.mockRejectedValue(new Error("Your account could not be deleted. Please try again."));
    render(<HomepageAccount />);
    const dialog = await openAccount();
    const { confirm, code } = await startDeletion(dialog);
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete Account" }));
    expect((await within(confirm).findByRole("alert")).textContent).toBe(
      "Your account could not be deleted. Please try again.",
    );
    expect(launcher().getAttribute("aria-label")).toBe("Ada Lovelace, ada@example.test");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(dialog).getByRole("button", { name: "Delete Account" })).toBeTruthy();
  });
});
