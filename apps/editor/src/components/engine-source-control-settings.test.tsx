import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FakeGitHost, MemorySecrets } from "@haptic/source-control/fake-host";
import { TooltipProvider } from "@haptic/ui/components/tooltip";
import { SourceControlAccounts } from "../services/source-control-accounts";
import { NativeHomepageAccountContext, type NativeHomepageAccount } from "./homepage-account-context";
import EngineSourceControlSettings from "./engine-source-control-settings";

const state = vi.hoisted(() => ({
  testMode: true,
  accounts: null as import("../services/source-control-accounts").SourceControlAccounts | null,
  /** Device sign-in's pending waits between polls; a test releases them. */
  waits: [] as Array<() => void>,
}));

vi.mock("@haptic/source-control/device-flow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@haptic/source-control/device-flow")>()),
  systemDeviceClock: {
    now: () => Date.now(),
    wait: (_ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      state.waits.push(resolve);
      signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }),
  },
}));

function releaseWaits() {
  for (const resolve of state.waits.splice(0)) resolve();
}

vi.mock("@haptic/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@haptic/vfs")>()),
  isTestModeEnabled: () => state.testMode,
}));

// The real accounts on in-memory secrets, against the fake GitHub and GitLab host.
vi.mock("../services/source-control-accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/source-control-accounts")>()),
  sourceControlAccounts: async () => state.accounts!,
}));

let host: FakeGitHost;

beforeEach(() => {
  host = new FakeGitHost();
  state.accounts = new SourceControlAccounts(new MemorySecrets(), host.http, { fakeHost: host });
});

afterEach(() => {
  cleanup();
  state.testMode = true;
  state.waits.length = 0;
  vi.restoreAllMocks();
});

function renderPage(holdSessionCheck?: () => () => void) {
  const page = (
    <TooltipProvider>
      <EngineSourceControlSettings />
    </TooltipProvider>
  );
  return render(holdSessionCheck ? (
    <NativeHomepageAccountContext.Provider value={{ profile: { holdSessionCheck } } as unknown as NativeHomepageAccount}>
      {page}
    </NativeHomepageAccountContext.Provider>
  ) : page);
}

const WARNING_PARAGRAPHS = [
  "Haptic will clone, pull, commit, push and lock files in your repositories from this device.",
  "You use this integration at your own risk. Haptic is not responsible for lost work, overwritten files or other problems that result from using it.",
  "Keep backups of important projects.",
];

