import { useEffect, useState } from "react";
import { isErr, resolvedAppIdentity, type ProjectDocument } from "@haptic/core";
import { getElectronGameShellBridge, type EngineSettings } from "@haptic/vfs";
import { ANDROID_ICON_SIZES, type AndroidPackageFormat } from "@haptic/exporter/native-android";
import { useDocumentActions } from "../context/document-context";
import { saveExportFile, saveZipArchive, savedFileNotice } from "../lib/file-export";
import { exportGameFailureMessage } from "../lib/export-game-failure";
import { loadDesktopShell, loadGameShellManifest, packageableDesktopTargets, type GameShellManifest, type GameShellTarget } from "../lib/game-shells";
import type { PackagingTarget } from "../lib/packaging-targets";

/** How a Linux game is delivered: a Debian package that installs it, or a folder in a ZIP. */
export type LinuxPackageFormat = "deb" | "zip";

/** Packaging run state shown by the Packaging dialog. */
export interface GameExport {
  busy: boolean;
  /** What packaging is doing now, while busy. */
  stage: string | null;
  error: string | null;
  notice: string | null;
  packageTarget: (target: PackagingTarget, options?: PackageOptions) => Promise<void>;
}

export interface PackageOptions {
  linuxFormat?: LinuxPackageFormat;
  /** macOS: this computer's signing settings (Engine Settings > Packaging). */
  macSigning?: EngineSettings["macSigning"];
  androidFormat?: AndroidPackageFormat;
}

const ANDROID_TYPES: Record<AndroidPackageFormat, string> = { apk: "application/vnd.android.package-archive", aab: "application/octet-stream" };

/** The saved web package's file name. */
export function gameArchiveName(projectName: string): string {
  return `${projectName.replace(/\s+/g, "_")}.zip`;
}

/** The players this copy of Haptic carries, read once `active` turns on. */
export function useGameShells(active: boolean): { manifest: GameShellManifest | null; desktop: ReadonlySet<GameShellTarget> } {
  const [state, setState] = useState<{ manifest: GameShellManifest | null; desktop: ReadonlySet<GameShellTarget> } | null>(null);
  useEffect(() => {
    if (!active || state) return;
    let current = true;
    void loadGameShellManifest().then((manifest) => {
      if (current) setState({ manifest, desktop: packageableDesktopTargets(manifest) });
    });
    return () => { current = false; };
  }, [active, state]);
  return state ?? { manifest: null, desktop: new Set() };
}

const COLLECTING = "Collecting the assets the game reaches.";

/** Packages the project for a platform and saves the ZIP. */
export function useGameExport(
  projectDocument: ProjectDocument | null,
  options: { manifest: GameShellManifest | null; projectGuid: string | null },
): GameExport {
  const { exportGameArtifact, zipExportedGame } = useDocumentActions();
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const packageTarget = async (target: PackagingTarget, packageOptions: PackageOptions = {}) => {
    if (!projectDocument || busy || !target.available) return;
    setBusy(true);
    setStage(COLLECTING);
    setError(null);
    setNotice(null);
    try {
      const result = await exportGameArtifact({ platform: target.id, projectSnapshot: projectDocument });
      if (isErr(result)) {
        setError(exportGameFailureMessage(result.error));
        return;
      }
      if (target.id === "android") {
        const bridge = getElectronGameShellBridge();
        if (!bridge?.packageAndroid) throw new Error("Android games are packaged in the Haptic desktop app.");
        const identity = resolvedAppIdentity(projectDocument.settings.appIdentity, projectDocument.metadata.name);
        const appIcon = result.value.appIcon;
        setStage("Building with Gradle. The first build downloads Gradle and Android libraries and can take several minutes.");
        const packaged = await bridge.packageAndroid({
          game: [...result.value.files],
          name: identity.displayName,
          appId: identity.appId,
          version: projectDocument.metadata.version,
          buildNumber: identity.buildNumber,
          format: packageOptions.androidFormat ?? "apk",
          icon: appIcon ? ANDROID_ICON_SIZES.map((size) => [size, appIcon.get(size)!]) : null,
        });
        const subject = packaged.debugSigned ? "Debug-signed Android game" : "Android game";
        setNotice(savedFileNotice(subject, await saveExportFile(packaged.bytes, packaged.fileName, ANDROID_TYPES[packageOptions.androidFormat ?? "apk"])));
        return;
      }
      if (!target.desktopTarget) {
        const archive = await zipExportedGame(result.value);
        setNotice(savedFileNotice("Game package", await saveZipArchive(archive, gameArchiveName(projectDocument.metadata.name))));
        return;
      }
      if (!options.manifest) throw new Error(`This copy of Haptic cannot package ${target.label} games.`);
      if (target.desktopTarget === "macos-arm64") {
        const bridge = getElectronGameShellBridge();
        if (!bridge) throw new Error("macOS games are packaged in the Haptic desktop app on a Mac.");
        const identity = resolvedAppIdentity(projectDocument.settings.appIdentity, projectDocument.metadata.name);
        const signing = packageOptions.macSigning ?? { identity: null, notaryProfile: "" };
        const notarize = Boolean(signing.identity && signing.notaryProfile);
        setStage(notarize ? "Signing and notarizing with Apple. This can take several minutes." : "Signing the app.");
        const appIcon = result.value.appIcon;
        const icon = appIcon ? (await import("@haptic/exporter/app-icon")).encodeIcns(appIcon) : null;
        const packaged = await bridge.packageMac({
          game: [...result.value.files],
          name: identity.displayName,
          appId: identity.appId,
          version: projectDocument.metadata.version,
          buildNumber: identity.buildNumber,
          gameId: options.projectGuid ?? "game",
          icon,
          identity: signing.identity,
          notaryProfile: signing.identity ? signing.notaryProfile : "",
        });
        setNotice(savedFileNotice(packaged.notarized ? "Notarized macOS game" : "macOS game", await saveZipArchive(packaged.bytes, packaged.fileName)));
        return;
      }
      setStage(`Adding the ${target.label} player.`);
      const shell = await loadDesktopShell(options.manifest, target.desktopTarget);
      const input = {
        target: target.desktopTarget,
        ...shell,
        game: result.value.files,
        name: projectDocument.metadata.name,
        version: projectDocument.metadata.version,
        gameId: options.projectGuid ?? "game",
        ...(result.value.appIcon ? { icon: result.value.appIcon } : {}),
      };
      if (target.desktopTarget === "linux-x64" && (packageOptions.linuxFormat ?? "deb") === "deb") {
        const { packageLinuxDeb } = await import("@haptic/exporter/native-deb");
        const packaged = packageLinuxDeb(input);
        setNotice(savedFileNotice("Linux package", await saveExportFile(packaged.bytes, packaged.fileName, "application/vnd.debian.binary-package")));
        return;
      }
      if (target.desktopTarget === "windows-x64" && input.icon) setStage("Adding the App Icon to the Windows executable.");
      // Windows writes the App Icon into the executable; elsewhere the window shows the export's icon.png.
      const packaged = target.desktopTarget === "windows-x64"
        ? (await import("@haptic/exporter/native-windows")).packageWindowsGame(input)
        : (await import("@haptic/exporter/native-desktop")).packageDesktopGame(input);
      setNotice(savedFileNotice(`${target.label} game`, await saveZipArchive(packaged.bytes, packaged.fileName)));
    } catch (cause) {
      console.error("[editor] Packaging failed", cause);
      setError(exportGameFailureMessage(cause));
    } finally {
      setBusy(false);
      setStage(null);
    }
  };

  return { busy, stage, error, notice, packageTarget };
}
