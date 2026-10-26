import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ProjectDocument } from "@haptic/core";
import {
  applyOwnAssetWrite,
  classifyExternalChanges,
  snapshotIndexedMtimes,
  type ExternalChangeClassification,
} from "@haptic/assets";
import type { EditSession } from "@haptic/edit";
import { readProjectJsonMtime } from "../lib/external-change";
import type { ProjectSaveState } from "../lib/project-save-state";
import { editorTabContentForKind } from "../lib/scene-layer-document";
import type { DocumentService } from "../services/document-service";
import type { ProjectService } from "../services/project-service";
import type { DocumentActions } from "./document-context-types";

export interface ExternalChangeDeps {
  projectService: ProjectService;
  documentService: DocumentService;
  editSessionRef: RefObject<EditSession>;
  projectDocumentRef: RefObject<ProjectDocument | null>;
  projectSaveState: RefObject<ProjectSaveState>;
  setProjectDocument: (document: ProjectDocument | null) => void;
  /** Re-derives the document context value. */
  bump: () => void;
  /** Written by the document tabs hook, which is set up after this one. */
  closeDocumentsForPathsRef: RefObject<(paths: Iterable<string>) => void>;
}

/**
 * Project files changed outside the editor: the indexed mtime snapshot, the
 * foreground rescan that classifies changes against it, and the reload
 * prompt's actions. Every callback keeps its identity for the provider's
 * lifetime.
 */
