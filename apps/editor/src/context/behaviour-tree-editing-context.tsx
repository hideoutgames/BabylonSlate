import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { asTree } from "../lib/behaviour-tree-graph-commit";
import { useNodeSelection } from "../lib/node-selection";
import { useDocumentActions } from "./document-context";
import { useDocumentWorkspace } from "./document-workspace-context";

export type BehaviourTreeAttachmentCatalog = "decorator" | "service";

export interface BehaviourTreeEditingContextValue {
  /** Every selected node; Details shows the properties they share. */
  selectedIds: readonly string[];
  /** The first selected node: the parent for added nodes, and the owner of the selected attachment. */
  selectedId: string | null;
  attachmentId: string | null;
  attachmentCatalog: BehaviourTreeAttachmentCatalog | null;
  focusedNodeId: string | null;
  setSelectedIds: (ids: readonly string[]) => void;
  setSelectedId: (id: string | null) => void;
  setAttachmentId: Dispatch<SetStateAction<string | null>>;
  setAttachmentCatalog: Dispatch<
    SetStateAction<BehaviourTreeAttachmentCatalog | null>
  >;
  focusNode: (nodeId: string) => void;
}

const BehaviourTreeEditingContext =
  createContext<BehaviourTreeEditingContextValue | null>(null);

export function BehaviourTreeEditingProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { documentId } = useDocumentWorkspace();
  const { getOpenDocuments } = useDocumentActions();
  // Only the first selection reads the tree, so read it once instead of
  // subscribing to every edit of the document.
  const {
    selectedNodeIds: selectedIds,
    selectedNodeId: selectedId,
    setSelectedNodeIds: setSelectedIds,
    setSelectedNodeId: setSelectedId,
  } = useNodeSelection(() => {
    const content = getOpenDocuments().find((doc) => doc.id === documentId)?.content;
    const rootId = asTree(
      content && typeof content === "object"
        ? (content as Record<string, unknown>)
        : {},
    ).rootId;
    return rootId ? [rootId] : [];
  });
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [attachmentCatalog, setAttachmentCatalog] =
    useState<BehaviourTreeAttachmentCatalog | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  const value = useMemo<BehaviourTreeEditingContextValue>(
    () => ({
      selectedIds,
      selectedId,
      attachmentId,
      attachmentCatalog,
      focusedNodeId,
      setSelectedIds,
      setSelectedId,
      setAttachmentId,
      setAttachmentCatalog,
      focusNode: (nodeId: string) => {
        setSelectedId(nodeId);
        setAttachmentId(null);
        setFocusedNodeId(nodeId);
      },
    }),
    [attachmentCatalog, attachmentId, focusedNodeId, selectedId, selectedIds, setSelectedId, setSelectedIds],
  );

  return (
    <BehaviourTreeEditingContext.Provider value={value}>
      {children}
    </BehaviourTreeEditingContext.Provider>
  );
}

/* eslint-disable react-refresh/only-export-components -- context module */
export function useBehaviourTreeEditing(): BehaviourTreeEditingContextValue {
  const context = useContext(BehaviourTreeEditingContext);
  if (!context) {
    throw new Error(
      "useBehaviourTreeEditing must be used within BehaviourTreeEditingProvider",
    );
  }
  return context;
}
/* eslint-enable react-refresh/only-export-components */
