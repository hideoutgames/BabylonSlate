import { useMemo, useRef, useState } from "react";
import type { DebugInspectNode, DebugInspectSnapshot } from "@babylonslate/object-model";
import {
  SearchInput,
  SelectableText,
  TreeView,
  TypeVisualIcon,
  resolveActorTypeVisual,
  resolveTypeVisual,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import {
  flattenInspectTree,
  formatInspectVariable,
  nextInspectSelection,
} from "../lib/play-inspect-tree";

export type DebugInspectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: DebugInspectSnapshot;
};

function inspectTypeVisual(
  node: DebugInspectNode,
  nodes: DebugInspectNode[],
) {
  if (node.kind === "actor") {
    const components = nodes.filter(
      (child) => child.parentId === node.id && child.kind === "component",
    );
    return resolveActorTypeVisual({
      classId: node.classId,
      components,
    });
  }
  return resolveTypeVisual({ classId: node.classId, family: "class" });
}

function formatTuple(values: readonly number[]): string {
  return values.join(", ");
}

function InspectField({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <Field orientation="horizontal" data-testid={testId}>
      <FieldLabel>{label}</FieldLabel>
      <FieldContent>
        <SelectableText>{value}</SelectableText>
      </FieldContent>
    </Field>
  );
}

/** Read-only Play overlay inspector: actor tree plus live variables. */
export function DebugInspectDialog({
  open,
  onOpenChange,
  snapshot,
}: DebugInspectDialogProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const parentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of snapshot.nodes) {
      if (node.parentId) {
        ids.add(node.parentId);
      }
    }
    return ids;
  }, [snapshot.nodes]);

  const expandedIds = useMemo(() => {
    const next = new Set<string>();
    for (const id of parentIds) {
      if (!collapsedIds.has(id)) {
        next.add(id);
      }
    }
    return next;
  }, [collapsedIds, parentIds]);

  const rows = useMemo(
    () => flattenInspectTree(snapshot.nodes, expandedIds, search),
    [expandedIds, search, snapshot.nodes],
  );

  const treeNodes: TreeViewNode[] = useMemo(
    () =>
      rows.map((row) => ({
        id: row.id,
        label: row.label,
        depth: row.depth,
        hasChildren: row.hasChildren,
        expanded: search.trim() ? true : expandedIds.has(row.id),
        icon: (
          <TypeVisualIcon visual={inspectTypeVisual(row, snapshot.nodes)} />
        ),
      })),
    [expandedIds, rows, search, snapshot.nodes],
  );

  const effectiveId = nextInspectSelection(selectedId, snapshot.nodes);
  const selected = snapshot.nodes.find((node) => node.id === effectiveId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="debug-inspect"
        initialFocus={bodyRef}
        className="flex h-[min(90vh,52rem)] w-[min(96vw,64rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-14">
          <DialogTitle>Inspector</DialogTitle>
          <p
            className="text-sm text-muted-foreground"
            data-testid="debug-inspect-tick"
            data-tick={String(snapshot.tickIndex)}
          >
            <SelectableText>Tick {snapshot.tickIndex}</SelectableText>
          </p>
        </DialogHeader>
        <div ref={bodyRef} tabIndex={-1} className="flex min-h-0 flex-1 outline-none">
          <div className="flex w-[min(40%,20rem)] shrink-0 flex-col border-r">
            <div className="shrink-0 border-b px-4 py-3">
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
          <ScrollArea className="min-h-0 flex-1">
            {selected ? (
              <div className="flex flex-col gap-4 p-4" data-testid="debug-inspect-details">
                <FieldGroup>
                  <InspectField label="Name" value={selected.label} />
                  <InspectField label="Class" value={selected.classId} />
                  <InspectField label="Guid" value={selected.id} />
                </FieldGroup>
                {selected.transform ? (
                  <FieldGroup>
                    <InspectField
                      label="Position"
                      value={formatTuple(selected.transform.position)}
                    />
                    <InspectField
                      label="Rotation"
                      value={formatTuple(selected.transform.rotation)}
                    />
                    <InspectField
                      label="Scale"
                      value={formatTuple(selected.transform.scale)}
                    />
                  </FieldGroup>
                ) : null}
                <FieldGroup>
                  {Object.entries(selected.variables).map(([key, value]) => (
                    <InspectField
                      key={key}
                      label={key}
                      value={formatInspectVariable(value)}
                      testId={`debug-inspect-var-${key}`}
                    />
                  ))}
                </FieldGroup>
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
      </DialogContent>
    </Dialog>
  );
}
