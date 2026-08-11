import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { SerializedGraph } from "@babylonslate/core";
import {
  diffGraphCommands,
  type DocumentEditStackOptions,
} from "@babylonslate/edit";
import { defaultEngineSettings } from "@babylonslate/vfs";
import { useDocuments } from "./document-context";
import {
  DEFAULT_EDIT_BYTE_BUDGET,
  type EditService,
} from "../services/edit-service";

interface EditContextValue {
  applyGraphCommands: (
    docId: string,
    before: SerializedGraph,
    after: SerializedGraph,
  ) => void;
  undoActiveDocument: () => void;
  redoActiveDocument: () => void;
  canUndoActiveDocument: boolean;
  canRedoActiveDocument: boolean;
}

const EditServiceContext = createContext<EditService | null>(null);
const EditContext = createContext<EditContextValue | null>(null);

export function EditServiceProvider({
  editService,
  children,
}: {
  editService: EditService;
  children: ReactNode;
}) {
  return (
    <EditServiceContext.Provider value={editService}>
      <EditProvider>{children}</EditProvider>
    </EditServiceContext.Provider>
  );
}

export function EditProvider({ children }: { children: ReactNode }) {
  const editService = useContext(EditServiceContext);
  if (!editService) {
    throw new Error("EditProvider requires EditServiceProvider");
  }

  const {
    activeDocumentId,
    openDocuments,
    updateGraph,
  } = useDocuments();

  const stackOptions = useMemo<Partial<DocumentEditStackOptions>>(
    () => ({
      maxEntries: defaultEngineSettings().undoHistoryLength,
      maxBytes: DEFAULT_EDIT_BYTE_BUDGET,
    }),
    [],
  );

  const activeDoc = openDocuments.find((doc) => doc.id === activeDocumentId);

  const applyGraphCommands = useCallback(
    (docId: string, before: SerializedGraph, after: SerializedGraph) => {
      const commands = diffGraphCommands(before, after);
      if (commands.length === 0) {
        return;
      }
      const next = editService.applyGraphCommands(
        docId,
        before,
        commands,
        stackOptions,
      );
      updateGraph(docId, next);
    },
    [editService, stackOptions, updateGraph],
  );

  const undoActiveDocument = useCallback(() => {
    if (!activeDoc?.content || activeDoc.ref.kind !== "graph") {
      return;
    }
    const result = editService.undoDocument(activeDoc.id, activeDoc.content);
    if (!result) {
      return;
    }
    updateGraph(activeDoc.id, result as SerializedGraph);
  }, [activeDoc, editService, updateGraph]);

  const redoActiveDocument = useCallback(() => {
    if (!activeDoc?.content || activeDoc.ref.kind !== "graph") {
      return;
    }
    const result = editService.redoDocument(activeDoc.id, activeDoc.content);
    if (!result) {
      return;
    }
    updateGraph(activeDoc.id, result as SerializedGraph);
  }, [activeDoc, editService, updateGraph]);

  const canUndoActiveDocument =
    activeDocumentId !== null && editService.canUndo(activeDocumentId);
  const canRedoActiveDocument =
    activeDocumentId !== null && editService.canRedo(activeDocumentId);

  const value = useMemo<EditContextValue>(
    () => ({
      applyGraphCommands,
      undoActiveDocument,
      redoActiveDocument,
      canUndoActiveDocument,
      canRedoActiveDocument,
    }),
    [
      applyGraphCommands,
      undoActiveDocument,
      redoActiveDocument,
      canUndoActiveDocument,
      canRedoActiveDocument,
    ],
  );

  return (
    <EditContext.Provider value={value}>{children}</EditContext.Provider>
  );
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useEdit(): EditContextValue {
  const context = useContext(EditContext);
  if (!context) {
    throw new Error("useEdit must be used within EditProvider");
  }
  return context;
}
/* eslint-enable react-refresh/only-export-components */
