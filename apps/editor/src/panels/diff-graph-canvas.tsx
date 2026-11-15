import { memo, useMemo, type ComponentProps, type ReactNode } from "react";
import { GraphEditor, graphNodeTypes, type GraphEditorProps } from "@haptic/graph-ui";
import { Badge } from "@haptic/ui/components/badge";
import { cn } from "@haptic/ui/lib/utils";
import { scriptDiffGraph } from "../lib/script-diff-graph";
import { STATUS_LABEL } from "./diff-status";
import {
  DIFF_CHANGES,
  DIFF_STATUS,
  diffCanvasDocument,
  type DiffCanvasFamily,
  type DiffCanvasProps,
  type DiffNodeStatus,
  type DiffValueChange,
} from "./diff-graph-canvas-model";

type NodeTypes = NonNullable<GraphEditorProps["nodeTypes"]>;
type NodeComponent = NodeTypes[string];
type NodeComponentProps = ComponentProps<NodeComponent>;

const FRAME: Record<DiffNodeStatus, string> = {
  added: "outline-(--success)",
  changed: "outline-(--warning)",
  removed: "outline-dashed outline-destructive opacity-70",
};
const TAG = { added: "success", changed: "warning", removed: "destructive" } as const;

/** A node's changed values, each old struck through beside the new. */
function ValueChanges({ changes }: { changes: readonly DiffValueChange[] }) {
  return (
    <ul className="flex flex-col gap-0.5 border-t border-border px-3 py-1.5 text-xs" data-testid="diff-pin-changes">
      {changes.map((change) => (
        <li key={change.id} className="flex items-center gap-2">
          <span className="truncate text-muted-foreground">{change.name}</span>
          {change.base !== null ? <del className="text-destructive">{change.base}</del> : null}
          {change.compare !== null ? <span className="text-(--success)">{change.compare}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function changesIn(data: Record<string, unknown>): DiffValueChange[] {
  const changes = data[DIFF_CHANGES];
  return Array.isArray(changes) ? (changes as DiffValueChange[]) : [];
}

/**
 * A node component drawn as it is, outlined and tagged with what changed.
 * Pin nodes list the changed values in their body (`renderNodeBody`); a
 * family's own node cards, which draw no body, list them below.
 */
function withDiffFrame(Inner: NodeComponent, valuesBelow: boolean): NodeComponent {
  function DiffNode(props: NodeComponentProps) {
    const data = props.data as Record<string, unknown>;
    const status = data[DIFF_STATUS] as DiffNodeStatus | undefined;
    const changes = valuesBelow && status ? changesIn(data) : [];
    return (
      <div className={cn("relative rounded-md", status && "outline-2 outline-offset-4", status && FRAME[status])} data-diff-status={status}>
        {status ? <Badge variant={TAG[status]} className="pointer-events-none absolute -top-7 left-0">{STATUS_LABEL[status]}</Badge> : null}
        <Inner {...props} />
        {changes.length > 0 ? <div className="rounded-b-md bg-card"><ValueChanges changes={changes} /></div> : null}
      </div>
    );
  }
  return memo(DiffNode) as unknown as NodeComponent;
}

/** Wrapped node types by the family's own map, built on first use so their identity stays stable. */
const wrapped = new WeakMap<object, NodeTypes>();
const PIN_NODES_ONLY = {};

function diffNodeTypes(family: NodeTypes | undefined): NodeTypes {
  const key = family ?? PIN_NODES_ONLY;
  const cached = wrapped.get(key);
  if (cached) return cached;
  const types: NodeTypes = {
    pinNode: withDiffFrame(graphNodeTypes.pinNode as NodeComponent, false),
    variableGet: withDiffFrame(graphNodeTypes.variableGet as NodeComponent, true),
  };
  for (const [type, component] of Object.entries(family ?? {})) types[type] = withDiffFrame(component, true);
  wrapped.set(key, types);
  return types;
}

/**
 * A graph diff on the graph editor's own canvas, read-only, through a
 * family's node components: one editor whatever the mode, which mounts only
 * the nodes in view as every graph canvas does.
 */
export function DiffGraphCanvas({ section, mode, focusedNodeId, family }: DiffCanvasProps & { family: DiffCanvasFamily }) {
  const { toGraph, nodeTypes, renderNodeBody, editorProps, className } = family;
  const base = useMemo(() => (section.base == null ? null : toGraph(section.base)), [section.base, toGraph]);
  const compare = useMemo(() => (section.compare == null ? null : toGraph(section.compare)), [section.compare, toGraph]);
  const document = useMemo(() => diffCanvasDocument(section, mode, base, compare), [base, compare, mode, section]);
  const body = useMemo(() => (nodeId: string, data: Record<string, unknown>): ReactNode => {
    const changes = data[DIFF_STATUS] ? changesIn(data) : [];
    const own = renderNodeBody?.(nodeId, data);
    if (changes.length === 0) return own ?? null;
    return <>{own}<ValueChanges changes={changes} /></>;
  }, [renderNodeBody]);
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)} data-testid="diff-graph-canvas">
      <GraphEditor
        key={`${section.id}:${mode}`}
        readOnly
        initialGraph={document}
        nodeTypes={diffNodeTypes(nodeTypes)}
        renderNodeBody={body}
        {...editorProps}
        {...(focusedNodeId ? { focusedNodeId } : {})}
      />
    </div>
  );
}

/** Class and Scene Script graphs, and an Animation Graph's script graphs: the graph editor's pin nodes, with the pins they were saved with. */
export function ScriptDiffCanvas(props: DiffCanvasProps) {
  const family = useMemo<DiffCanvasFamily>(() => ({ toGraph: scriptDiffGraph }), []);
  return <DiffGraphCanvas {...props} family={family} />;
}
