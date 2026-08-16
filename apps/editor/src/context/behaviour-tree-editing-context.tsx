import {
  createContext,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  createDefaultBehaviourTree,
  parseBehaviourTreeDocument,
} from "@babylonslate/behaviour-tree";
import { useDocuments } from "./document-context";
import { useDocumentWorkspace } from "./document-workspace-context";

export type BehaviourTreeAttachmentCatalog = "decorator" | "service";

export interface BehaviourTreeEditingContextValue {
  selectedId: string | null;
  attachmentId: string | null;
  attachmentCatalog: BehaviourTreeAttachmentCatalog | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setAttachmentId: Dispatch<SetStateAction<string | null>>;
  setAttachmentCatalog: Dispatch<
    SetStateAction<BehaviourTreeAttachmentCatalog | null>
  >;
}

const BehaviourTreeEditingContext =
  createContext<BehaviourTreeEditingContextValue | null>(null);

function asTree(payload: Record<string, unknown>) {
  return parseBehaviourTreeDocument(payload) ?? createDefaultBehaviourTree();
}

export function BehaviourTreeEditingProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const tree = asTree(
    (doc?.content && typeof doc.content === "object"
      ? (doc.content as Record<string, unknown>)
      : {}) as Record<string, unknown>,
  );
  const [selectedId, setSelectedId] = useState<string | null>(tree.rootId);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [attachmentCatalog, setAttachmentCatalog] =
    useState<BehaviourTreeAttachmentCatalog | null>(null);

  const value = useMemo<BehaviourTreeEditingContextValue>(
    () => ({
      selectedId,
      attachmentId,
      attachmentCatalog,
      setSelectedId,
      setAttachmentId,
      setAttachmentCatalog,
    }),
    [attachmentCatalog, attachmentId, selectedId],
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
