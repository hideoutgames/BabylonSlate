import { useState } from "react";
import type { ProjectDocument } from "@haptic/core";
import { useDocumentActions } from "../context/document-context";
import { projectArchiveDownloadName } from "../lib/display-project-name";
import { saveZipArchive, savedFileNotice } from "../lib/file-export";

/** Export Project run state shown by Project Settings → Export → Project Backup. */
export interface ProjectExport {
  exportProjectBusy: boolean;
  exportProjectError: string | null;
  exportNotice: string | null;
  handleExport: () => Promise<void>;
}

/**
 * The Settings modal calls this, not the Export section, so a running export
 * and its notice survive category switches. `projectDocument` is the modal's
 * draft-merged document, so exports include staged rendering edits.
 */
export function useProjectExport(projectDocument: ProjectDocument | null): ProjectExport {
  const { exportProject } = useDocumentActions();
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
      const saved = await saveZipArchive(bytes, projectArchiveDownloadName(projectDocument.metadata.name));
      setExportNotice(savedFileNotice("Project backup", saved));
    } catch (error) {
      setExportProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setExportProjectBusy(false);
    }
  };

  return { exportProjectBusy, exportProjectError, exportNotice, handleExport };
}
