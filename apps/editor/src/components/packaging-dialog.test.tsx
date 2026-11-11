import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ok } from "@haptic/core";
import { encodeIcns } from "@haptic/exporter/app-icon";
import { strToU8, unzipSync, zipSync } from "fflate";
import { appIconImages } from "../../../../packages/exporter/src/test-support/app-icon-images";
import { defaultEngineSettings } from "@haptic/vfs";
import { MemoryAppSettingsStore } from "../../../../packages/vfs/src/test-support/memory-app-settings";
import { AppSettingsProvider } from "../context/app-settings-context";
import type { GameShellManifest } from "../lib/game-shells";
import { PackagingDialog } from "./packaging-dialog";

const { exportGameArtifact, zipExportedGame, project, shells } = vi.hoisted(() => ({
  exportGameArtifact: vi.fn(),
  zipExportedGame: vi.fn(),
  project: { startupSceneGuid: "scene-main" as string | null, iconTextureGuid: null as string | null },
  shells: { manifest: null as GameShellManifest | null, loadDesktopShell: vi.fn() },
}));

// Canvas drawing is the browser's: the preview is whatever it draws from the source.
vi.mock("../lib/app-icon", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/app-icon")>(),
  renderAppIconPreview: async (source: Blob) => source,
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
  const icon = { header: { guid: "tex-icon", name: "T_AppIcon", type: "Texture", payload: { width: 1024, height: 1024 }, chunks: [{ id: "pixels", kind: "pixels", mime: "image/png" }] }, path: "assets/T_AppIcon.hasset" };
  const assets = new Map<string, unknown>([[scene.header.guid, scene], [icon.header.guid, icon]]);
  return (await import("../testing/document-context-mock")).documentContextMock(() => {
    const projectDocument = createEmptyProject("Harbour Run");
    projectDocument.settings.startupSceneGuid = project.startupSceneGuid;
    projectDocument.settings.appIdentity.iconTextureGuid = project.iconTextureGuid;
    projectDocument.settings.alwaysPackageFolders = ["assets/Audio", "assets/Localization"];
    return {
      projectDocument,
      projectGuid: "harbour-guid",
      assetRegistry: { list: () => [scene], getByGuid: (guid: string) => assets.get(guid) },
      readAssetChunk: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
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
  project.iconTextureGuid = null;
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
  // The web package gets the web game's platform directives and modules.
  expect(exportGameArtifact.mock.calls[0]![0].platform).toBe("web");
  expect(zipExportedGame).toHaveBeenCalledWith(artifact);
  expect(downloads).toEqual(["Harbour_Run.zip"]);
  expect(screen.getByText("Game package downloaded. Check your downloads.")).toBeTruthy();
});

it("shows the App Icon in each platform's shape, with the platform as a badge, or the platform mark without one", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:icon");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  await renderDialog();
  expect(screen.queryByTestId("packaging-app-icon")).toBeNull();
  expect(screen.getByTestId("packaging-app-icon-name").textContent).toBe("Not Set");
  cleanup();

  project.iconTextureGuid = "tex-icon";
  await renderDialog();
  const tile = await screen.findByTestId("packaging-app-icon");
  expect(tile.querySelector("img")!.getAttribute("src")).toBe("blob:icon");
  expect(tile.querySelector("[data-shape]")!.getAttribute("data-shape")).toBe("square");
  expect(screen.getByTestId("packaging-app-icon-name").textContent).toBe("T_AppIcon");
  (globalThis as { haptic?: unknown }).haptic = { gameShell: { platform: "linux", arch: "x64", runtime: vi.fn(), packageAndroid: vi.fn(), androidSettings: vi.fn(async () => ({ java: null, sdk: null, keystore: null, alias: "", toolchain: { javaHome: "/jdk", javaVersion: 21, sdk: "/sdk", problems: [] } })) } };
  try {
    cleanup();
    await renderDialog();
    await act(async () => { fireEvent.click(screen.getByTestId("packaging-target-android")); });
    expect((await screen.findByTestId("packaging-app-icon")).querySelector("[data-shape]")!.getAttribute("data-shape")).toBe("android");
  } finally {
    delete (globalThis as { haptic?: unknown }).haptic;
  }
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
  expect(within(summary().getByText("Startup Scene").parentElement!).getByText(shown)).toBeTruthy();
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
  // The Windows packager loads on first use.
  expect(await screen.findByText("Windows game downloaded. Check your downloads.")).toBeTruthy();

  expect(shells.loadDesktopShell).toHaveBeenCalledExactlyOnceWith(SHELLS, "windows-x64");
  // A Windows package is exported with the Windows game's platform directives and modules.
  expect(exportGameArtifact.mock.calls.at(-1)![0].platform).toBe("windows");
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

it("packages a macOS game through the Mac desktop app with the project's identity and this Mac's signing", async () => {
  shells.manifest = { ...SHELLS, shells: [...SHELLS.shells, { target: "macos-arm64", sha256: "3".repeat(64), size: 10, source: "bundled", parts: ["electron-macos-arm64.zip.000"] }] };
  const packageMac = vi.fn(async () => ({ fileName: "Harbour_Run-macOS.zip", bytes: new Uint8Array([1, 2]), notarized: false }));
  (globalThis as { haptic?: unknown }).haptic = { gameShell: { platform: "darwin", arch: "arm64", runtime: vi.fn(), macIdentities: vi.fn(async () => []), packageMac } };
  exportGameArtifact.mockResolvedValue(ok({ files: new Map([["index.html", strToU8("<html>")]]) }));
  const downloads = captureDownloads();
  try {
    await renderDialog();
    fireEvent.click(screen.getByTestId("packaging-target-macos"));
    expect(screen.getByTestId("packaging-output").textContent).toBe("Harbour_Run-macOS.zip");
    // No App ID set: the placeholder is used and flagged.
    expect(screen.getByTestId("packaging-app-id").textContent).toBe("com.example.harbourrun");
    expect(screen.getByTestId("packaging-app-id-placeholder")).toBeTruthy();
    expect(screen.getByTestId("packaging-mac-signing").textContent).toBe("Ad-Hoc (This Mac Only)");
    expect(screen.getByTestId("packaging-mac-notarization").textContent).toBe("Off");

    await act(async () => { fireEvent.click(screen.getByTestId("packaging-package")); });

    expect(packageMac).toHaveBeenCalledExactlyOnceWith({
      game: [["index.html", strToU8("<html>")]],
      name: "Harbour Run", appId: "com.example.harbourrun", version: "1.0.0", buildNumber: 1,
      gameId: "harbour-guid", icon: null, identity: null, notaryProfile: "",
    });
    expect(downloads).toEqual(["Harbour_Run-macOS.zip"]);
    expect(screen.getByText("macOS game downloaded. Check your downloads.")).toBeTruthy();

    // With an App Icon, the app receives it as an ICNS.
    const appIcon = appIconImages();
    exportGameArtifact.mockResolvedValue(ok({ files: new Map([["index.html", strToU8("<html>")]]), appIcon }));
    await act(async () => { fireEvent.click(screen.getByTestId("packaging-package")); });
    expect(packageMac).toHaveBeenLastCalledWith(expect.objectContaining({ icon: encodeIcns(appIcon) }));
  } finally {
    delete (globalThis as { haptic?: unknown }).haptic;
  }
});

/** The desktop app's Android packaging, with this computer's settings and what they find. */
function androidApp(status: { keystore: string | null; alias: string; problems: string[] }) {
  const packageAndroid = vi.fn(async () => ({ fileName: "Harbour_Run-Android.aab", bytes: new Uint8Array([5]), debugSigned: status.keystore === null }));
  const androidSettings = vi.fn(async () => ({
    java: null, sdk: null, keystore: status.keystore, alias: status.alias,
    toolchain: status.problems.length ? { javaHome: null, javaVersion: null, sdk: null, problems: status.problems } : { javaHome: "/jdk", javaVersion: 21, sdk: "/sdk", problems: [] },
  }));
  (globalThis as { haptic?: unknown }).haptic = { gameShell: { platform: "linux", arch: "x64", runtime: vi.fn(), macIdentities: vi.fn(), packageMac: vi.fn(), androidSettings, packageAndroid } };
  return { packageAndroid, androidSettings };
}

it("packages an Android game in the desktop app in the chosen format, with the App Icon at the launcher sizes", async () => {
  const { packageAndroid } = androidApp({ keystore: null, alias: "", problems: [] });
  const appIcon = appIconImages();
  exportGameArtifact.mockResolvedValue(ok({ files: new Map([["index.html", strToU8("<html>")]]), appIcon }));
  const downloads = captureDownloads();
  try {
    await renderDialog();
    expect(within(screen.getByRole("group", { name: "Available" })).getByText("Android")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId("packaging-target-android")); });
    expect(screen.getByTestId("packaging-output").textContent).toBe("Harbour_Run-Android.apk");
    expect(screen.getByTestId("packaging-android-signing").textContent).toBe("Debug Key (Testing Only)");
    expect(screen.getByTestId("packaging-android-toolchain").textContent).toBe("Java 21, Android SDK");
    fireEvent.click(screen.getByTestId("packaging-android-aab"));
    expect(screen.getByTestId("packaging-output").textContent).toBe("Harbour_Run-Android.aab");

    await act(async () => { fireEvent.click(screen.getByTestId("packaging-package")); });

    expect(exportGameArtifact.mock.calls.at(-1)![0].platform).toBe("android");
    expect(packageAndroid).toHaveBeenCalledExactlyOnceWith({
      game: [["index.html", strToU8("<html>")]],
      name: "Harbour Run", appId: "com.example.harbourrun", version: "1.0.0", buildNumber: 1, format: "aab",
      icon: [48, 72, 96, 108, 144, 192, 216, 288].map((size) => [size, appIcon.get(size)]),
    });
    expect(downloads).toEqual(["Harbour_Run-Android.aab"]);
    expect(screen.getByText("Debug-signed Android game downloaded. Check your downloads.")).toBeTruthy();
  } finally {
    delete (globalThis as { haptic?: unknown }).haptic;
  }
});

it("keeps Android packaging off until the build tools are found, and names the signing key", async () => {
  androidApp({ keystore: "/keys/release.jks", alias: "upload", problems: ["No JDK found. Install Android Studio, or choose the JDK in Engine Settings > Packaging."] });
  try {
    await renderDialog();
    await act(async () => { fireEvent.click(screen.getByTestId("packaging-target-android")); });
    expect(screen.getByTestId("packaging-android-signing").textContent).toBe("upload");
    expect(screen.getByTestId("packaging-android-toolchain").textContent).toBe("Not Found");
    expect(screen.getByTestId("packaging-android-problems").textContent).toContain("No JDK found.");
    expect((screen.getByTestId("packaging-package") as HTMLButtonElement).disabled).toBe(true);
  } finally {
    delete (globalThis as { haptic?: unknown }).haptic;
  }
});

/** The desktop app on a Mac with Xcode ready (or not) and iOS packaging recorded. */
function iosApp(problems: string[] = []) {
  const packageIos = vi.fn(async () => ({ fileName: "Harbour_Run-iOS-Development.ipa", bytes: new Uint8Array([6]) }));
  (globalThis as { haptic?: unknown }).haptic = { gameShell: { platform: "darwin", arch: "arm64", runtime: vi.fn(), macIdentities: vi.fn(async () => []),
    packageMac: vi.fn(), androidSettings: vi.fn(async () => ({ java: null, sdk: null, keystore: null, alias: "", toolchain: { javaHome: null, javaVersion: null, sdk: null, problems: [] } })),
    packageAndroid: vi.fn(), iosToolchain: vi.fn(async () => ({ version: problems.length ? null : "26.6", problems })), packageIos } };
  return { packageIos };
}

it("packages an iOS game on a Mac with this Mac's team, and asks for an App Icon before an App Store package", async () => {
  const { packageIos } = iosApp();
  exportGameArtifact.mockResolvedValue(ok({ files: new Map([["index.html", strToU8("<html>")]]) }));
  const store = new MemoryAppSettingsStore();
  await store.save({ ...defaultEngineSettings(), iosSigning: { teamId: "ABCDE12345" } });
  const downloads = captureDownloads();
  try {
    await act(async () => {
      render(<AppSettingsProvider store={store}><PackagingDialog open onOpenChange={() => {}} onOpenProjectSettings={vi.fn()} /></AppSettingsProvider>);
    });
    await act(async () => { fireEvent.click(screen.getByTestId("packaging-target-ios")); });
    expect(screen.getByTestId("packaging-output").textContent).toBe("Harbour_Run-iOS.ipa");
    expect(screen.getByTestId("packaging-ios-team").textContent).toBe("ABCDE12345");
    expect(screen.getByTestId("packaging-ios-xcode").textContent).toBe("26.6");
    // The project has no App Icon, which the App Store requires.
    expect(screen.getByTestId("packaging-ios-icon-missing")).toBeTruthy();
    expect(screen.getByTestId("packaging-app-icon-name").textContent).toBe("Not Set");
    expect(screen.getByTestId("packaging-app-icon-name").className).toContain("text-(--warning)");
    expect((screen.getByTestId("packaging-package") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("packaging-ios-development"));
    expect(screen.getByTestId("packaging-output").textContent).toBe("Harbour_Run-iOS-Development.ipa");
    expect(screen.queryByTestId("packaging-ios-icon-missing")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId("packaging-package")); });

    expect(exportGameArtifact.mock.calls.at(-1)![0].platform).toBe("ios");
    expect(packageIos).toHaveBeenCalledExactlyOnceWith({
      game: [["index.html", strToU8("<html>")]],
      name: "Harbour Run", appId: "com.example.harbourrun", version: "1.0.0", buildNumber: 1,
      format: "development", icon: null, teamId: "ABCDE12345",
    });
    expect(downloads).toEqual(["Harbour_Run-iOS-Development.ipa"]);
    expect(screen.getByText("Development iOS game downloaded. Check your downloads.")).toBeTruthy();
  } finally {
    delete (globalThis as { haptic?: unknown }).haptic;
  }
});

it("keeps iOS packaging off without a team or a ready Xcode, and offers iOS only on a Mac", async () => {
  iosApp(["Install Xcode from the App Store and open it once to finish setting it up."]);
  try {
    await renderDialog();
    await act(async () => { fireEvent.click(screen.getByTestId("packaging-target-ios")); });
    expect(screen.getByTestId("packaging-ios-team").textContent).toBe("Not Set");
    expect(screen.getByTestId("packaging-ios-team-missing")).toBeTruthy();
    expect(screen.getByTestId("packaging-ios-problems").textContent).toContain("Install Xcode");
    expect((screen.getByTestId("packaging-package") as HTMLButtonElement).disabled).toBe(true);
  } finally {
    delete (globalThis as { haptic?: unknown }).haptic;
  }
  cleanup();
  androidApp({ keystore: null, alias: "", problems: [] });
  try {
    await renderDialog();
    expect(within(screen.getByRole("group", { name: "Unavailable" })).getByText("iOS")).toBeTruthy();
  } finally {
    delete (globalThis as { haptic?: unknown }).haptic;
  }
});

