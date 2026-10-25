import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { DocumentRef, ProjectStorage } from "@haptic/core";
import {
  ASSET_DOCUMENT_KINDS,
  createDocumentRef,
  documentId,
  isAssetDocumentKind,
  isSceneWorkspaceKind,
} from "@haptic/core";
import { listTraceDocuments, newAssetGuid, pruneTraceDocuments } from "@haptic/assets";
import { journalDiscardLine, type EditSession } from "@haptic/edit";
import type { TracePayload } from "@haptic/debugger";
import { waitForSceneLoadingPaint } from "../lib/scene-viewport-load";
import type { JournalBuffer } from "../lib/journal-buffer";
import { dirtyScenesBlockingOpen } from "../lib/exclusive-scene";
import { documentContentIdentity } from "../lib/document-content-identity";
import {
  recordedTraceFileName,
  spillRecordedTraceDocument,
} from "../lib/play-trace-spill";
import {
  EDITOR_UTILITY_EVENTS,
  emitEditorUtilityLifecycle,
} from "../lib/editor-utility-scripts";
import type { DocumentEditingService } from "../services/document-editing-service";
import type { DocumentService } from "../services/document-service";
import type { DocumentTransitionGate } from "../services/document-transition-gate";
import type { ProjectService } from "../services/project-service";
import type { SourceControlService } from "../services/source-control-service";
import type { DocumentActions } from "./document-context-types";
import { useRefState } from "./use-ref-state";

export interface DocumentTabDeps {
  documentService: DocumentService;
  projectService: ProjectService;
  documentTransitions: DocumentTransitionGate;
  editSessionRef: RefObject<EditSession>;
  journalBuffer: JournalBuffer;
  sourceControlRef: RefObject<SourceControlService>;
  ensureDerived: () => Promise<ProjectStorage>;
  editing: DocumentEditingService;
  /** Save All the user asked for, for an exclusive Scene open's Save choice. */
  saveAll: () => Promise<boolean>;
  /** Re-derives the document context value. */
  bump: () => void;
  captureLayoutForId: (id: string) => void;
  forgetDockLayouts: (id: string) => void;
  /** The provider's Loading Document slot. */
  sceneDocumentLoadRef: RefObject<AbortController | null>;
  setSceneDocumentLoad: (load: { ref: DocumentRef; failed: boolean; error?: unknown } | null) => void;
  cancelSceneDocumentLoad: () => void;
  setDocumentOpenError: (error: string | null) => void;
  /** Read by the external-change reload, which is set up before this hook. */
  closeDocumentsForPathsRef: RefObject<(paths: Iterable<string>) => void>;
}

/**
 * Opening, activating, reordering and closing document tabs, including an
 * exclusive Scene open that waits for Save or Discard. Every callback keeps
 * its identity for the provider's lifetime.
 */
