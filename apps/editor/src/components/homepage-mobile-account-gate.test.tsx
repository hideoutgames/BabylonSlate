import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HomepageMobileAccountGate } from "./homepage-mobile-account-gate";
import { HomepageAccount } from "./homepage-account";
import { MobileDemoProvider } from "../context/mobile-demo-context";

const auth = vi.hoisted(() => ({
  host: "web",
  create: vi.fn(),
  restoreSession: vi.fn(),
  beginEmail: vi.fn(),
  verifyCode: vi.fn(),
  resendCode: vi.fn(),
  signOut: vi.fn(),
  updateName: vi.fn(),
  setProfileImage: vi.fn(),
  beginReverification: vi.fn(),
  completeReverification: vi.fn(),
  deleteAccount: vi.fn(),
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
  getHostPlatform: () => auth.host,
}));
// The native auth adapter owns FAPI and secure storage; its protocol has separate tests.
vi.mock("../services/native-clerk", () => ({
  createNativeClerkClient: (...args: unknown[]) => {
    auth.create(...args);
    return auth;
  },
}));

beforeEach(() => {
  auth.restoreSession.mockResolvedValue(null);
  auth.beginEmail.mockResolvedValue(challenge);
  auth.verifyCode.mockResolvedValue(session);
  auth.resendCode.mockResolvedValue(challenge);
  auth.signOut.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  auth.host = "web";
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mobileHome(gateKey = 0) {
  return (
    <MobileDemoProvider>
      <HomepageMobileAccountGate key={gateKey}>
        <button>Create Project</button>
        <HomepageAccount />
      </HomepageMobileAccountGate>
    </MobileDemoProvider>
  );
}

// A Base UI menu trigger mounted outside act ignores clicks until React's passive
// effects hand it the menu's open handler; it reports aria-expanded from then on.
function findProfileTrigger() {
  return screen.findByRole("button", {
    name: `${session.name}, ${session.email}`,
    expanded: false,
  });
}

function renderMobile(host = "ios", publishableKey = "pk_test_example") {
  auth.host = host;
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", publishableKey);
  return render(mobileHome());
}

describe("native mobile account requirement", () => {
  it.each(["ios", "android"])(
    "opens local %s projects only after explicit demo entry and closes them on End Demo",
    async (host) => {
      renderMobile(host, "");
      expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Use Temporary Demo Account" }));
      expect(screen.getByRole("button", { name: "Create Project" })).toBeTruthy();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Temporary Demo, Local Testing Only · Not Signed In",
        }),
      );
      expect(within(await screen.findByRole("menu")).getByText("Temporary Demo")).toBeTruthy();
      expect(screen.getByText("Local Testing Only · Not Signed In")).toBeTruthy();
      fireEvent.click(screen.getByRole("menuitem", { name: "End Demo" }));
      expect(await screen.findByRole("heading", { name: "Sign-In Is Not Set Up" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
      expect(auth.create).not.toHaveBeenCalled();
      expect(auth.signOut).not.toHaveBeenCalled();
    },
  );

  it("keeps demo access through homepage remounts but not a fresh app session", () => {
    const view = renderMobile("ios", "");
    fireEvent.click(screen.getByRole("button", { name: "Use Temporary Demo Account" }));
    view.rerender(mobileHome(1));
    expect(screen.getByRole("button", { name: "Create Project" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use Temporary Demo Account" })).toBeNull();
    view.unmount();
    renderMobile("ios", "");
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    expect(screen.getByRole("button", { name: "Use Temporary Demo Account" })).toBeTruthy();
  });

  it("allows demo during a pending account restore without accepting its late session", async () => {
    let finishRestore: (value: typeof session) => void = () => {};
    auth.restoreSession.mockReturnValueOnce(new Promise((resolve) => {
      finishRestore = resolve;
    }));
    renderMobile();
    await waitFor(() => expect(auth.restoreSession).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Use Temporary Demo Account" }));
    await act(async () => finishRestore(session));
    fireEvent.click(screen.getByTestId("homepage-account"));
    expect(within(await screen.findByRole("menu")).getByText("Temporary Demo")).toBeTruthy();
    expect(screen.queryByText("Ada Lovelace")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "End Demo" }));
    expect(await screen.findByLabelText("Email Address")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(auth.verifyCode).not.toHaveBeenCalled();
  });

  it.each(["web", "electron"])(
    "keeps phone-sized %s project access available without an account",
    (host) => {
      auth.host = host;
      vi.stubGlobal("innerWidth", 390);
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
      render(
        <HomepageMobileAccountGate>
          <button>Create Project</button>
        </HomepageMobileAccountGate>,
      );
      expect(
        screen.getByRole("button", { name: "Create Project" }),
      ).toBeTruthy();
      expect(auth.create).not.toHaveBeenCalled();
    },
  );

  it.each(["ios", "android"])(
    "requires account configuration on %s",
    (host) => {
      auth.host = host;
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
      render(
        <HomepageMobileAccountGate>
          <button>Create Project</button>
        </HomepageMobileAccountGate>,
      );
      expect(
        screen.queryByRole("button", { name: "Create Project" }),
      ).toBeNull();
      expect(
        screen.getByRole("heading", { name: "Sign-In Is Not Set Up" }),
      ).toBeTruthy();
      expect(auth.create).not.toHaveBeenCalled();
    },
  );

  it.each(["ios", "android"])(
    "lets %s through without an account in test mode",
    (host) => {
      auth.host = host;
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
      window.history.replaceState({}, "", "/?test");
      try {
        render(
          <HomepageMobileAccountGate>
            <button>Create Project</button>
          </HomepageMobileAccountGate>,
        );
        expect(
          screen.getByRole("button", { name: "Create Project" }),
        ).toBeTruthy();
        expect(auth.create).not.toHaveBeenCalled();
      } finally {
        window.history.replaceState({}, "", "/");
      }
    },
  );

  it.each(["ios", "android"])(
    "does not let %s through on an explicit ?test=false",
    (host) => {
      auth.host = host;
      vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
      window.history.replaceState({}, "", "/?test=false");
      try {
        render(
          <HomepageMobileAccountGate>
            <button>Create Project</button>
          </HomepageMobileAccountGate>,
        );
        expect(
          screen.queryByRole("button", { name: "Create Project" }),
        ).toBeNull();
        expect(
          screen.getByRole("heading", { name: "Sign-In Is Not Set Up" }),
        ).toBeTruthy();
      } finally {
        window.history.replaceState({}, "", "/");
      }
    },
  );

  it("only opens native projects after verification, then signs out through Profile", async () => {
    renderMobile();
    fireEvent.change(await screen.findByLabelText("Email Address"), {
      target: { value: "ada@example.test" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue With Email" }),
    );
    const code = await screen.findByLabelText("Verification Code");
    expect(auth.beginEmail).toHaveBeenCalledWith("ada@example.test", "sign-in");
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & Continue" }));
    expect(
      await screen.findByRole("button", { name: "Create Project" }),
    ).toBeTruthy();
    expect(auth.verifyCode).toHaveBeenCalledWith(challenge, "123456");
    fireEvent.click(await findProfileTrigger());
    expect(within(await screen.findByRole("menu")).getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("ada@example.test")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign Out" }));
    expect(await screen.findByLabelText("Email Address")).toBeTruthy();
    expect(auth.signOut).toHaveBeenCalledWith(session);
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("supports creating an account, invalid-code recovery, and resending without stale errors", async () => {
    auth.verifyCode.mockRejectedValueOnce(
      new Error("That code did not match. Try again."),
    );
    renderMobile();
    fireEvent.click(
      await screen.findByRole("button", { name: "Create Account" }),
    );
    fireEvent.change(screen.getByLabelText("Email Address"), {
      target: { value: "ada@example.test" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue With Email" }),
    );
    const code = await screen.findByLabelText("Verification Code");
    expect(auth.beginEmail).toHaveBeenCalledWith("ada@example.test", "sign-up");
    fireEvent.change(code, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & Continue" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "That code did not match. Try again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Resend Code" }));
    await waitFor(() =>
      expect(auth.resendCode).toHaveBeenCalledWith(challenge),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Verification Code")).toHaveProperty(
      "value",
      "",
    );
    fireEvent.click(screen.getByRole("button", { name: "Use Another Email" }));
    expect(await screen.findByLabelText("Email Address")).toBeTruthy();
    expect(screen.queryByLabelText("Verification Code")).toBeNull();
  });

  it("focuses each form step and prevents repeat requests while verification is pending", async () => {
    auth.verifyCode.mockReturnValueOnce(new Promise(() => {}));
    renderMobile();
    const email = await screen.findByLabelText("Email Address");
    await waitFor(() => expect(document.activeElement).toBe(email));
    fireEvent.change(email, { target: { value: "ada@example.test" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Continue With Email" }),
    );
    const code = await screen.findByLabelText("Verification Code");
    await waitFor(() => expect(document.activeElement).toBe(code));
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify & Continue" }));
    expect(
      await screen.findByRole("button", { name: "One Moment…" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Resend Code" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByRole("button", { name: "Use Another Email" }),
    ).toHaveProperty("disabled", true);
    fireEvent.submit(code.closest("form")!);
    expect(auth.verifyCode).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
  });

  it("opens a restored active native session without another sign-in", async () => {
    auth.restoreSession.mockResolvedValueOnce(session);
    renderMobile();
    expect(
      await screen.findByRole("button", { name: "Create Project" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Email Address")).toBeNull();
    expect(auth.beginEmail).not.toHaveBeenCalled();
  });

  it("blocks project actions during a foreground check and returns revoked sessions to sign-in", async () => {
    let finishRestore: (value: typeof session | null) => void = () => {};
    auth.restoreSession.mockResolvedValueOnce(session).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRestore = resolve;
      }),
    );
    renderMobile();
    expect(
      await screen.findByRole("button", { name: "Create Project" }),
    ).toBeTruthy();
    fireEvent(window, new Event("focus"));
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    fireEvent(window, new Event("focus"));
    expect(auth.restoreSession).toHaveBeenCalledTimes(2);
    await act(async () => finishRestore(null));
    expect(await screen.findByLabelText("Email Address")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
  });

  it("rechecks visibility resume, keeps failed validation closed, and verifies again on retry", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");
    auth.restoreSession
      .mockResolvedValueOnce(session)
      .mockRejectedValueOnce(new Error("Connection unavailable."))
      .mockResolvedValueOnce(session);
    renderMobile();
    expect(
      await screen.findByRole("button", { name: "Create Project" }),
    ).toBeTruthy();
    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(auth.restoreSession).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Connection unavailable.",
    );
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(
      await screen.findByRole("button", { name: "Create Project" }),
    ).toBeTruthy();
  });

  it("removes foreground checks when the homepage unmounts, including a pending check", async () => {
    let finishRestore: (value: typeof session | null) => void = () => {};
    auth.restoreSession.mockResolvedValueOnce(session).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRestore = resolve;
      }),
    );
    const view = renderMobile();
    expect(
      await screen.findByRole("button", { name: "Create Project" }),
    ).toBeTruthy();
    fireEvent(window, new Event("focus"));
    expect(auth.restoreSession).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => finishRestore(session));
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
    expect(auth.restoreSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
  });

  it("blocks project entry until sign-out settles and keeps a failed removal recoverable", async () => {
    let failSignOut: (cause: Error) => void = () => {};
    auth.restoreSession.mockResolvedValue(session);
    auth.signOut.mockReturnValueOnce(
      new Promise((_, reject) => {
        failSignOut = reject;
      }),
    );
    renderMobile();
    fireEvent.click(await findProfileTrigger());
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign Out" }));
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent(window, new Event("focus"));
    expect(auth.restoreSession).toHaveBeenCalledTimes(1);
    await act(async () =>
      failSignOut(new Error("Could not connect. Please try again.")),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Could not connect. Please try again.",
    );
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(
      await screen.findByRole("button", { name: "Create Project" }),
    ).toBeTruthy();
  });

  it("keeps project actions hidden while restoring a session or when restoration fails", async () => {
    let rejectRestore: (error: Error) => void = () => {};
    auth.restoreSession.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectRestore = reject;
      }),
    );
    renderMobile();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    await waitFor(() => expect(auth.restoreSession).toHaveBeenCalled());
    rejectRestore(new Error("Connection unavailable."));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Connection unavailable.",
    );
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByLabelText("Email Address")).toBeTruthy();
  });

  it("edits the name from the Account dialog and deletes the account back to the sign-in gate", async () => {
    const editable = { ...session, firstName: "Ada", lastName: "Lovelace", deleteSelfEnabled: true };
    auth.restoreSession.mockResolvedValue(editable);
    auth.updateName.mockResolvedValue({ ...editable, name: "Ada King", lastName: "King" });
    auth.deleteAccount.mockResolvedValue(undefined);
    auth.beginReverification.mockResolvedValue({
      sessionId: "session_ada",
      emailAddressId: "email_ada",
      email: "ada@example.test",
    });
    auth.completeReverification.mockResolvedValue(undefined);
    renderMobile();
    fireEvent.click(await findProfileTrigger());
    fireEvent.click(await screen.findByRole("menuitem", { name: /Manage Account/ }));
    const dialog = await screen.findByRole("dialog", { name: "Account" });
    fireEvent.change(within(dialog).getByLabelText("Last Name"), { target: { value: "King" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Name" }));
    await waitFor(() =>
      expect(screen.getByTestId("homepage-account").getAttribute("aria-label")).toBe(
        "Ada King, ada@example.test",
      ),
    );
    expect(auth.updateName).toHaveBeenCalledWith(editable, { firstName: "Ada", lastName: "King" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Account" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toMatch(/does not cancel your App Store subscription/);
    expect(within(confirm).getByRole("link", { name: "Manage Subscriptions" }).getAttribute("href")).toBe(
      "https://apps.apple.com/account/subscriptions",
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Send Code" }));
    // Reading the emailed code in a mail app returns through the foreground
    // check, which must not hide the app and drop this dialog.
    fireEvent.change(await within(confirm).findByLabelText("Verification Code"), { target: { value: "123456" } });
    fireEvent(window, new Event("focus"));
    expect(auth.restoreSession).toHaveBeenCalledTimes(1);
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete Account" }));
    expect(await screen.findByLabelText("Email Address")).toBeTruthy();
    expect(auth.completeReverification).toHaveBeenCalledOnce();
    expect(auth.deleteAccount).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Create Project" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The gate stays closed: nothing restores the deleted account's session.
    fireEvent(window, new Event("focus"));
    expect(auth.restoreSession).toHaveBeenCalledTimes(1);
  });

  // Returning from the system file picker fires window focus. The foreground
  // check hides the app, which would unmount the file input before its change
  // event delivers the picture and close the dialog the person is working in.
  it("does not hide the Account dialog for the foreground check while the file picker is open", async () => {
    auth.restoreSession.mockResolvedValue(session);
    auth.setProfileImage.mockResolvedValue({ ...session, imageUrl: "https://img.example.test/ada.png" });
    renderMobile();
    fireEvent.click(await findProfileTrigger());
    fireEvent.click(await screen.findByRole("menuitem", { name: /Manage Account/ }));
    const dialog = await screen.findByRole("dialog", { name: "Account" });
    const input = within(dialog).getByLabelText("Profile Picture");
    const upload = () => fireEvent.click(within(dialog).getByRole("button", { name: /Upload Picture/ }));

    upload();
    fireEvent(window, new Event("focus"));
    expect(screen.getByRole("dialog", { name: "Account" })).toBe(dialog);
    expect(auth.restoreSession).toHaveBeenCalledTimes(1);

    // A cancelled pick ends the hold.
    fireEvent(input, new Event("cancel"));
    upload();
    const picture = new File([Uint8Array.of(1, 2, 3)], "ada.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [picture] } });
    await waitFor(() => expect(auth.setProfileImage).toHaveBeenCalledWith(session, picture));
    await waitFor(() =>
      expect(screen.getByTestId("homepage-account").querySelector("img")?.getAttribute("src")).toBe(
        "https://img.example.test/ada.png",
      ),
    );

    // Once the upload settles the foreground check runs again.
    fireEvent(window, new Event("focus"));
    expect(auth.restoreSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
