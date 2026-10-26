import { useState } from "react";
import { isErr, type ProjectDocument } from "@haptic/core";
import { useDocumentActions } from "../context/document-context";
import { projectArchiveDownloadName } from "../lib/display-project-name";
import { downloadZipArchive } from "../lib/download";
import { exportGameFailureMessage } from "../lib/export-game-failure";

/** Export Project and Export Game run state shown by Project Settings → Export. */
export interface ProjectExport {
  exportGameError: string | null;
  exportGameBusy: boolean;
  exportProjectBusy: boolean;
  exportProjectError: string | null;
  exportNotice: string | null;
  handleExport: () => Promise<void>;
  handleExportGame: () => Promise<void>;
}

/**
 * The Settings modal calls this, not the Export section, so a running export
 * and its notice survive category switches. `projectDocument` is the modal's
 * draft-merged document, so exports include staged rendering edits.
 */
export function useProjectExport(projectDocument: ProjectDocument | null): ProjectExport {
  const { exportProject, exportGameArtifact, zipExportedGame } = useDocumentActions();
  const [exportGameError, setExportGameError] = useState<string | null>(null);
  const [exportGameBusy, setExportGameBusy] = useState(false);
  const [exportProjectBusy, setExportProjectBusy] = useState(false);
  const [exportProjectError, setExportProjectError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const handleExport = async () => {
    if (!projectDocument || exportProjectBusy) return;
    setExportProjectBusy(true);
    setExportProjectError(null);
    setExportNotice(null);
    try {
      const bytes = await exportProject(projectDocument);
      downloadZipArchive(bytes, projectArchiveDownloadName(projectDocument.metadata.name));
      setExportNotice("Project backup prepared. Check your downloads.");
    } catch (error) {
      setExportProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setExportProjectBusy(false);
    }
  };

  const handleExportGame = async () => {
    if (!projectDocument) return;
    setExportGameBusy(true);
    setExportGameError(null);
    setExportNotice(null);
    try {
      const result = await exportGameArtifact({ projectSnapshot: projectDocument });
      if (isErr(result)) {
        setExportGameError(exportGameFailureMessage(result.error));
        return;
      }
      downloadZipArchive(
        zipExportedGame(result.value),
        `${projectDocument.metadata.name.replace(/\s+/g, "_")}.zip`,
      );
      setExportNotice("Game export prepared. Check your downloads.");
    } catch (error) {
      console.error("[editor] Export Game failed", error);
      setExportGameError(exportGameFailureMessage(error));
    } finally {
      setExportGameBusy(false);
    }
  };

  return {
    exportGameError,
    exportGameBusy,
    exportProjectBusy,
    exportProjectError,
    exportNotice,
    handleExport,
    handleExportGame,
  };
}