describe("Engine Settings → Source Control", () => {
  it("warns before linking GitHub and stores nothing on Decline", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("settings-source-control-sign-in-github"));
    const warning = await screen.findByTestId("source-control-link-warning");
    expect(within(warning).getByRole("heading").textContent).toBe("Link GitHub?");
    expect([...warning.querySelectorAll("p")].map((paragraph) => paragraph.textContent?.replace(/\s+/g, " ").trim())).toEqual(WARNING_PARAGRAPHS);
    expect(within(warning).getAllByRole("button").map((button) => button.textContent)).toEqual(["Decline", "Accept"]);
    fireEvent.click(within(warning).getByText("Decline"));
    await waitFor(() => expect(screen.queryByTestId("source-control-link-warning")).toBeNull());
    expect(screen.queryByTestId("source-control-sign-in-dialog")).toBeNull();
    expect(await state.accounts!.list()).toEqual([]);
    expect(host.requests).toEqual([]);
  });

  it("signs in to GitHub with a device code after Accept, then signs out", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    // Pending until the code is shown and opened, then granted.
    host.tokenReplies = ["authorization_pending"];
    host.account = "ada";
    renderPage();
    fireEvent.click(await screen.findByTestId("settings-source-control-sign-in-github"));
    fireEvent.click(await screen.findByTestId("source-control-link-accept"));
    const dialog = await screen.findByTestId("source-control-sign-in-dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Sign In To GitHub");
    expect(((await within(dialog).findByTestId("source-control-device-code")) as HTMLInputElement).value).toBe("WDJB-MJHT");
    fireEvent.click(within(dialog).getByTestId("source-control-device-code-copy"));
    expect(writeText).toHaveBeenCalledWith("WDJB-MJHT");
    fireEvent.click(within(dialog).getByText("Open GitHub"));
    expect(open).toHaveBeenCalledWith("https://github.com/login/device", "_blank", "noopener,noreferrer");
    expect(within(dialog).getByTestId("source-control-sign-in-status").textContent).toMatch(/^Waiting for approval\. The code expires in 1[45]:\d\d\.$/);
    await waitFor(() => {
      releaseWaits();
      expect(screen.queryByTestId("source-control-sign-in-dialog")).toBeNull();
    });
    expect(await state.accounts!.list()).toEqual([
      { origin: "https://github.com", username: "x-access-token", token: "fake-github-token", kind: "github", account: "ada", accountId: "1001" },
    ]);
    expect((await screen.findByTestId("settings-source-control-account-github-user")).textContent).toBe("ada");
    fireEvent.click(screen.getByTestId("settings-source-control-sign-out-github"));
    await waitFor(() => expect(screen.getByTestId("settings-source-control-sign-in-github")).toBeTruthy());
    expect(await state.accounts!.list()).toEqual([]);
  });

  it("holds the mobile session check while device sign-in waits on the browser", async () => {
    const release = vi.fn();
    const holdSessionCheck = vi.fn(() => release);
    renderPage(holdSessionCheck);
    fireEvent.click(await screen.findByTestId("settings-source-control-sign-in-gitlab"));
    expect((await screen.findByTestId("source-control-link-warning")).textContent).toContain("Link GitLab?");
    expect(holdSessionCheck).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("source-control-link-accept"));
    expect(holdSessionCheck).toHaveBeenCalledOnce();
    expect(await screen.findByTestId("source-control-device-code")).toBeTruthy();
    expect(release).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("source-control-sign-in-cancel"));
    await waitFor(() => expect(screen.queryByTestId("source-control-sign-in-dialog")).toBeNull());
    expect(release).toHaveBeenCalledOnce();
    expect(await state.accounts!.list()).toEqual([]);
  });

  it("hides a host's Sign In without its client id", async () => {
    state.testMode = false;
    renderPage();
    expect(await screen.findByText("Other Git Hosts")).toBeTruthy();
    expect(screen.queryByText("Accounts")).toBeNull();
    expect(screen.queryByTestId("settings-source-control-sign-in-github")).toBeNull();
  });

  it("adds and removes another host's token, each after the link warning", async () => {
    renderPage();
    const save = await screen.findByTestId("settings-source-control-host-save");
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("settings-source-control-host-url"), { target: { value: "ftp://gitea.example.com" } });
    expect(screen.getByText("Enter an HTTPS URL.")).toBeTruthy();
    fireEvent.change(screen.getByTestId("settings-source-control-host-url"), { target: { value: "gitea.example.com/team/game" } });
    fireEvent.change(screen.getByTestId("settings-source-control-host-token"), { target: { value: " tok " } });
    fireEvent.click(save);
    const warning = await screen.findByTestId("source-control-link-warning");
    expect(within(warning).getByRole("heading").textContent).toBe("Link gitea.example.com?");
    expect(await state.accounts!.list()).toEqual([]);
    fireEvent.click(screen.getByTestId("source-control-link-accept"));
    const row = await screen.findByTestId("settings-source-control-host-gitea.example.com");
    expect(row.textContent).toContain("Token Saved");
    expect(await state.accounts!.list()).toEqual([
      { origin: "https://gitea.example.com", username: "x-access-token", token: "tok", kind: "token" },
    ]);
    expect((screen.getByTestId("settings-source-control-host-token") as HTMLInputElement).value).toBe("");
    fireEvent.click(within(row).getByRole("button", { name: "Remove gitea.example.com" }));
    await waitFor(() => expect(screen.queryByTestId("settings-source-control-host-gitea.example.com")).toBeNull());
    expect(await state.accounts!.list()).toEqual([]);
  });

  it("saves a self-managed GitLab token with a fixed username", async () => {
    renderPage();
    fireEvent.change(await screen.findByTestId("settings-source-control-gitlab-url"), { target: { value: "https://git.example.com" } });
    fireEvent.change(screen.getByTestId("settings-source-control-gitlab-token"), { target: { value: "glpat" } });
    fireEvent.click(screen.getByTestId("settings-source-control-gitlab-save"));
    fireEvent.click(await screen.findByTestId("source-control-link-accept"));
    expect(await screen.findByTestId("settings-source-control-host-git.example.com")).toBeTruthy();
    const [saved] = await state.accounts!.list();
    expect(saved).toMatchObject({ origin: "https://git.example.com", token: "glpat", kind: "gitlab-token" });
    expect(saved!.username).not.toBe("");
    expect(saved!.username).not.toBe("oauth2");
  });
});

describe("Sign In To GitHub", () => {
  it("says the code expired and gets a new one on Try Again", async () => {
    host.tokenReplies = ["expired_token"];
    renderPage();
    fireEvent.click(await screen.findByTestId("settings-source-control-sign-in-github"));
    fireEvent.click(await screen.findByTestId("source-control-link-accept"));
    await screen.findByTestId("source-control-device-code");
    await waitFor(() => {
      releaseWaits();
      expect(screen.getByTestId("source-control-sign-in-error").textContent).toContain("The code expired. Get a new code to try again.");
    });
    expect(screen.queryByText("Open GitHub")).toBeNull();
    fireEvent.click(screen.getByTestId("source-control-sign-in-retry"));
    expect(((await screen.findByTestId("source-control-device-code")) as HTMLInputElement).value).toBe("WDJB-MJHT");
    expect(host.requests.filter((request) => request.url === "https://github.com/login/device/code")).toHaveLength(2);
    expect(await state.accounts!.list()).toEqual([]);
  });

  it("stops polling on Cancel", async () => {
    host.tokenReplies = [];
    renderPage();
    fireEvent.click(await screen.findByTestId("settings-source-control-sign-in-github"));
    fireEvent.click(await screen.findByTestId("source-control-link-accept"));
    await screen.findByTestId("source-control-device-code");
    fireEvent.click(screen.getByTestId("source-control-sign-in-cancel"));
    await waitFor(() => expect(screen.queryByTestId("source-control-sign-in-dialog")).toBeNull());
    releaseWaits();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.requests.some((request) => request.url.endsWith("/access_token"))).toBe(false);
    expect(await state.accounts!.list()).toEqual([]);
  });
});
