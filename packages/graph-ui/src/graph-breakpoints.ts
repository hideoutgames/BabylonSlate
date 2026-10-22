import { useCallback, useSyncExternalStore } from "react";
import { useGraphEditorContext } from "./graph-editor-context";
import { hasSerializedPins } from "./graph-types";

/** A node's breakpoint: on, or kept but off. */
export type GraphBreakpointState = "enabled" | "disabled";

/**
 * The breakpoints of the graph a canvas shows. They are host state, never graph data, so setting one
 * never edits the document and works on a read-only canvas. Memoize it: each node reads its own state
 * through `subscribe`, so a change renders only the nodes whose state changed.
 */
export type GraphBreakpoints = {
  state(nodeId: string): GraphBreakpointState | null;
  subscribe(listener: () => void): () => void;
  /** Adds a breakpoint on the node, or removes the one it has. */
  toggle(nodeId: string): void;
};

/**
 * Whether execution can stop at a node: breakpoints are checked where execution reaches a node, so
 * only a node with an exec pin (an event, a function entry or a call in an exec chain) can have one.
 */
export function canBreakOnNode(data: Record<string, unknown> | undefined): boolean {
  return hasSerializedPins(data) && data.__pins.some((pin) => pin.kind === "exec");
}

const noBreakpoint = () => null;
const unsubscribed = () => () => {};

/** A node's breakpoint from the canvas's `breakpoints`; null when it has none or the canvas has no breakpoints. */
export function useNodeBreakpoint(nodeId: string): GraphBreakpointState | null {
  const { breakpoints } = useGraphEditorContext();
  const subscribe = useCallback(
    (onChange: () => void) => breakpoints?.subscribe(onChange) ?? (() => {}),
    [breakpoints],
  );
  const snapshot = breakpoints ? () => breakpoints.state(nodeId) : noBreakpoint;
  // The server snapshot lets the docs' static node previews render a node without a live store.
  return useSyncExternalStore(breakpoints ? subscribe : unsubscribed, snapshot, snapshot);
}
