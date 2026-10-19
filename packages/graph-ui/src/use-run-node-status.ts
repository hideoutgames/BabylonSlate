import { useCallback, useSyncExternalStore } from "react";
import { useGraphEditorContext } from "./graph-editor-context";

const noStatus = () => undefined;
const unsubscribed = () => {};

/**
 * A node's live status from the canvas's `runTrace`, for nodes that show one. Only the node whose
 * status changed renders again, so a run never re-renders the canvas.
 */
export function useRunNodeStatus(nodeId: string): string | undefined {
  const { runTrace } = useGraphEditorContext();
  const subscribe = useCallback(
    (onChange: () => void) => runTrace?.subscribeStatus?.(nodeId, onChange) ?? unsubscribed,
    [runTrace, nodeId],
  );
  const status = runTrace?.status;
  return useSyncExternalStore(subscribe, status ? () => status.call(runTrace, nodeId) : noStatus);
}
