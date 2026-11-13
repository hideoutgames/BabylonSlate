import { useCallback, useSyncExternalStore } from "react";
import type { NestedMenuItem } from "@haptic/editor-kit";
import { useGraphEditorContext } from "./graph-editor-context";
import type { GraphKeybinds } from "./graph-keybinds";
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
  /** Turns the node's breakpoint on or off, keeping it and its settings; no-op without one. */
  setEnabled(nodeId: string, enabled: boolean): void;
  /** Opens the host's settings (hit count, condition) for the node's breakpoint; without it there is no Edit. */
  edit?(nodeId: string): void;
  /**
   * Which nodes can have one. Without it, a node with an exec pin (`canBreakOnNode`); a canvas whose
   * nodes all run, such as a Behaviour Tree's, accepts every node.
   */
  canBreak?(nodeId: string, data: Record<string, unknown> | undefined): boolean;
};

/**
 * Whether execution can stop at a node: breakpoints are checked where execution reaches a node, so
 * only a node with an exec pin (an event, a function entry or a call in an exec chain) can have one.
 */
export function canBreakOnNode(data: Record<string, unknown> | undefined): boolean {
  return hasSerializedPins(data) && data.__pins.some((pin) => pin.kind === "exec");
}

/** Whether `breakpoints` let the node have one. */
export function nodeCanBreak(
  breakpoints: GraphBreakpoints,
  nodeId: string,
  data: Record<string, unknown> | undefined,
): boolean {
  return breakpoints.canBreak ? breakpoints.canBreak(nodeId, data) : canBreakOnNode(data);
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

/**
 * Breakpoints on several nodes at once (a selection, a menu on one of its nodes, a key): when any of the
 * nodes has none, adds one to each that has none; otherwise removes them all. Returns whether any changed.
 */
export function toggleBreakpoints(breakpoints: GraphBreakpoints, nodeIds: readonly string[]): boolean {
  const missing = nodeIds.filter((id) => breakpoints.state(id) === null);
  const targets = missing.length > 0 ? missing : nodeIds;
  for (const id of targets) breakpoints.toggle(id);
  return targets.length > 0;
}

/**
 * Turns the nodes' breakpoints off when any of them is on, otherwise on; nodes without one are left out.
 * Returns whether any changed.
 */
export function toggleBreakpointsEnabled(breakpoints: GraphBreakpoints, nodeIds: readonly string[]): boolean {
  const set = nodeIds.filter((id) => breakpoints.state(id) !== null);
  const enable = !set.some((id) => breakpoints.state(id) === "enabled");
  for (const id of set) breakpoints.setEnabled(id, enable);
  return set.length > 0;
}

/**
 * The breakpoint items of a node menu, acting on `nodeIds` (the selection the menu opened on, already
 * narrowed to nodes that can have one); Edit Breakpoint… edits the node the menu opened on. Each shows
 * its graph key.
 */
export function breakpointMenuItems(
  breakpoints: GraphBreakpoints,
  nodeIds: readonly string[],
  menuNodeId: string,
  keybinds: GraphKeybinds,
): NestedMenuItem[] {
  if (nodeIds.length === 0) return [];
  const states = nodeIds.map((id) => breakpoints.state(id));
  const items: NestedMenuItem[] = states.some((state) => state === null)
    ? [{ id: "add-breakpoint", label: "Add Breakpoint", shortcut: keybinds.toggleBreakpoint[0], onSelect: () => { toggleBreakpoints(breakpoints, nodeIds); } }]
    : [{ id: "remove-breakpoint", label: "Remove Breakpoint", shortcut: keybinds.toggleBreakpoint[0], onSelect: () => { toggleBreakpoints(breakpoints, nodeIds); } }];
  if (states.some((state) => state !== null)) {
    items.push({
      id: "toggle-breakpoint-enabled",
      label: states.includes("enabled") ? "Disable Breakpoint" : "Enable Breakpoint",
      shortcut: keybinds.toggleBreakpointEnabled[0],
      onSelect: () => { toggleBreakpointsEnabled(breakpoints, nodeIds); },
    });
  }
  const edit = breakpoints.edit;
  if (edit && breakpoints.state(menuNodeId) !== null) {
    items.push({
      id: "edit-breakpoint",
      label: "Edit Breakpoint…",
      shortcut: keybinds.editBreakpoint[0],
      onSelect: () => edit.call(breakpoints, menuNodeId),
    });
  }
  return items;
}
