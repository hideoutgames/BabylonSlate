import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DebugInspectNode, DebugInspectSnapshot } from "@haptic/object-model";
import {
  PropertyGrid,
  SearchInput,
  SelectableText,
  TreeView,
  TypeVisualIcon,
  resolveActorTypeVisual,
  resolveTypeVisual,
  type TreeViewNode,
} from "@haptic/editor-kit";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@haptic/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import { ScrollArea } from "@haptic/ui/components/scroll-area";
import { Button } from "@haptic/ui/components/button";
import type { CommandResult } from "@haptic/debugger";
import {
  flattenInspectTree,
  nextInspectSelection,
} from "../lib/play-inspect-tree";
import type { InspectWorldStore } from "../lib/inspect-world-store";
import { useRetainedValue } from "../lib/use-retained-value";
import {
  playInspectIdentityRows,
  playInspectTransformRows,
  playInspectVariableRows,
} from "../lib/play-inspect-rows";

export type DebugInspectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: DebugInspectSnapshot;
  onSelectedIdChange?: (id: string | null) => void;
  onExecute?: (line: string) => Promise<CommandResult>;
};

const NO_NODES: DebugInspectNode[] = [];
const NO_TREE_NODES: TreeViewNode[] = [];
const NO_DETAILS: InspectDetails = { selected: null, hasCamera: false };

type InspectDetails = { selected: DebugInspectNode | null; hasCamera: boolean };

function inspectTypeVisual(
  node: DebugInspectNode,
  components: DebugInspectNode[],
) {
  if (node.kind === "actor") {
    return resolveActorTypeVisual({
      classId: node.classId,
      ancestry: node.ancestry,
      components,
    });
  }
  return resolveTypeVisual({
    classId: node.classId,
    ancestry: node.ancestry,
    family: "class",
  });
}

/**
 * Type glyph of a tree row. It resolves when the row renders, so a snapshot
 * with thousands of nodes resolves only the rows the tree mounts.
 */
function InspectNodeIcon({
  node,
  components,
}: {
  node: DebugInspectNode;
  components: DebugInspectNode[];
}) {
  return <TypeVisualIcon visual={inspectTypeVisual(node, components)} />;
}

/** The tree rows of a snapshot: expanded by default, all expanded while searching. */
function inspectTreeNodes(
  nodes: DebugInspectNode[],
  collapsedIds: ReadonlySet<string>,
  search: string,
): TreeViewNode[] {
  const parentIds = new Set<string>();
  const componentsByActor = new Map<string, DebugInspectNode[]>();
  for (const node of nodes) {
    if (node.parentId) {
      parentIds.add(node.parentId);
    }
    // An actor row reads its components here instead of scanning every node.
    if (node.kind === "component" && node.parentId !== null) {
      const components = componentsByActor.get(node.parentId);
      if (components) components.push(node);
      else componentsByActor.set(node.parentId, [node]);
    }
  }
  const expandedIds = new Set<string>();
  for (const id of parentIds) {
    if (!collapsedIds.has(id)) {
      expandedIds.add(id);
    }
  }
  const searching = search.trim().length > 0;
  return flattenInspectTree(nodes, expandedIds, search).map((row) => ({
    id: row.id,
    label: row.label,
    depth: row.depth,
    hasChildren: row.hasChildren,
    expanded: searching ? true : expandedIds.has(row.id),
    icon: <InspectNodeIcon node={row} components={componentsByActor.get(row.id) ?? NO_NODES} />,
  }));
}

function inspectDetails(nodes: DebugInspectNode[], selectedId: string | null): InspectDetails {
  const selected = nodes.find((node) => node.id === selectedId) ?? null;
  return {
    selected,
    hasCamera:
      selected?.kind === "actor" &&
      nodes.some(
        (node) =>
          node.parentId === selected.id &&
          node.kind === "component" &&
          node.classId === "CameraComponent",
      ),
  };
}

