import { isAssetDocumentKind, PROJECT_FILE } from "@haptic/core";
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
import { journalDiscardLine, type EditSession } from "@haptic/edit";
import { readProjectJsonMtime } from "../lib/external-change";
import type { JournalBuffer } from "../lib/journal-buffer";
import type { ProjectSaveState } from "../lib/project-save-state";
import { editorTabContentForKind } from "../lib/scene-layer-document";
import type { DocumentService, OpenDocument } from "../services/document-service";
import type { ProjectService } from "../services/project-service";
import type { SourceControlService } from "../services/source-control-service";
import type { AuthoringHold, DocumentActions } from "./document-context-types";

/** A time no file has: the previous time of a file a pull wrote, so it always classifies as changed. */
const PULLED_MTIME = -1;

/** Open documents read from disk, not yet in their tabs. */
interface OpenDocumentReads {
  contents: { id: string; content: NonNullable<OpenDocument["content"]> }[];
  /** Paths whose file is gone: their tabs close. */
  deleted: string[];
  /** Paths that could not be read: their tabs keep their content. */
  failed: string[];
}

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
  /** A remount here only re-read the files: the foreground refresh or the pull reads the Integrated status itself. */
  noteRegistryReread: () => void;
  /** Lock On Edit asks or locks again on the next edit of a file changed outside the editor. */
  sourceControlRef: RefObject<SourceControlService>;
  /** A reloaded document's earlier edits leave crash recovery. */
  journalBuffer: JournalBuffer;
}

