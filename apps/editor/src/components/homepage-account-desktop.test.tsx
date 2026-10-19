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
const editable = {
  ...session,
  firstName: "Ada",
  lastName: "Lovelace",
  deleteSelfEnabled: true,
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

  it("deletes only after confirmation, says local projects stay, then returns the launcher to guest", async () => {
    auth.restoreSession.mockResolvedValue(editable);
    auth.deleteAccount.mockResolvedValue(undefined);
    render(<HomepageAccount />);
    const dialog = await openAccount();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Account" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Delete Account?" });
    expect(confirm.textContent).toMatch(/Projects stored on this device are not deleted/);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(auth.deleteAccount).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Account" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete Account" }),
    );
    await waitFor(() => expect(launcher().getAttribute("aria-label")).toBe("Guest, Not Signed In"));
    expect(auth.deleteAccount).toHaveBeenCalledWith(editable);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the account and explains when Clerk refuses the deletion", async () => {
    auth.restoreSession.mockResolvedValue(editable);
    auth.deleteAccount.mockRejectedValue(new Error("Your account could not be deleted. Please try again."));
    render(<HomepageAccount />);
    const dialog = await openAccount();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Account" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete Account" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect((await within(confirm).findByRole("alert")).textContent).toBe(
      "Your account could not be deleted. Please try again.",
    );
    expect(launcher().getAttribute("aria-label")).toBe("Ada Lovelace, ada@example.test");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(dialog).getByRole("button", { name: "Delete Account" })).toBeTruthy();
  });
});
