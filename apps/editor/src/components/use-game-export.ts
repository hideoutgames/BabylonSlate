import { useEffect, useState } from "react";
import { isErr, type ProjectDocument } from "@haptic/core";
import type { DesktopGameTarget } from "@haptic/exporter/native-desktop";
import { useDocumentActions } from "../context/document-context";
import { saveExportFile, saveZipArchive, savedFileNotice } from "../lib/file-export";
import { exportGameFailureMessage } from "../lib/export-game-failure";
import { loadDesktopShell, loadGameShellManifest, packageableDesktopTargets, type GameShellManifest } from "../lib/game-shells";
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
  packageTarget: (target: PackagingTarget, options?: { linuxFormat?: LinuxPackageFormat }) => Promise<void>;
}

/** The saved web package's file name. */
export function gameArchiveName(projectName: string): string {
  return `${projectName.replace(/\s+/g, "_")}.zip`;
}

/** The players this copy of Haptic carries, read once `active` turns on. */
export function useGameShells(active: boolean): { manifest: GameShellManifest | null; desktop: ReadonlySet<DesktopGameTarget> } {
  const [state, setState] = useState<{ manifest: GameShellManifest | null; desktop: ReadonlySet<DesktopGameTarget> } | null>(null);
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

  const packageTarget = async (target: PackagingTarget, packageOptions: { linuxFormat?: LinuxPackageFormat } = {}) => {
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
      if (!target.desktopTarget) {
        const archive = await zipExportedGame(result.value);
        setNotice(savedFileNotice("Game package", await saveZipArchive(archive, gameArchiveName(projectDocument.metadata.name))));
        return;
      }
      if (!options.manifest) throw new Error(`This copy of Haptic cannot package ${target.label} games.`);
      setStage(`Adding the ${target.label} player.`);
      const shell = await loadDesktopShell(options.manifest, target.desktopTarget);
      const input = {
        target: target.desktopTarget,
        ...shell,
        game: result.value.files,
        name: projectDocument.metadata.name,
        version: projectDocument.metadata.version,
        gameId: options.projectGuid ?? "game",
      };
      if (target.desktopTarget === "linux-x64" && (packageOptions.linuxFormat ?? "deb") === "deb") {
        const { packageLinuxDeb } = await import("@haptic/exporter/native-deb");
        const packaged = packageLinuxDeb(input);
        setNotice(savedFileNotice("Linux package", await saveExportFile(packaged.bytes, packaged.fileName, "application/vnd.debian.binary-package")));
        return;
      }
      const { packageDesktopGame } = await import("@haptic/exporter/native-desktop");
      const packaged = packageDesktopGame(input);
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
