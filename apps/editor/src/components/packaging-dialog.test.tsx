import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ok } from "@haptic/core";
import { strToU8, unzipSync, zipSync } from "fflate";
import type { GameShellManifest } from "../lib/game-shells";
import { PackagingDialog } from "./packaging-dialog";

const { exportGameArtifact, zipExportedGame, project, shells } = vi.hoisted(() => ({
  exportGameArtifact: vi.fn(),
  zipExportedGame: vi.fn(),
  project: { startupSceneGuid: "scene-main" as string | null },
  shells: { manifest: null as GameShellManifest | null, loadDesktopShell: vi.fn() },
}));

vi.mock("../lib/game-shells", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/game-shells")>()),
  loadGameShellManifest: async () => shells.manifest,
  loadDesktopShell: shells.loadDesktopShell,
}));

/** A build that carries Windows and Linux players. */
const SHELLS: GameShellManifest = {
  electronVersion: "44.9.3",
  host: { file: "game-host.cjs", sha256: "0".repeat(64) },
  shells: [
    { target: "windows-x64", sha256: "1".repeat(64), size: 10, source: "bundled", parts: ["electron-windows-x64.zip.000"] },
    { target: "linux-x64", sha256: "2".repeat(64), size: 10, source: "bundled", parts: ["electron-linux-x64.zip.000"] },
  ],
};

vi.mock("../context/document-context", async () => {
  const { createEmptyProject } = await import("@haptic/core");
  const scene = { header: { guid: "scene-main", name: "MainMenu", type: "Scene" }, path: "assets/MainMenu.scene.hasset" };
  return (await import("../testing/document-context-mock")).documentContextMock(() => {
    const projectDocument = createEmptyProject("Harbour Run");
    projectDocument.settings.startupSceneGuid = project.startupSceneGuid;
    projectDocument.settings.alwaysPackageFolders = ["assets/Audio", "assets/Localization"];
    return {
      projectDocument,
      projectGuid: "harbour-guid",
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
  shells.manifest = null;
  shells.loadDesktopShell.mockReset();
  vi.restoreAllMocks();
});

async function renderDialog() {
  const onOpenProjectSettings = vi.fn();
  // The build's players are read when the dialog opens.
  await act(async () => { render(<PackagingDialog open onOpenChange={() => {}} onOpenProjectSettings={onOpenProjectSettings} />); });
  return { onOpenProjectSettings };
}

function captureDownloads(): string[] {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:game");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const downloads: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  return downloads;
}

const summary = () => within(screen.getByTestId("packaging-summary"));

it("packages the project for the web and downloads the archive named after it", async () => {
  const artifact = { files: [] };
  exportGameArtifact.mockResolvedValue(ok(artifact));
  zipExportedGame.mockResolvedValue(new Uint8Array([1, 2, 3]));
  const downloads = captureDownloads();
  await renderDialog();
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
  expect(screen.getByText("Game package downloaded. Check your downloads.")).toBeTruthy();
});

it("groups platforms into Available and Unavailable and explains an unavailable one", async () => {
  await renderDialog();
  const available = within(screen.getByRole("group", { name: "Available" }));
  const unavailable = within(screen.getByRole("group", { name: "Unavailable" }));
  expect(available.getAllByRole("button").map((button) => button.textContent)).toEqual(["Web"]);
  expect(unavailable.getAllByRole("button").map((button) => button.textContent)).toEqual(["Windows", "Linux", "macOS", "Android", "iOS"]);

  fireEvent.click(screen.getByTestId("packaging-target-android"));
  const detail = within(screen.getByTestId("packaging-detail"));
  expect(detail.getByText("Android packaging is not available on this device.")).toBeTruthy();
  fireEvent.click(screen.getByTestId("packaging-target-windows"));
  // A build without the players (development builds) says so instead.
  expect(detail.getByText("This copy of Haptic does not include the Windows player.")).toBeTruthy();
  expect(screen.queryByTestId("packaging-summary")).toBeNull();
  expect(screen.getByTestId("packaging-package").hasAttribute("disabled")).toBe(true);
  expect(screen.getByTestId("packaging-target-web").getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(screen.getByTestId("packaging-target-web"));
  expect(screen.getByTestId("packaging-package").hasAttribute("disabled")).toBe(false);
});

it.each([
  [null, "Not Set"],
  ["scene-deleted", "Missing"],
])("keeps Package unavailable while the Startup Scene is %s and links to Game settings", async (guid, shown) => {
  project.startupSceneGuid = guid;
  const { onOpenProjectSettings } = await renderDialog();
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
  await renderDialog();
  fireEvent.click(screen.getByTestId("packaging-package"));
  expect(screen.getByTestId("packaging-package").textContent).toBe("Packaging…");
  expect(screen.getByTestId("packaging-package").hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("progressbar")).toBeTruthy();

  await act(async () => { reject(new Error("zip failed")); });

  expect(screen.getByTestId("packaging-error").textContent).toBe("Could not build the zip. Try again.");
  expect(screen.getByTestId("packaging-package").hasAttribute("disabled")).toBe(false);
  expect(screen.queryByRole("progressbar")).toBeNull();
});

it("opens the export settings that decide what a package includes", async () => {
  const { onOpenProjectSettings } = await renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "Export Settings" }));
  expect(onOpenProjectSettings).toHaveBeenCalledWith("export");
  expect(exportGameArtifact).not.toHaveBeenCalled();
});

it("packages a Windows game from the build's player and saves it named after the project", async () => {
  shells.manifest = SHELLS;
  const runtime = zipSync({ "electron.exe": strToU8("exe"), "resources/default_app.asar": strToU8("sample") });
  shells.loadDesktopShell.mockResolvedValue({ runtime, host: strToU8("host();") });
  exportGameArtifact.mockResolvedValue(ok({ files: new Map([["index.html", strToU8("<html>")]]) }));
  let saved: Blob | null = null;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => { saved = blob as Blob; return "blob:game"; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const downloads: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
  await renderDialog();
  const available = within(screen.getByRole("group", { name: "Available" }));
  expect(available.getAllByRole("button").map((button) => button.textContent)).toEqual(["Web", "Windows", "Linux"]);

  fireEvent.click(screen.getByTestId("packaging-target-windows"));
  expect(screen.getByTestId("packaging-output").textContent).toBe("Harbour_Run-Windows.zip");
  await act(async () => { fireEvent.click(screen.getByTestId("packaging-package")); });

  expect(shells.loadDesktopShell).toHaveBeenCalledExactlyOnceWith(SHELLS, "windows-x64");
  expect(downloads).toEqual(["Harbour_Run-Windows.zip"]);
  // jsdom's Blob has no arrayBuffer(); FileReader reads it.
  const bytes = await new Promise<ArrayBuffer>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(saved!);
  });
  const files = unzipSync(new Uint8Array(bytes));
  expect(Object.keys(files).sort()).toEqual([
    "Harbour Run/Harbour Run.exe",
    "Harbour Run/resources/app/main.cjs",
    "Harbour Run/resources/app/package.json",
    "Harbour Run/resources/game/index.html",
  ]);
  expect(JSON.parse(new TextDecoder().decode(files["Harbour Run/resources/app/package.json"]!)).hapticGameId).toBe("harbour-guid");
  expect(screen.getByText("Windows game downloaded. Check your downloads.")).toBeTruthy();
  expect(zipExportedGame).not.toHaveBeenCalled();
});

