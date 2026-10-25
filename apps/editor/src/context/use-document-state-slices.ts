import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { DocumentRef } from "@haptic/core";
import type { EditSession } from "@haptic/edit";
import { parseSceneDocumentLayout } from "../shell/scene-document-layout";
import type { AnimEditorMode } from "../shell/anim-document-layout";
import {
  dockviewApiKey,
} from "../shell/dockview-surface";
import type { DocumentService, OpenDocument } from "../services/document-service";
import type { ActiveDocumentState } from "./document-context-types";
import { DocumentSubscriptions, sameDocumentRef } from "./document-subscriptions";
import { animEditorModeForDocument } from "./use-document-dock-layouts";

export interface DocumentStateSliceDeps {
  documentService: DocumentService;
  editSessionRef: RefObject<EditSession>;
  animEditorModes: Record<string, AnimEditorMode>;
  focusedLayoutIds: Set<string>;
}

/**
 * The open-document state each provider render reads from DocumentService:
 * revisions, tab order, open and dirty documents, the narrow subscriptions
 * and the active-document slice. Call it after every other provider hook:
 * its layout effect publishes to the subscriptions last in each commit.
 */
export function useDocumentStateSlices({
  documentService,
  editSessionRef,
  animEditorModes,
  focusedLayoutIds,
}: DocumentStateSliceDeps) {
  // Every service mutation is followed by a context update, so reading the
  // revisions on each provider render sees the latest ones.
  const documentRevisions = documentService.getRevisions();
  const tabsRevision = documentService.getTabsRevision();
  const tabOrderRef = useRef<string[]>([]);
  const tabOrder = useMemo(() => {
    void tabsRevision;
    const next = documentService.getState().tabOrder;
    const previous = tabOrderRef.current;
    // Switching tabs advances the tabs revision without moving any tab.
    if (
      previous.length === next.length &&
      previous.every((id, index) => id === next[index])
    ) {
      return previous;
    }
    const copy = [...next];
    tabOrderRef.current = copy;
    return copy;
  }, [documentService, tabsRevision]);
  // Entries are mutated in place, so these follow the revisions rather than
  // entry identity; registry-only and other unrelated updates keep them.
  const openDocuments = useMemo(() => {
    void documentRevisions;
    void tabOrder;
    return documentService.getOpenDocumentsOrdered();
  }, [documentRevisions, documentService, tabOrder]);
  const dirtyDocuments = useMemo(() => {
    void documentRevisions;
    return documentService.getDirtyDocuments();
  }, [documentRevisions, documentService]);
  // The save slice keeps its list while the same documents, with the same
  // labels, are dirty: a second edit of a dirty document does not change it.
  const stableDirtyRef = useRef<{ list: OpenDocument[]; refs: DocumentRef[] }>({ list: [], refs: [] });
  const stableDirtyDocuments = useMemo(() => {
    const previous = stableDirtyRef.current;
    if (
      previous.list.length === dirtyDocuments.length &&
      dirtyDocuments.every((doc, index) => doc === previous.list[index] && sameDocumentRef(doc.ref, previous.refs[index]))
    ) {
      return previous.list;
    }
    stableDirtyRef.current = { list: dirtyDocuments, refs: dirtyDocuments.map((doc) => doc.ref) };
    return dirtyDocuments;
  }, [dirtyDocuments]);

  // Narrow subscriptions: per-document hooks read the service through this
  // store, and every commit (each service mutation is followed by one) lets
  // them compare their snapshots in the same frame as the provider's facade.
  const subscriptions = useMemo(() => new DocumentSubscriptions(documentService), [documentService]);
  useLayoutEffect(() => {
    subscriptions.publish();
  });

  // Service state read on each render: every service mutation is followed by
  // a context update. The slice below changes only when its fields do.
  const activeId = documentService.getState().activeDocumentId;
  const activeDoc = activeId ? documentService.getDocument(activeId) : undefined;
  const activeStack = activeId ? editSessionRef.current.getStack(activeId) : null;
  const authoringReadOnly = documentService.getAuthoringLock().readOnly;
  const sceneMode = parseSceneDocumentLayout(activeDoc?.layout).sceneMode;
  const focusKey =
    activeId && activeDoc?.ref.kind === "scene"
      ? dockviewApiKey(activeId, sceneMode)
      : activeId;
  const animEditorMode = activeId
    ? animEditorModeForDocument(activeId, animEditorModes, activeDoc)
    : "stateMachine";
  const isLayoutFocused = focusKey ? focusedLayoutIds.has(focusKey) : false;
  const canUndoActiveDocument = !authoringReadOnly && (activeStack?.canUndo ?? false);
  const canRedoActiveDocument = !authoringReadOnly && (activeStack?.canRedo ?? false);
  const activeDocumentState = useMemo<ActiveDocumentState>(
    () => ({
      activeDocumentId: activeId,
      animEditorMode,
      sceneMode,
      isLayoutFocused,
      canUndoActiveDocument,
      canRedoActiveDocument,
    }),
    [activeId, animEditorMode, sceneMode, isLayoutFocused, canUndoActiveDocument, canRedoActiveDocument],
  );

  return {
    documentRevisions,
    tabsRevision,
    tabOrder,
    openDocuments,
    dirtyDocuments,
    stableDirtyDocuments,
    subscriptions,
    activeDocumentState,
  };
}
