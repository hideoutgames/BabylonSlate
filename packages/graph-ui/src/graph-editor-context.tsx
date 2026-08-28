import { createContext, useContext } from "react";
import type { NavigateRequest } from "./graph-types";
import type { PinTypeRef } from "./node-theme";
import type { NestedMenuItem } from "@babylonslate/editor-kit";
import type { PinTypeNames } from "./pin-default-preview";
import type { ConnectEndMode } from "./graph-connect";

export type GraphEditorContextValue = {
  pendingPin: { nodeId: string; pinId: string } | null;
  onPinTap: (nodeId: string, pinId: string, direction: "in" | "out") => void;
  nodeErrorCount: (nodeId: string) => number;
  pinHasError: (nodeId: string, pinId: string) => boolean;
  pinDisplayType: (nodeId: string, pinId: string) => PinTypeRef | undefined;
  pinTypeNames?: PinTypeNames;
  connectEndMode: ConnectEndMode;
  onNavigateRequest?: (request: NavigateRequest) => void;
  selectedAttachmentId?: string | null;
  onAttachmentSelect?: (id: string | null) => void;
  onAttachmentDoubleClick?: (nodeId: string, attachmentId: string) => void;
  contextMenuItemsForNode?: (nodeId: string) => NestedMenuItem[];
  contextMenuItemsForAttachment?: (
    nodeId: string,
    attachmentId: string,
  ) => NestedMenuItem[];
  onEdgeDoubleClick?: (edgeId: string) => void;
  connectionLineKind?: "default" | "animTransition";
};

const GraphEditorContext = createContext<GraphEditorContextValue | null>(null);

export function GraphEditorProvider({
  value,
  children,
}: {
  value: GraphEditorContextValue;
  children: React.ReactNode;
}) {
  return (
    <GraphEditorContext.Provider value={value}>
      {children}
    </GraphEditorContext.Provider>
  );
}

export function useGraphEditorContext(): GraphEditorContextValue {
  const ctx = useContext(GraphEditorContext);
  if (!ctx) {
    throw new Error("useGraphEditorContext must be used within GraphEditorProvider");
  }
  return ctx;
}