export function useDocumentTabs({
  documentService,
  projectService,
  documentTransitions,
  editSessionRef,
  journalBuffer,
  sourceControlRef,
  ensureDerived,
  editing,
  saveAll,
  bump,
  captureLayoutForId,
  forgetDockLayouts,
  sceneDocumentLoadRef,
  setSceneDocumentLoad,
  cancelSceneDocumentLoad,
  setDocumentOpenError,
  closeDocumentsForPathsRef,
}: DocumentTabDeps) {
  const pendingExclusiveSceneRef = useRef<DocumentRef | null>(null);
  const [pendingExclusiveScene, setPendingExclusiveScene] = useRefState(
    pendingExclusiveSceneRef,
  );
  const exclusiveSceneRequest = useRef(0);
  /** The latest tab activation the user asked for; an earlier, slower open does not take focus from it. */
  const activationRequest = useRef(0);

  const performCloseDocument = useCallback(
    (id: string) => {
      documentService.assertDocumentCanClose(id);
      const doc = documentService.getDocument(id);
      const guid = projectService.guid;
      if (doc && doc.ref.kind !== "content-browser" && guid) {
        journalBuffer.append(guid, journalDiscardLine(id, new Date().toISOString()));
      }
      forgetDockLayouts(id);
      documentService.closeDocument(id);
      if (doc?.content && !doc.dirty) {
        // Saved content: a reopen that loads the same content resumes Undo.
        const content = doc.content;
        editSessionRef.current.closeDocument(id, () =>
          documentContentIdentity(content),
        );
      } else {
        // Closing with unsaved edits discards them (the Discard choice), and
        // their history only fits the discarded content.
        editSessionRef.current.dropDocument(id);
      }
      void journalBuffer.flush();
      bump();
    },
    [
      bump,
      documentService,
      forgetDockLayouts,
      journalBuffer,
      projectService,
      editSessionRef,
    ],
  );

  const closeDocument = useCallback((id: string): void => {
    const allowed = documentTransitions.check({ kind: "close-document", documentId: id });
    if (typeof allowed === "boolean") {
      if (allowed) performCloseDocument(id);
    } else {
      void allowed.then(result => { if (result) performCloseDocument(id); })
        .catch(error => { console.error("[editor] document close was refused", error); });
    }
  }, [documentTransitions, performCloseDocument]);

  const closeDocumentsForPaths = useCallback(
    (paths: Iterable<string>) => {
      documentService.assertAuthoringWritable();
      const pathSet = paths instanceof Set ? paths : new Set(paths);
      // The assets are being deleted: their history, open or kept from a
      // closed tab, must not reach a new asset created at the same path.
      for (const path of pathSet) {
        for (const kind of ASSET_DOCUMENT_KINDS) {
          editSessionRef.current.dropDocument(documentId({ kind, path }));
        }
      }
      const ids: string[] = [];
      for (const doc of documentService.getOpenDocumentsOrdered()) {
        if (doc.ref.kind === "content-browser") continue;
        if (pathSet.has(doc.ref.path)) ids.push(doc.id);
      }
      for (const id of ids) performCloseDocument(id);
    },
    [performCloseDocument, documentService, editSessionRef],
  );
  useLayoutEffect(() => {
    closeDocumentsForPathsRef.current = closeDocumentsForPaths;
  }, [closeDocumentsForPaths, closeDocumentsForPathsRef]);

  /**
   * Opening a Scene closes every other open Scene. Each one it replaces goes
   * through the gate, so a session playing or simulating it stops first.
   */
  const checkSceneReplacement = useCallback((ref: DocumentRef): boolean | Promise<boolean> => {
    const nextId = documentId(ref);
    const replaced = documentService.getOpenDocumentsOrdered()
      .filter((doc) => doc.ref.kind === "scene" && doc.id !== nextId);
    const next = (index: number): boolean | Promise<boolean> => {
      for (let cursor = index; cursor < replaced.length; cursor++) {
        const allowed = documentTransitions.check({ kind: "replace-document", documentId: replaced[cursor]!.id });
        if (allowed === false) return false;
        if (allowed !== true) return allowed.then((ok) => ok && next(cursor + 1));
      }
      return true;
    };
    return next(0);
  }, [documentService, documentTransitions]);

  /** `discardDirtyScenes`: the user chose Discard, so replaced Scenes close even when dirty. */
  const finishOpenDocument = useCallback(
    async (ref: DocumentRef, options?: { discardDirtyScenes?: boolean }) => {
      // Taken before the session gate's wait, so a tab picked during it stays active.
      const request = ++activationRequest.current;
      if (ref.kind === "scene" && !documentService.getDocument(documentId(ref))) {
        const allowed = checkSceneReplacement(ref);
        if (allowed === false || (typeof allowed !== "boolean" && !await allowed)) return;
        // A stopped session can leave a replaced Scene dirty (Simulation's
        // Keep Changes); ask to Save or Discard it instead of closing it.
        if (!options?.discardDirtyScenes &&
          dirtyScenesBlockingOpen(documentService.getDirtyDocuments(), documentId(ref)).length > 0) {
          setPendingExclusiveScene(ref);
          return;
        }
      }
      const controller = isSceneWorkspaceKind(ref.kind) ? new AbortController() : null;
      if (controller) {
        cancelSceneDocumentLoad();
        sceneDocumentLoadRef.current = controller;
      }
      const { activeDocumentId } = documentService.getState();
      if (activeDocumentId) {
        captureLayoutForId(activeDocumentId);
      }
      const layouts = documentService.buildLayouts();
      const layout = layouts.documents[documentId(ref)] ?? null;
      try {
        await documentService.openDocument(projectService, ref, layout, () => activationRequest.current === request, controller ? {
          signal: controller.signal,
          beforeLoad: async () => {
            setSceneDocumentLoad({ ref, failed: false });
            await waitForSceneLoadingPaint(controller.signal);
          },
          beforeCommit: () => {
            if (ref.kind !== "scene") return;
            // Keep the old scene and its edit session until replacement I/O succeeds.
            const nextId = documentId(ref);
            const others = documentService.getOpenDocumentsOrdered()
              .filter((doc) => doc.ref.kind === "scene" && doc.id !== nextId);
            for (const other of others) performCloseDocument(other.id);
          },
        } : undefined);
      } catch (error) {
        if (controller?.signal.aborted) return;
        if (!controller) throw error;
        console.error("[editor] failed to open scene document", error);
        setSceneDocumentLoad({ ref, failed: true, error });
        return;
      }
      if (controller?.signal.aborted) return;
      if (controller && sceneDocumentLoadRef.current === controller) {
        sceneDocumentLoadRef.current = null;
        setSceneDocumentLoad(null);
      }
      if (ref.kind === "scene") {
        emitEditorUtilityLifecycle(EDITOR_UTILITY_EVENTS.sceneOpen);
      }
      sourceControlRef.current.onOpenDocument(ref.path);
      bump();
      if (ref.kind === "scene") {
        await editing.syncPrefabInstances({ quiet: true });
      }
    },
    [bump, captureLayoutForId, checkSceneReplacement, editing, performCloseDocument, documentService, projectService, cancelSceneDocumentLoad, setPendingExclusiveScene, sceneDocumentLoadRef, setSceneDocumentLoad, sourceControlRef],
  );

  const ensureAssetDocument = useCallback(async (ref: DocumentRef): Promise<string> => {
    if (!isAssetDocumentKind(ref.kind) || isSceneWorkspaceKind(ref.kind)) {
      throw new Error("Only non-scene asset documents can be opened in the background.");
    }
    const layouts = documentService.buildLayouts();
    const id = await documentService.openDocument(
      projectService, ref, layouts.documents[documentId(ref)] ?? null, false, { background: true },
    );
    sourceControlRef.current.onOpenDocument(ref.path);
    bump();
    return id;
  }, [bump, documentService, projectService, sourceControlRef]);

  const openDocument = useCallback(
    async (ref: DocumentRef) => {
      if (ref.kind === "scene") {
        exclusiveSceneRequest.current += 1;
        const blocking = dirtyScenesBlockingOpen(
          documentService.getDirtyDocuments(),
          documentId(ref),
        );
        if (blocking.length > 0) {
          // The session gate runs once the user chooses Save or Discard, so
          // Cancel leaves a running session untouched.
          setPendingExclusiveScene(ref);
          return;
        }
      }
      // A Scene's replace-document gate runs in finishOpenDocument.
      await finishOpenDocument(ref);
    },
    [documentService, finishOpenDocument, setPendingExclusiveScene],
  );

  const openRecordedTrace = useCallback(
    async (payload: TracePayload, options: { keep?: number } = {}) => {
      const guid = projectService.guid;
      if (!guid) return;
      const derived = await ensureDerived();
      projectService.setDerivedStorage(derived);
      const fileName = recordedTraceFileName(Date.now());
      const spilled = await spillRecordedTraceDocument({
        derivedStorage: derived,
        projectGuid: guid,
        payload,
        fileName,
        documentGuid: newAssetGuid(),
      });
      await finishOpenDocument(spilled.ref);
      if (options.keep === undefined) return;
      const open = new Set(
        [...documentService.getState().openDocuments.values()]
          .flatMap((document) => (document.ref.kind === "trace" ? [document.ref.path] : [])),
      );
      open.add(spilled.path);
      await pruneTraceDocuments(derived, guid, options.keep, open);
    },
    [documentService, ensureDerived, finishOpenDocument, projectService],
  );

  const listRecentTraces = useCallback(async () => {
    const guid = projectService.guid;
    return guid ? listTraceDocuments(await ensureDerived(), guid) : [];
  }, [ensureDerived, projectService]);

  const openTraceDocument = useCallback(
    async (path: string) => {
      // A Trace tab reads its document from the derived storage.
      projectService.setDerivedStorage(await ensureDerived());
      await finishOpenDocument(createDocumentRef("trace", path));
    },
    [ensureDerived, finishOpenDocument, projectService],
  );

  const confirmExclusiveSceneOpen = useCallback(
    async (mode: "save" | "discard") => {
      // Written by openDocument's setter, so a request made earlier in the
      // same event is already visible here.
      const ref = pendingExclusiveSceneRef.current;
      if (!ref) return;
      // Cancel, or a newer open request, while the gate or Save awaits ends this one.
      const request = exclusiveSceneRequest.current;
      const allowed = checkSceneReplacement(ref);
      if (allowed === false || (typeof allowed !== "boolean" && !await allowed)) return;
      if (request !== exclusiveSceneRequest.current) return;
      if (mode === "save") {
        const saved = await saveAll();
        if (!saved || request !== exclusiveSceneRequest.current ||
          dirtyScenesBlockingOpen(documentService.getDirtyDocuments(), documentId(ref)).length > 0) return;
      }
      setPendingExclusiveScene(null);
      await finishOpenDocument(ref, { discardDirtyScenes: mode === "discard" });
    },
    [checkSceneReplacement, documentService, finishOpenDocument, saveAll, setPendingExclusiveScene],
  );

  const cancelExclusiveSceneOpen = useCallback(() => {
    exclusiveSceneRequest.current += 1;
    setPendingExclusiveScene(null);
  }, [setPendingExclusiveScene]);

  const setActiveDocument = useCallback(
    (id: string) => {
      activationRequest.current += 1;
      const { activeDocumentId } = documentService.getState();
      if (id === activeDocumentId) return;
      const target = documentService.getState().openDocuments.get(id);
      if (target?.content === null && target.ref.kind !== "content-browser") {
        // A restored tab reads its asset when first selected. Callers do not
        // wait for it, so a failed read is reported here.
        finishOpenDocument(target.ref).catch((error: unknown) => {
          // Cancelled, not failed: closing the tab aborts its read, and closing
          // the project ends ProjectService's read session first, so a read
          // still running then rejects as aborted too. Matched by name: some
          // readers cancel with an Error named AbortError, and an abort
          // reason need not be this window's DOMException.
          if ((error as { name?: unknown } | null)?.name === "AbortError") return;
          console.error("[editor] failed to open document", error);
          setDocumentOpenError(error instanceof Error ? error.message : String(error));
        });
        return;
      }
      if (activeDocumentId) {
        captureLayoutForId(activeDocumentId);
      }
      documentService.setActiveDocument(id);
      bump();
    },
    [bump, captureLayoutForId, documentService, finishOpenDocument, setDocumentOpenError],
  );

  const reorderClosableTabs = useCallback(
    (fromIndex: number, toIndex: number) => {
      documentService.reorderClosableTabs(fromIndex, toIndex);
      bump();
    },
    [bump, documentService],
  );

  const reorderTabs = useCallback(
    (fromIndex: number, toIndex: number) => {
      documentService.reorderTabs(fromIndex, toIndex);
      bump();
    },
    [bump, documentService],
  );

  const actions = useMemo(
    (): Pick<
      DocumentActions,
      | "openDocument"
      | "ensureAssetDocument"
      | "openRecordedTrace"
      | "listRecentTraces"
      | "openTraceDocument"
      | "confirmExclusiveSceneOpen"
      | "cancelExclusiveSceneOpen"
      | "closeDocument"
      | "closeDocumentsForPaths"
      | "setActiveDocument"
      | "reorderTabs"
      | "reorderClosableTabs"
    > => ({
      openDocument,
      ensureAssetDocument,
      openRecordedTrace,
      listRecentTraces,
      openTraceDocument,
      confirmExclusiveSceneOpen,
      cancelExclusiveSceneOpen,
      closeDocument,
      closeDocumentsForPaths,
      setActiveDocument,
      reorderTabs,
      reorderClosableTabs,
    }),
    [
      openDocument,
      ensureAssetDocument,
      openRecordedTrace,
      listRecentTraces,
      openTraceDocument,
      confirmExclusiveSceneOpen,
      cancelExclusiveSceneOpen,
      closeDocument,
      closeDocumentsForPaths,
      setActiveDocument,
      reorderTabs,
      reorderClosableTabs,
    ],
  );

  return {
    pendingExclusiveScene,
    finishOpenDocument,
    cancelExclusiveSceneOpen,
    actions,
  };
}
