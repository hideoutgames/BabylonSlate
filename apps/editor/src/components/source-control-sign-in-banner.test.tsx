import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FakeLockProvider } from "@haptic/source-control";
import { SourceControlService } from "../services/source-control-service";
import { MANUAL_SOURCE_CONTROL, signedInHosts } from "../testing/source-control-hosts";
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

async function configured(repositoryUrl: string, mode: "off" | "manual" = "manual") {
  const service = new SourceControlService();
  service.pausePolling();
  await service.configure({
    settings: { ...MANUAL_SOURCE_CONTROL, mode, repositoryUrl },
    projectKey: "proj",
    platform: "electron",
    testMode: true,
    hosts: await signedInHosts(null, null),
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

  it("renders nothing while the mode is Off", async () => {
    await configured("https://github.com/team/game.git", "off");
    const { container } = render(<SourceControlSignInBanner />);
    expect(container.innerHTML).toBe("");
  });
});
