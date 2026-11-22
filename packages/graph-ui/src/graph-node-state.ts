import { createContext, useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useGraphEditorContext } from "./graph-editor-context";
import type { PinTypeRef } from "./node-theme";
import { pinTypeKey } from "./wildcard-display";
import type { GraphPreviewedNode } from "./graph-editor-context";

/**
 * Canvas state that changes while the graph is edited and that each node reads
 * only its own part of: the pin chosen to connect, error diagnostics, the
 * node being renamed and the previewed node. It lives in this store rather
 * than in the canvas context, so a change renders only the nodes whose part
 * changed (each reads it through the hooks below), not every node and pin.
 */
export type GraphNodeState = {
  pendingPin: { nodeId: string; pinId: string } | null;
  /** Error diagnostics per node id. */
  nodeErrorCounts: ReadonlyMap<string, number>;
  /** Pins with an error diagnostic, keyed `nodeId\0pinId`. */
  pinErrorKeys: ReadonlySet<string>;
  renamingNodeId: string | null;
  /** The rename field's starting text when it differs from the title. */
  renamingNodeValue: string | undefined;
  previewedNode: GraphPreviewedNode | null;
  /**
   * Each pin's shown type (`pinTypeKey`), where it differs from its declared one. An unchanged
   * type keeps its object across updates (`stablePinDisplayTypes`), so a pin renders again only
   * when its own type changed.
   */
  pinDisplayTypes: ReadonlyMap<string, PinTypeRef>;
  /** The ids of each node's wired inputs. */
  connectedInputs: ReadonlyMap<string, readonly string[]>;
};

/**
 * `next` with every type that equals the one `previous` holds for the same pin replaced by that
 * object, so a recomputed map hands unchanged pins the very type they had.
 */
export function stablePinDisplayTypes(
  previous: ReadonlyMap<string, PinTypeRef>,
  next: ReadonlyMap<string, PinTypeRef>,
): ReadonlyMap<string, PinTypeRef> {
  if (previous === next) return next;
  const stable = new Map<string, PinTypeRef>();
  for (const [key, type] of next) {
    const before = previous.get(key);
    stable.set(key, before !== undefined && JSON.stringify(before) === JSON.stringify(type) ? before : type);
  }
  return stable;
}

export const EMPTY_GRAPH_NODE_STATE: GraphNodeState = {
  pendingPin: null,
  nodeErrorCounts: new Map(),
  pinErrorKeys: new Set(),
  renamingNodeId: null,
  renamingNodeValue: undefined,
  previewedNode: null,
  pinDisplayTypes: new Map(),
  connectedInputs: new Map(),
};

export class GraphNodeStateStore {
  private state: GraphNodeState;
  private readonly listeners = new Set<() => void>();

  constructor(initial: GraphNodeState = EMPTY_GRAPH_NODE_STATE) {
    this.state = initial;
  }

  get(): GraphNodeState {
    return this.state;
  }

  /** Replaces the fields that changed (by identity) and tells subscribers once. */
  set(next: GraphNodeState): void {
    const current = this.state;
    if ((Object.keys(next) as Array<keyof GraphNodeState>).every((key) => next[key] === current[key])) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/**
 * The host's node body renderer (`GraphEditor.renderNodeBody`), apart from the canvas context: a
 * host's renderer may change with every edit, and only the body slots read it.
 */
export const GraphNodeBodyContext = createContext<
  ((nodeId: string, data: Record<string, unknown>) => ReactNode) | undefined
>(undefined);

/** Outside a canvas (the docs' static node previews) nothing is pending, failing or renamed. */
const staticStore = new GraphNodeStateStore();

function useGraphNodeState<T>(select: (state: GraphNodeState) => T): T {
  const store = useGraphEditorContext().nodeState ?? staticStore;
  const snapshot = useCallback(() => select(store.get()), [select, store]);
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

/** The pin of this node chosen to connect, or null. */
export function usePendingPinId(nodeId: string): string | null {
  return useGraphNodeState(useCallback(
    (state: GraphNodeState) => (state.pendingPin?.nodeId === nodeId ? state.pendingPin.pinId : null),
    [nodeId],
  ));
}

/** How many error diagnostics name this node. */
export function useNodeErrorCount(nodeId: string): number {
  return useGraphNodeState(useCallback((state: GraphNodeState) => state.nodeErrorCounts.get(nodeId) ?? 0, [nodeId]));
}

/**
 * Whether a pin of this node has an error diagnostic: a lookup of the node's
 * pins by id, so a node subscribes once for all its pins.
 */
export function usePinErrors(nodeId: string): (pinId: string) => boolean {
  // The node's failing pin ids as one string (`\0a\0b\0`): a value, so an unrelated change renders nothing.
  const failing = useGraphNodeState(useCallback((state: GraphNodeState) => {
    let ids = "\u0000";
    for (const key of state.pinErrorKeys) {
      const separator = key.indexOf("\u0000");
      if (key.slice(0, separator) === nodeId) ids += `${key.slice(separator + 1)}\u0000`;
    }
    return ids;
  }, [nodeId]));
  return useCallback((pinId: string) => failing.includes(`\u0000${pinId}\u0000`), [failing]);
}

/** Whether this node's title is the rename field, and the text it starts with. */
export function useNodeRename(nodeId: string): { renaming: boolean; value: string | undefined } {
  const renaming = useGraphNodeState(useCallback((state: GraphNodeState) => state.renamingNodeId === nodeId, [nodeId]));
  const value = useGraphNodeState(useCallback(
    (state: GraphNodeState) => (state.renamingNodeId === nodeId ? state.renamingNodeValue : undefined),
    [nodeId],
  ));
  return { renaming, value };
}

/** A pin's shown type, when it differs from its declared one (a resolved wildcard). */
export function usePinDisplayType(nodeId: string, pinId: string): PinTypeRef | undefined {
  return useGraphNodeState(useCallback(
    (state: GraphNodeState) => state.pinDisplayTypes.get(pinTypeKey(nodeId, pinId)),
    [nodeId, pinId],
  ));
}

/** The ids of this node's wired inputs, the same array while they are unchanged. */
export function useConnectedInputs(nodeId: string): readonly string[] | undefined {
  const joined = useGraphNodeState(useCallback(
    (state: GraphNodeState) => state.connectedInputs.get(nodeId)?.join("\u0000"),
    [nodeId],
  ));
  return useMemo(() => (joined === undefined ? undefined : joined.split("\u0000")), [joined]);
}

/** This node when the host previews it, else null. */
export function usePreviewedNode(nodeId: string): GraphPreviewedNode | null {
  return useGraphNodeState(useCallback(
    (state: GraphNodeState) => (state.previewedNode?.nodeId === nodeId ? state.previewedNode : null),
    [nodeId],
  ));
}
