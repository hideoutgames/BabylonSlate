import { useCallback, useMemo, useRef } from "react";
import type { SerializedGraph } from "@haptic/core";
import { useEditorReadOnly } from "@haptic/editor-kit";
import type { GraphEditorProps } from "@haptic/graph-ui";
import type { ClassHierarchy } from "@haptic/scripting";
import { scriptCatalogPaletteNode } from "../services/graph-validation";
import { scriptPinConversion } from "../services/script-pin-conversion";
import { addPinToNode, scriptPinMenuItems } from "./graph-pin-menu";

export type ScriptGraphPinActions = Pick<GraphEditorProps, "onAddPin" | "pinConversion" | "contextMenuItemsForPin">;

/**
 * The pin actions every editable Script graph canvas passes to its `GraphEditor`: the Add Pin
 * control, Convert to <Type> wires and the pin menu's Convert Pin, Add Pin and Remove Pin. `graph`
 * is the hydrated graph the canvas shows and `commit` the host's canvas `onChange` path, so each
 * action is one graph change. The callbacks are stable and read the latest graph only when used.
 * Under a read-only `EditorReadOnlyContext` the canvas gets none.
 */
export function useScriptGraphPinActions({
  graph,
  commit,
  hierarchy,
}: {
  graph: SerializedGraph | null;
  commit: (next: SerializedGraph) => void;
  hierarchy: ClassHierarchy;
}): ScriptGraphPinActions {
  const editable = !useEditorReadOnly();
  const latest = useRef({ graph, commit });
  latest.current = { graph, commit };
  const pinConversion = useMemo(
    () => scriptPinConversion({ hierarchy, paletteNodeFor: (nodeType) => scriptCatalogPaletteNode(nodeType) }),
    [hierarchy],
  );
  const onAddPin = useCallback((nodeId: string) => {
    const { graph: current, commit: apply } = latest.current;
    const next = current ? addPinToNode(current, nodeId) : null;
    if (next) apply(next);
  }, []);
  const contextMenuItemsForPin = useCallback((nodeId: string, pinId: string) => {
    const { graph: current, commit: apply } = latest.current;
    return current ? scriptPinMenuItems(current, nodeId, pinId, apply) : [];
  }, []);
  return useMemo(
    () => (editable ? { onAddPin, pinConversion, contextMenuItemsForPin } : {}),
    [contextMenuItemsForPin, editable, onAddPin, pinConversion],
  );
}