it("reports a damaged player instead of saving a package", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  shells.manifest = SHELLS;
  shells.loadDesktopShell.mockRejectedValue(new Error("The Linux player in this copy of Haptic is damaged. Reload or reinstall Haptic."));
  exportGameArtifact.mockResolvedValue(ok({ files: new Map() }));
  const downloads = captureDownloads();
  await renderDialog();
  fireEvent.click(screen.getByTestId("packaging-target-linux"));
  await act(async () => { fireEvent.click(screen.getByTestId("packaging-package")); });

  expect(screen.getByTestId("packaging-error").textContent).toBe("The Linux player in this copy of Haptic is damaged. Reload or reinstall Haptic.");
  expect(downloads).toEqual([]);
});

it("packages a Linux game as a Debian package by default, or as a ZIP when chosen", async () => {
  shells.manifest = SHELLS;
  shells.loadDesktopShell.mockResolvedValue({ runtime: zipSync({ electron: strToU8("binary"), "chrome-sandbox": strToU8("sandbox") }), host: strToU8("host();") });
  exportGameArtifact.mockResolvedValue(ok({ files: new Map([["index.html", strToU8("<html>")]]) }));
  const saved: { name: string; type: string }[] = [];
  let blob: Blob | null = null;
  vi.spyOn(URL, "createObjectURL").mockImplementation((value) => { blob = value as Blob; return "blob:game"; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push({ name: this.download, type: blob!.type }); });
  await renderDialog();
  fireEvent.click(screen.getByTestId("packaging-target-linux"));
  expect(screen.getByTestId("packaging-output").textContent).toBe("Harbour_Run-Linux.deb");
  await act(async () => { fireEvent.click(screen.getByTestId("packaging-package")); });
  // The Debian packager loads on first use.
  expect(await screen.findByText("Linux package downloaded. Check your downloads.")).toBeTruthy();

  fireEvent.click(screen.getByTestId("packaging-linux-zip"));
  expect(screen.getByTestId("packaging-output").textContent).toBe("Harbour_Run-Linux.zip");
  await act(async () => { fireEvent.click(screen.getByTestId("packaging-package")); });
  expect(await screen.findByText("Linux game downloaded. Check your downloads.")).toBeTruthy();

  expect(saved).toEqual([
    { name: "Harbour_Run-Linux.deb", type: "application/vnd.debian.binary-package" },
    { name: "Harbour_Run-Linux.zip", type: "application/zip" },
  ]);
  expect(await screen.findByText("Linux game downloaded. Check your downloads.")).toBeTruthy();
});