/** Every path a classification found changed, added, deleted or reaching an open document. */
function classifiedPaths(result: ExternalChangeClassification): string[] {
  return [...result.changedPaths, ...result.dirtyChangedPaths, ...result.cleanChangedPaths];
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
  noteRegistryReread,
  sourceControlRef,
  journalBuffer,
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
   * Reads the open documents of `paths` from disk without changing anything:
   * the content of each, the ones whose file was deleted, the ones that could
   * not be read.
   */
  const readOpenDocuments = useCallback(
    async (paths: readonly string[]): Promise<OpenDocumentReads> => {
      const reads: OpenDocumentReads = { contents: [], deleted: [], failed: [] };
      for (const path of paths) {
        const doc = [...documentService.getState().openDocuments.values()].find(
          (entry) => entry.ref.path === path,
        );
        if (!doc || !isAssetDocumentKind(doc.ref.kind)) continue;
        try {
          const loaded = await projectService.loadDocument(doc.ref.kind, doc.ref.path);
          reads.contents.push({ id: doc.id, content: editorTabContentForKind(doc.ref.kind, loaded) as NonNullable<typeof doc.content> });
        } catch (error) {
          if (!(await projectService.documentExists(path).catch(() => true))) {
            reads.deleted.push(path);
            continue;
          }
          console.warn(`[editor] Could not reload ${path} from disk`, error);
          reads.failed.push(path);
        }
      }
      return reads;
    },
    [documentService, projectService],
  );

  /**
   * Puts what `readOpenDocuments` read into the tabs, in one synchronous
   * step: each loses its history and its crash-recovery records (replaying
   * them would bring discarded edits back onto the file's content), and a tab
   * whose file was deleted closes, as reloading it has nothing to load.
   */
  const applyOpenDocuments = useCallback(
    (reads: OpenDocumentReads) => {
      const guid = projectService.guid;
      const at = new Date().toISOString();
      for (const { id, content } of reads.contents) {
        documentService.replaceLoadedContent(id, content);
        editSessionRef.current.dropDocument(id);
        if (guid) journalBuffer.append(guid, journalDiscardLine(id, at));
      }
      if (reads.contents.length > 0) void journalBuffer.flush();
      if (reads.deleted.length > 0) closeDocumentsForPathsRef.current(reads.deleted);
      bump();
    },
    [bump, closeDocumentsForPathsRef, documentService, editSessionRef, journalBuffer, projectService],
  );

  /**
   * Returns the paths whose file could not be read; their tabs keep their
   * content. Null, and nothing changes, while documents are read-only or when
   * an authoring lease starts or ends meanwhile.
   */
  const reloadDocumentsFromDisk = useCallback(
    async (paths: string[]): Promise<string[] | null> => {
      const authoring = documentService.getAuthoringLock();
      if (authoring.readOnly) return null;
      const reads = await readOpenDocuments(paths);
      if (documentService.getAuthoringLock() !== authoring) return null;
      applyOpenDocuments(reads);
      return reads.failed;
    },
    [applyOpenDocuments, documentService, readOpenDocuments],
  );

  const discardDocumentChanges = useCallback(async (paths: string[]) => {
    const failed = await reloadDocumentsFromDisk(paths);
    return failed !== null && failed.length === 0;
  }, [reloadDocumentsFromDisk]);

  const runForegroundRescan = useCallback(async () => {
    if (!projectDocumentRef.current) return;
    const guid = projectService.guid;
    const previous = mtimeSnapshotRef.current;
    await projectService.remountRegistry();
    noteRegistryReread();
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
        .filter((doc) => isAssetDocumentKind(doc.ref.kind))
        .map((doc) => ({ path: doc.ref.path, dirty: doc.dirty }));
      const result = classifyExternalChanges({
        previousAssets: previous.assets,
        nextAssets,
        previousProjectJsonMtime: previous.projectJson,
        nextProjectJsonMtime: nextProject,
        openDocs,
      });
      sourceControlRef.current.filesChanged(classifiedPaths(result));
      if (result.kind !== "none") {
        setExternalChangePrompt(result);
      }
    }
    next.projectJson = nextProject;
  }, [bump, documentService, noteRegistryReread, projectService, projectDocumentRef, sourceControlRef]);
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
      .filter((doc) => isAssetDocumentKind(doc.ref.kind))
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
      const failed = await reloadDocumentsFromDisk(paths) ?? [];
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

  /**
   * After a pull that wrote `paths`, while `hold` (the pull's read-only lock)
   * keeps Play, Simulation and edits out: classifies what changed against the
   * change snapshot, as the foreground rescan does, and reads the project or
   * the clean changed documents. Then, in one synchronous step, it releases
   * the hold and applies them, so nothing runs against a half-reloaded
   * project. A document with unsaved edits is never replaced: a changed one
   * gets the external-change prompt, and a project reload (a changed
   * `project.json`, many changes) runs only while no document or Project
   * Settings is unsaved, else it is left to the prompt too. If another lock
   * arrived meanwhile nothing is applied and the snapshot stays, so the next
   * foreground rescan reports it.
   */
  const applyPulledChanges = useCallback(async (paths: readonly string[], hold: AuthoringHold) => {
    try {
      // Pulled, switched or reverted files: their next edit asks or locks again.
      sourceControlRef.current.filesChanged(paths);
      const previous = mtimeSnapshotRef.current;
      if (!projectDocumentRef.current || !previous || paths.length === 0) return;
      await projectService.remountRegistry();
      // The pull already read the status after writing these files.
      noteRegistryReread();
      bump();
      const nextAssets = snapshotIndexedMtimes(projectService.registry?.list() ?? []);
      const nextProject = await readProjectJsonMtime(projectService.storagePort);
      const openDocs = documentService
        .getOpenDocumentsOrdered()
        .filter((doc) => isAssetDocumentKind(doc.ref.kind))
        .map((doc) => ({ path: doc.ref.path, dirty: doc.dirty }));
      // The files the pull wrote count as changed even when the snapshot already has their times
      // (a foreground rescan during a long pull, or a write within the clock's resolution).
      const previousAssets = { ...previous.assets };
      for (const path of paths) {
        if (path.endsWith(".hasset") && previousAssets[path] === nextAssets[path]) previousAssets[path] = PULLED_MTIME;
      }
      const result = classifyExternalChanges({
        previousAssets,
        nextAssets,
        previousProjectJsonMtime: paths.includes(PROJECT_FILE) && previous.projectJson === nextProject ? PULLED_MTIME : previous.projectJson,
        nextProjectJsonMtime: nextProject,
        openDocs,
      });
      // A project reload replaces every open document and the project's settings, so it runs only
      // while nothing is unsaved; otherwise it is the user's call, as are unsaved edits a change reaches.
      const unsaved = openDocs.some((doc) => doc.dirty) || projectSaveState.current.isDirty(projectDocumentRef.current);
      const reloadProject = result.kind === "reload-project" && !unsaved;
      const project = reloadProject ? (await projectService.loadCurrentProject()).document : null;
      const reads = await readOpenDocuments(reloadProject ? openDocs.map((doc) => doc.path) : result.cleanChangedPaths);
      if (documentService.getAuthoringLock() !== hold.lock) return;
      hold.release();
      if (project) {
        projectSaveState.current.reset(project);
        setProjectDocument(project);
      }
      applyOpenDocuments(reads);
      // A document that could not be read keeps its old time, so the next rescan offers it again.
      for (const path of reads.failed) if (path in previous.assets) nextAssets[path] = previous.assets[path] ?? null;
      mtimeSnapshotRef.current = { assets: nextAssets, projectJson: nextProject };
      // The snapshot has moved on, so the next rescan will not report these again: ask now.
      if (result.dirtyChangedPaths.length > 0 || (result.kind === "reload-project" && !reloadProject)) setExternalChangePrompt(result);
    } finally {
      hold.release();
    }
  }, [applyOpenDocuments, bump, documentService, noteRegistryReread, projectDocumentRef, projectSaveState, projectService, readOpenDocuments, setProjectDocument, sourceControlRef]);

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
      | "discardDocumentChanges"
    > => ({
      confirmExternalChangeReloadProject,
      confirmExternalChangeReloadDocs,
      dismissExternalChange,
      discardDocumentChanges,
    }),
    [
      confirmExternalChangeReloadProject,
      confirmExternalChangeReloadDocs,
      dismissExternalChange,
      discardDocumentChanges,
    ],
  );

  return {
    externalChangePrompt,
    captureMtimeSnapshot,
    runForegroundRescanRef,
    resetExternalChanges,
    applyPulledChanges,
    actions,
  };
}
