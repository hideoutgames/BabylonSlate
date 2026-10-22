import { createContext, useContext } from "react";
import type { NavigateRequest } from "./graph-types";
import type { PinTypeRef } from "./node-theme";
import type { NestedMenuItem } from "@haptic/editor-kit";
import type { PinDefaultEditorRenderer } from "./pin-default-editor-context";
import type { PinTypeNames } from "./pin-default-preview";
import type { ConnectEndMode, PinCompatibilityRule } from "./graph-connect";
import type { GraphRunTrace } from "./run-trace";

export type GraphEditorContextValue = {
  renderPinDefaultEditor?: PinDefaultEditorRenderer;
  connectedInputs?: ReadonlyMap<string, readonly string[]>;
  renderNodeBody?: (nodeId: string, data: Record<string, unknown>) => React.ReactNode;
  pendingPin: { nodeId: string; pinId: string } | null;
  onPinDefaultChange?: (nodeId: string, pinId: string, value: unknown) => void;
  onPinTap: (nodeId: string, pinId: string, direction: "in" | "out") => void;
  nodeErrorCount: (nodeId: string) => number;
  pinHasError: (nodeId: string, pinId: string) => boolean;
  pinDisplayType: (nodeId: string, pinId: string) => PinTypeRef | undefined;
  pinTypeNames?: PinTypeNames;
  connectEndMode: ConnectEndMode;
  pinCompatibility?: PinCompatibilityRule;
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
  /** What the running owner of the graph reports; nodes with a live status read theirs from it. */
  runTrace?: GraphRunTrace;
  /**
   * Context menu of script-style nodes: Copy, Paste, Duplicate, Delete and
   * Break Links plus the host's items. `resolve` first applies the selection
   * rule (a menu on an unselected node replaces the selection) and returns the
   * items for the resulting selection.
   */
  nodeMenu?: {
    enabled: boolean;
    resolve: (nodeId: string) => NestedMenuItem[];
  };
  /**
   * Why a wire dragged from one pin cannot land on another, or null when it
   * can (or the reason is unknown). Read only while the wire hovers a pin.
   */
  connectionRefusal?: (
    from: { nodeId: string; pinId: string },
    to: { nodeId: string; pinId: string },
  ) => string | null;
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