export function useExternalChanges({
  projectService,
  documentService,
  editSessionRef,
  projectDocumentRef,
  projectSaveState,
  setProjectDocument,
  bump,
  closeDocumentsForPathsRef,
}: ExternalChangeDeps) {
  const [externalChangePrompt, setExternalChangePrompt] =
    useState<ExternalChangeClassification | null>(null);
  const mtimeSnapshotRef = useRef<{
    assets: Record<string, number | null>;
    projectJson: number | null;
  } | null>(null);
  const runForegroundRescanRef = useRef<() => Promise<void>>(async () => {});

  const captureMtimeSnapshot = useCallback(async () => {
    // Installed before the project.json read, so the editor's own writes that
    // land meanwhile fold into this snapshot, not the one it replaces.
    const snapshot = {
      assets: snapshotIndexedMtimes(projectService.registry?.list() ?? []),
      projectJson: mtimeSnapshotRef.current?.projectJson ?? null,
    };
    mtimeSnapshotRef.current = snapshot;
    snapshot.projectJson = await readProjectJsonMtime(projectService.storagePort);
  }, [projectService]);

  // The editor's own Texture encode writes are not external changes.
  useEffect(
    () =>
      projectService.onOwnAssetWrite((write) => {
        const snapshot = mtimeSnapshotRef.current;
        if (snapshot) applyOwnAssetWrite(snapshot.assets, write);
      }),
    [projectService],
  );

  /**
   * Returns the paths whose file could not be read; their tabs keep their
   * content. A tab whose file was deleted on disk closes, as reloading it has
   * nothing to load.
   */
  const reloadDocumentsFromDisk = useCallback(
    async (paths: string[]): Promise<string[]> => {
      const authoring = documentService.getAuthoringLock();
      const failed: string[] = [];
      const deleted: string[] = [];
      if (authoring.readOnly) return failed;
      for (const path of paths) {
        const doc = [...documentService.getState().openDocuments.values()].find(
          (entry) => entry.ref.path === path,
        );
        if (!doc || doc.ref.kind === "content-browser") continue;
        try {
          const loaded = await projectService.loadDocument(
            doc.ref.kind,
            doc.ref.path,
          );
          if (documentService.getAuthoringLock() !== authoring) return failed;
          documentService.replaceLoadedContent(
            doc.id,
            editorTabContentForKind(doc.ref.kind, loaded) as NonNullable<typeof doc.content>,
          );
          editSessionRef.current.dropDocument(doc.id);
        } catch (error) {
          const exists = await projectService.documentExists(path).catch(() => true);
          if (documentService.getAuthoringLock() !== authoring) return failed;
          if (!exists) {
            deleted.push(path);
            continue;
          }
          console.warn(`[editor] Could not reload ${path} from disk`, error);
          failed.push(path);
        }
      }
      if (deleted.length > 0) closeDocumentsForPathsRef.current(deleted);
      bump();
      return failed;
    },
    [bump, documentService, projectService, closeDocumentsForPathsRef, editSessionRef],
  );

  const runForegroundRescan = useCallback(async () => {
    if (!projectDocumentRef.current) return;
    const guid = projectService.guid;
    const previous = mtimeSnapshotRef.current;
    await projectService.remountRegistry();
    bump();
    // Another project, or a snapshot an own save took meanwhile, is newer
    // than this scan: classifying against it would report the wrong changes.
    if (projectService.guid !== guid || mtimeSnapshotRef.current !== previous) return;
    const nextAssets = snapshotIndexedMtimes(
      projectService.registry?.list() ?? [],
    );
    // Installed before the project.json read, so the editor's own writes that
    // land meanwhile fold into it; the scan itself is what gets classified.
    const next = { assets: { ...nextAssets }, projectJson: previous?.projectJson ?? null };
    mtimeSnapshotRef.current = next;
    const nextProject = await readProjectJsonMtime(projectService.storagePort);
    if (projectService.guid !== guid || mtimeSnapshotRef.current !== next) return;
    if (previous) {
      const openDocs = documentService
        .getOpenDocumentsOrdered()
        .filter((doc) => doc.ref.kind !== "content-browser")
        .map((doc) => ({ path: doc.ref.path, dirty: doc.dirty }));
      const result = classifyExternalChanges({
        previousAssets: previous.assets,
        nextAssets,
        previousProjectJsonMtime: previous.projectJson,
        nextProjectJsonMtime: nextProject,
        openDocs,
      });
      if (result.kind !== "none") {
        setExternalChangePrompt(result);
      }
    }
    next.projectJson = nextProject;
  }, [bump, documentService, projectService, projectDocumentRef]);
  useLayoutEffect(() => {
    runForegroundRescanRef.current = runForegroundRescan;
  }, [runForegroundRescan]);

  const confirmExternalChangeReloadProject = useCallback(async () => {
    const authoring = documentService.getAuthoringLock();
    if (authoring.readOnly) return;
    const { document } = await projectService.loadCurrentProject();
    if (documentService.getAuthoringLock() !== authoring) return;
    projectSaveState.current.reset(document);
    setProjectDocument(document);
    const paths = documentService
      .getOpenDocumentsOrdered()
      .filter((doc) => doc.ref.kind !== "content-browser")
      .map((doc) => doc.ref.path);
    await reloadDocumentsFromDisk(paths);
    await captureMtimeSnapshot();
    setExternalChangePrompt(null);
  }, [
    captureMtimeSnapshot,
    documentService,
    projectService,
    reloadDocumentsFromDisk,
    setProjectDocument,
    projectSaveState,
  ]);

  const confirmExternalChangeReloadDocs = useCallback(
    async (paths: string[]) => {
      if (documentService.getAuthoringLock().readOnly) return;
      const failed = await reloadDocumentsFromDisk(paths);
      // The next rescan will not report these files again, so the prompt
      // keeps offering the ones that could not be read.
      const keep = (list: string[]) => list.filter((path) => failed.includes(path));
      setExternalChangePrompt((current) => !current || failed.length === 0 ? null : {
        ...current,
        changedPaths: keep(current.changedPaths),
        dirtyChangedPaths: keep(current.dirtyChangedPaths),
        cleanChangedPaths: keep(current.cleanChangedPaths),
      });
    },
    [documentService, reloadDocumentsFromDisk],
  );

  const dismissExternalChange = useCallback(() => {
    setExternalChangePrompt(null);
  }, []);

  /** Project close: the snapshot and any open reload prompt go with it. */
  const resetExternalChanges = useCallback(() => {
    mtimeSnapshotRef.current = null;
    setExternalChangePrompt(null);
  }, []);

  const actions = useMemo(
    (): Pick<
      DocumentActions,
      | "confirmExternalChangeReloadProject"
      | "confirmExternalChangeReloadDocs"
      | "dismissExternalChange"
    > => ({
      confirmExternalChangeReloadProject,
      confirmExternalChangeReloadDocs,
      dismissExternalChange,
    }),
    [
      confirmExternalChangeReloadProject,
      confirmExternalChangeReloadDocs,
      dismissExternalChange,
    ],
  );

  return {
    externalChangePrompt,
    captureMtimeSnapshot,
    runForegroundRescanRef,
    resetExternalChanges,
    actions,
  };
}
