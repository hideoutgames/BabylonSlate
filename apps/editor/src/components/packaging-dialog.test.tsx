import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ok } from "@haptic/core";
import { PackagingDialog } from "./packaging-dialog";

const { exportGameArtifact, zipExportedGame, project } = vi.hoisted(() => ({
  exportGameArtifact: vi.fn(),
  zipExportedGame: vi.fn(),
  project: { startupSceneGuid: "scene-main" as string | null },
}));

vi.mock("../context/document-context", async () => {
  const { createEmptyProject } = await import("@haptic/core");
  const scene = { header: { guid: "scene-main", name: "MainMenu", type: "Scene" }, path: "assets/MainMenu.scene.hasset" };
  return (await import("../testing/document-context-mock")).documentContextMock(() => {
    const projectDocument = createEmptyProject("Harbour Run");
    projectDocument.settings.startupSceneGuid = project.startupSceneGuid;
    projectDocument.settings.alwaysPackageFolders = ["assets/Audio", "assets/Localization"];
    return {
      projectDocument,
      assetRegistry: { list: () => [scene], getByGuid: (guid: string) => (guid === scene.header.guid ? scene : undefined) },
      exportGameArtifact,
      zipExportedGame,
    };
  });
});

afterEach(() => {
  cleanup();
  exportGameArtifact.mockReset();
  zipExportedGame.mockReset();
  project.startupSceneGuid = "scene-main";
  vi.restoreAllMocks();
});

function renderDialog() {
  const onOpenProjectSettings = vi.fn();
  render(<PackagingDialog open onOpenChange={() => {}} onOpenProjectSettings={onOpenProjectSettings} />);
  return { onOpenProjectSettings };
}

const summary = () => within(screen.getByTestId("packaging-summary"));

it("packages the project for the web and downloads the archive named after it", async () => {
  const artifact = { files: [] };
  exportGameArtifact.mockResolvedValue(ok(artifact));
  zipExportedGame.mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:game");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const downloads: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  renderDialog();
  expect(screen.getByTestId("packaging-target-web").getAttribute("aria-pressed")).toBe("true");
  expect(summary().getByText("Harbour_Run.zip")).toBeTruthy();
  expect(summary().getByText("MainMenu")).toBeTruthy();
  expect(summary().getByText("2 Folders")).toBeTruthy();

  await act(async () => {
    fireEvent.click(screen.getByTestId("packaging-package"));
  });

  expect(exportGameArtifact).toHaveBeenCalledTimes(1);
  expect(exportGameArtifact.mock.calls[0]![0].projectSnapshot.metadata.name).toBe("Harbour Run");
  expect(zipExportedGame).toHaveBeenCalledWith(artifact);
  expect(downloads).toEqual(["Harbour_Run.zip"]);
  expect(screen.getByText("Game package prepared. Check your downloads.")).toBeTruthy();
});

it("groups platforms into Available and Unavailable and explains an unavailable one", () => {
  renderDialog();
  const available = within(screen.getByRole("group", { name: "Available" }));
  const unavailable = within(screen.getByRole("group", { name: "Unavailable" }));
  expect(available.getAllByRole("button").map((button) => button.textContent)).toEqual(["Web"]);
  expect(unavailable.getAllByRole("button").map((button) => button.textContent)).toEqual(["Windows", "Linux", "macOS", "Android", "iOS"]);

  fireEvent.click(screen.getByTestId("packaging-target-android"));
  const detail = within(screen.getByTestId("packaging-detail"));
  expect(detail.getByText("Android packaging is not available on this device.")).toBeTruthy();
  expect(screen.queryByTestId("packaging-summary")).toBeNull();
  expect(screen.getByTestId("packaging-package").hasAttribute("disabled")).toBe(true);
  expect(screen.getByTestId("packaging-target-web").getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(screen.getByTestId("packaging-target-web"));
  expect(screen.getByTestId("packaging-package").hasAttribute("disabled")).toBe(false);
});

it.each([
  [null, "Not Set"],
  ["scene-deleted", "Missing"],
])("keeps Package unavailable while the Startup Scene is %s and links to Game settings", (guid, shown) => {
  project.startupSceneGuid = guid;
  const { onOpenProjectSettings } = renderDialog();
  expect(summary().getByText(shown)).toBeTruthy();
  expect(screen.getByTestId("packaging-package").hasAttribute("disabled")).toBe(true);
  fireEvent.click(within(screen.getByTestId("packaging-startup-scene")).getByRole("button", { name: "Game Settings" }));
  expect(onOpenProjectSettings).toHaveBeenCalledWith("game");
  expect(exportGameArtifact).not.toHaveBeenCalled();
});

it("explains a failed package and lets you try again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let reject!: (error: Error) => void;
  exportGameArtifact.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
  renderDialog();
  fireEvent.click(screen.getByTestId("packaging-package"));
  expect(screen.getByTestId("packaging-package").textContent).toBe("Packaging…");
  expect(screen.getByTestId("packaging-package").hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("progressbar")).toBeTruthy();

  await act(async () => { reject(new Error("zip failed")); });

  expect(screen.getByTestId("packaging-error").textContent).toBe("Could not build the zip. Try again.");
  expect(screen.getByTestId("packaging-package").hasAttribute("disabled")).toBe(false);
  expect(screen.queryByRole("progressbar")).toBeNull();
});

it("opens the export settings that decide what a package includes", () => {
  const { onOpenProjectSettings } = renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "Export Settings" }));
  expect(onOpenProjectSettings).toHaveBeenCalledWith("export");
  expect(exportGameArtifact).not.toHaveBeenCalled();
});
