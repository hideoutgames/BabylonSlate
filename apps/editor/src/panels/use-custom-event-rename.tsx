import { useCallback } from "react";
import { useDocumentActions } from "../context/document-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { EVENT_GRAPH_PANEL_ID } from "../shell/function-graph-panels";

/**
 * Rename Event from outside the graph (the Inspector): asks the Event Graph to open the custom
 * event node's inline header rename, and brings the Event Graph forward, or opens it when closed.
 * The graph itself starts the rename directly (`GraphPanel`).
 */
export function useCustomEventRename(): (nodeId: string) => void {
  const { activateDockPanel, isDockWindowOpen, toggleDockWindow } = useDocumentActions();
  const { requestEventRename } = useGraphEditing();
  return useCallback((nodeId: string) => {
    requestEventRename(nodeId);
    if (isDockWindowOpen(EVENT_GRAPH_PANEL_ID)) activateDockPanel(EVENT_GRAPH_PANEL_ID);
    else toggleDockWindow(EVENT_GRAPH_PANEL_ID);
  }, [activateDockPanel, isDockWindowOpen, requestEventRename, toggleDockWindow]);
}
