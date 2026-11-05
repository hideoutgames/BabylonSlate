import { useState } from "react";
import { isErr, type ProjectDocument } from "@haptic/core";
import { useDocumentActions } from "../context/document-context";
import { saveZipArchive, savedFileNotice } from "../lib/file-export";
import { exportGameFailureMessage } from "../lib/export-game-failure";

/** Web packaging run state shown by the Packaging dialog. */
export interface GameExport {
  busy: boolean;
  error: string | null;
  notice: string | null;
  packageWeb: () => Promise<void>;
}

/** The saved web package's file name. */
export function gameArchiveName(projectName: string): string {
  return `${projectName.replace(/\s+/g, "_")}.zip`;
}

/** Packages the project as a playable web ZIP and saves it. */
export function useGameExport(projectDocument: ProjectDocument | null): GameExport {
  const { exportGameArtifact, zipExportedGame } = useDocumentActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const packageWeb = async () => {
    if (!projectDocument || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await exportGameArtifact({ projectSnapshot: projectDocument });
      if (isErr(result)) {
        setError(exportGameFailureMessage(result.error));
        return;
      }
      const archive = await zipExportedGame(result.value);
      setNotice(savedFileNotice("Game package", await saveZipArchive(archive, gameArchiveName(projectDocument.metadata.name))));
    } catch (cause) {
      console.error("[editor] Packaging failed", cause);
      setError(exportGameFailureMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, notice, packageWeb };
}
