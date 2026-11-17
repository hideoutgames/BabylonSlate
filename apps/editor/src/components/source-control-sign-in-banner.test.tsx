import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FakeLockProvider } from "@haptic/source-control";
import { SourceControlService } from "../services/source-control-service";
import { MANUAL_SOURCE_CONTROL, signedInHosts, TEST_GITHUB_CREDENTIAL } from "../testing/source-control-hosts";
import { SourceControlSignInBanner } from "./source-control-sign-in-banner";

const state = vi.hoisted(() => ({ service: null as import("../services/source-control-service").SourceControlService | null }));

vi.mock("@haptic/vfs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@haptic/vfs")>()),
  isTestModeEnabled: () => true,
}));
vi.mock("../context/document-context", async () =>
  (await import("../testing/document-context-mock")).documentContextMock(() => ({ sourceControl: state.service! })),
);
vi.mock("./settings-modal", () => ({
  SettingsModal: ({ scope, initialCategoryId }: { scope: string; initialCategoryId?: string }) => (
    <div data-testid="settings-modal-stub">{`${scope}:${initialCategoryId}`}</div>
  ),
}));

async function configured(repositoryUrl: string, mode: "off" | "manual" = "manual", signIn: "none" | "refused" | "expired" = "none") {
  const service = new SourceControlService();
  service.pausePolling();
  const hosts = await signedInHosts(null, signIn === "none" ? null : TEST_GITHUB_CREDENTIAL);
  if (signIn !== "none") vi.spyOn(hosts, "signInState").mockReturnValue(signIn);
  await service.configure({
    settings: { ...MANUAL_SOURCE_CONTROL, mode, repositoryUrl },
    projectKey: "proj",
    platform: "electron",
    testMode: true,
    hosts,
    fake: new FakeLockProvider(),
  });
  state.service = service;
  return service;
}

afterEach(() => {
  cleanup();
  state.service?.dispose();
  state.service = null;
});

describe("SourceControlSignInBanner", () => {
  it("names the host and leads Sign In to the link warning for GitHub", async () => {
    await configured("https://github.com/team/game.git");
    render(<SourceControlSignInBanner />);
    const banner = screen.getByTestId("source-control-sign-in-banner");
    expect(within(banner).getByText("This project uses GitHub file locking.")).toBeTruthy();
    fireEvent.click(within(banner).getByRole("button", { name: "Sign In" }));
    expect((await screen.findByTestId("source-control-link-warning")).textContent).toContain("Link GitHub?");
  });

  it("opens Engine Settings → Source Control for a host that takes a token", async () => {
    await configured("git@gitea.example.com:team/game.git");
    render(<SourceControlSignInBanner />);
    expect(screen.getByText("This project uses gitea.example.com file locking.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    expect(screen.getByTestId("settings-modal-stub").textContent).toBe("engine:sourceControl");
    expect(screen.queryByTestId("source-control-link-warning")).toBeNull();
  });

  it("asks to sign in again when the host refused the saved sign-in or it expired", async () => {
    await configured("https://github.com/team/game.git", "manual", "refused");
    render(<SourceControlSignInBanner />);
    const banner = screen.getByTestId("source-control-sign-in-banner");
    expect(within(banner).getByText("GitHub refused the saved sign-in.")).toBeTruthy();
    expect(within(banner).getByText("Sign in again to keep using source control on this device.")).toBeTruthy();
    fireEvent.click(within(banner).getByRole("button", { name: "Sign In Again" }));
    expect((await screen.findByTestId("source-control-link-warning")).textContent).toContain("Link GitHub?");
    cleanup();
    state.service?.dispose();

    await configured("https://github.com/team/game.git", "manual", "expired");
    render(<SourceControlSignInBanner />);
    expect(screen.getByText("The GitHub sign-in expired.")).toBeTruthy();
  });

  it("renders nothing while the mode is Off", async () => {
    await configured("https://github.com/team/game.git", "off");
    const { container } = render(<SourceControlSignInBanner />);
    expect(container.innerHTML).toBe("");
  });
});