/** Play inspector: live values and session-only actor debug actions. */
export function DebugInspectDialog({
  open,
  onOpenChange,
  snapshot,
  onSelectedIdChange,
  onExecute,
}: DebugInspectDialogProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);

  // The console polls snapshots while this dialog is closed. Closed, a
  // snapshot costs the selection check below and nothing else; the tree and
  // details are built for an open dialog and kept while it fades out.
  const treeNodes = useRetainedValue(
    useMemo(
      () => (open ? inspectTreeNodes(snapshot.nodes, collapsedIds, search) : null),
      [collapsedIds, open, search, snapshot.nodes],
    ),
    NO_TREE_NODES,
  );

  const effectiveId = nextInspectSelection(selectedId, snapshot.nodes);
  const { selected, hasCamera: selectedHasCamera } = useRetainedValue(
    useMemo(
      () => (open ? inspectDetails(snapshot.nodes, effectiveId) : null),
      [effectiveId, open, snapshot.nodes],
    ),
    NO_DETAILS,
  );
  const executeAction = async (command: "possess" | "destroyactor") => {
    if (!onExecute || selected?.kind !== "actor" || actionPending) return;
    setActionPending(true);
    try {
      const result = await onExecute(`${command} "${selected.id}"`);
      setActionResult(result.output);
    } catch (error) {
      setActionResult(error instanceof Error ? error.message : "Action Failed");
    } finally {
      setActionPending(false);
    }
  };

  useEffect(() => {
    onSelectedIdChange?.(effectiveId);
  }, [effectiveId, onSelectedIdChange]);

  return (
    // Like the console, the inspector leaves the game running and the Play toolbar (Stop,
    // Pause) reachable: no backdrop, no focus trap, and only Escape or Close dismisses it.
    // Its height keeps clear of the toolbar row above it.
    <Dialog open={open} onOpenChange={onOpenChange} modal={false} disablePointerDismissal>
      <DialogContent
        data-testid="debug-inspect"
        initialFocus={bodyRef}
        showOverlay={false}
        className="h-[min(calc(100dvh-var(--safe-top)-var(--safe-bottom)-9rem),52rem)] w-[min(96vw,64rem)] max-w-none sm:max-w-none"
        bodyClassName="flex flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 flex-row items-center justify-between gap-2 border-b px-3 py-3 pr-14">
          <DialogTitle>Inspector</DialogTitle>
          <p
            className="text-sm text-muted-foreground"
            data-testid="debug-inspect-tick"
            data-tick={String(snapshot.tickIndex)}
          >
            <SelectableText>Tick {snapshot.tickIndex}</SelectableText>
          </p>
        </DialogHeader>
        <div ref={bodyRef} tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none sm:flex-row">
          <div className="flex h-40 min-h-0 min-w-0 shrink-0 flex-col border-b sm:h-auto sm:w-[min(32%,18rem)] sm:border-r sm:border-b-0">
            <div className="shrink-0 border-b p-2">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search"
                autoFocus={false}
                className="min-h-[var(--chrome-row,28px)]"
                data-testid="debug-inspect-search"
              />
            </div>
            <div className="min-h-0 flex-1">
              <TreeView
                nodes={treeNodes}
                selectedId={effectiveId}
                onSelect={setSelectedId}
                onToggleExpanded={(id) => {
                  setCollapsedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) {
                      next.delete(id);
                    } else {
                      next.add(id);
                    }
                    return next;
                  });
                }}
                emptyLabel="No Actors"
                data-testid="debug-inspect-tree"
              />
            </div>
          </div>
          <ScrollArea className="min-h-0 min-w-0 flex-1">
            {selected ? (
              <div className="flex min-w-0 flex-col gap-3 p-2" data-testid="debug-inspect-details">
                {onExecute && selected.kind === "actor" ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedHasCamera ? (
                      <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={actionPending}
                        onClick={() => void executeAction("possess")}>
                        Use Camera
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={actionPending}
                      onClick={() => void executeAction("destroyactor")}>
                      Destroy Actor
                    </Button>
                  </div>
                ) : null}
                <PropertyGrid
                  title="Identity"
                  readOnly
                  orientation="horizontal"
                  rows={playInspectIdentityRows(selected)}
                />
                {selected.transform ? (
                  <PropertyGrid
                    title="Transform"
                    readOnly
                    orientation="horizontal"
                    rows={playInspectTransformRows(selected.transform)}
                  />
                ) : null}
                <PropertyGrid
                  title="Variables"
                  readOnly
                  orientation="horizontal"
                  rows={playInspectVariableRows(
                    selected.variables,
                    selected.variableTypes,
                  )}
                />
              </div>
            ) : (
              <Empty data-testid="debug-inspect-empty">
                <EmptyHeader>
                  <EmptyTitle>No Selection</EmptyTitle>
                  <EmptyDescription>
                    Select an actor or component to inspect live values.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </ScrollArea>
        </div>
        {actionResult ? (
          <p role="status" className="shrink-0 border-t px-4 py-2 text-sm text-muted-foreground">
            <SelectableText>{actionResult}</SelectableText>
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Play inspector over a polled snapshot store. It subscribes itself, so
 * the owner that polls does not re-render per snapshot.
 */
export function ConnectedDebugInspectDialog({
  store,
  ...props
}: Omit<DebugInspectDialogProps, "snapshot"> & { store: InspectWorldStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <DebugInspectDialog {...props} snapshot={snapshot} />;
}
