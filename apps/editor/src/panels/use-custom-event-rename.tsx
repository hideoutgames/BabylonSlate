import { useCallback, useState, type ReactNode } from "react";
import { formatEventMemberName, NamePromptDialog } from "@haptic/editor-kit";
import { isAnimGraphDocumentKind, type SerializedGraph } from "@haptic/core";
import { useDocumentActions } from "../context/document-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { CLASS_PANEL_ID } from "../shell/function-graph-panels";
import { customEventRenameError, renameCustomEvent } from "../lib/class-members";

/**
 * Rename Event for a custom event node. In a Class or Script document the
 * event's Class panel row opens its inline rename, as a new event's does; the
 * panel comes forward, or opens when closed. Animation Graphs have no Class
 * panel, so `dialog` prompts for the name there.
 */
export function useCustomEventRename({
  graph,
  documentKind,
  classId,
  commit,
}: {
  graph: SerializedGraph | null | undefined;
  documentKind: string | undefined;
  classId: string | undefined;
  commit: (next: SerializedGraph) => void;
}): { start: (nodeId: string) => void; dialog: ReactNode } {
  const { activateDockPanel, isDockWindowOpen, toggleDockWindow } = useDocumentActions();
  const { requestEventRename } = useGraphEditing();
  const [promptId, setPromptId] = useState<string | null>(null);
  const inline = !isAnimGraphDocumentKind(documentKind);
  const start = useCallback((nodeId: string) => {
    if (!inline) {
      setPromptId(nodeId);
      return;
    }
    requestEventRename(nodeId);
    if (isDockWindowOpen(CLASS_PANEL_ID)) activateDockPanel(CLASS_PANEL_ID);
    else toggleDockWindow(CLASS_PANEL_ID);
  }, [activateDockPanel, inline, isDockWindowOpen, requestEventRename, toggleDockWindow]);
  if (inline) return { start, dialog: null };
  const node = promptId ? graph?.nodes.find((entry) => entry.id === promptId) : undefined;
  const dialog = (
    <NamePromptDialog
      open={promptId !== null}
      onOpenChange={(open) => { if (!open) setPromptId(null); }}
      title="Rename Event"
      label="Event Name"
      confirmLabel="Rename"
      initialValue={formatEventMemberName(String(node?.data.name ?? node?.data.title ?? ""))}
      validate={(name) => graph && promptId ? customEventRenameError(graph, promptId, name) : null}
      onSubmit={(name) => {
        if (graph && promptId) commit(renameCustomEvent(graph, promptId, name, classId));
      }}
    />
  );
  return { start, dialog };
}
