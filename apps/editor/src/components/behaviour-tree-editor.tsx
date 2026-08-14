import { useMemo, useState } from "react";
import {
  behaviourTreeToSerialized,
  createDefaultBehaviourTree,
  hydrateBehaviourTreeForEditor,
  parseBehaviourTreeDocument,
  pinsForBtKind,
  reorderSiblingsByPosition,
  serializedToBehaviourTree,
  type BehaviourTreeDocument,
  type BtAbortMode,
  type BtGraphOverlay,
  type BtNode,
  type BtNodeKind,
  type BtResult,
} from "@babylonslate/behaviour-tree";
import {
  AssetPicker,
  PanelFrame,
  PropertyGrid,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { GraphEditor, treeNodeTypes, type PaletteNode } from "@babylonslate/graph-ui";
import { Button } from "@babylonslate/ui/components/button";
import { useDocuments } from "../context/document-context";
import { usePlay } from "../context/play-context";

const COMPOSITE_PALETTE: PaletteNode[] = [
  palette("bt.composite.selector", "Selector", "Composites", "selector"),
  palette("bt.composite.sequence", "Sequence", "Composites", "sequence"),
  palette("bt.composite.parallel", "Parallel", "Composites", "parallel"),
];

const TASK_PALETTE: PaletteNode[] = [
  palette("bt.task.succeed", "Succeed", "Tasks", "task"),
  palette("bt.task.fail", "Fail", "Tasks", "task"),
  palette("bt.task.wait", "Wait", "Tasks", "task"),
  palette("bt.task.setBlackboard", "Set Blackboard", "Tasks", "task"),
  palette("bt.task.moveTo", "Move To", "Tasks", "task"),
  palette("bt.task.rotateToFace", "Rotate To Face", "Tasks", "task"),
  palette("bt.task.playAnimation", "Play Animation", "Tasks", "task"),
  palette("bt.task.playSound", "Play Sound", "Tasks", "task"),
];

const DECORATORS = [
  "bt.decorator.blackboardIsSet",
  "bt.decorator.compareBlackboardValue",
  "bt.decorator.loop",
  "bt.decorator.cooldown",
  "bt.decorator.timeLimit",
] as const;

const SERVICES = ["bt.service.setBlackboard"] as const;

function palette(
  classId: string,
  title: string,
  category: string,
  kind: BtNodeKind,
): PaletteNode {
  return {
    id: classId,
    title,
    category,
    pins: pinsForBtKind(kind),
    defaultData: { title, classId, kind },
  };
}

function asTree(payload: Record<string, unknown>): BehaviourTreeDocument {
  return parseBehaviourTreeDocument(payload) ?? createDefaultBehaviourTree();
}

function uniqueId(prefix: string, used: Set<string>): string {
  let index = 1;
  let id = `${prefix}-${index}`;
  while (used.has(id)) {
    index += 1;
    id = `${prefix}-${index}`;
  }
  return id;
}

function adoptOrphans(
  next: BehaviourTreeDocument,
  previous: BehaviourTreeDocument,
  parentId: string | null,
): BehaviourTreeDocument {
  if (!parentId) return next;
  const parent = next.nodes.find((node) => node.id === parentId);
  if (!parent || parent.kind === "task") return next;
  const prevIds = new Set(previous.nodes.map((node) => node.id));
  const claimed = new Set(next.nodes.flatMap((node) => node.children));
  const orphans = next.nodes.filter(
    (node) =>
      !prevIds.has(node.id) && !claimed.has(node.id) && node.id !== next.rootId,
  );
  if (orphans.length === 0) return next;
  return {
    ...next,
    nodes: next.nodes.map((node) =>
      node.id === parentId
        ? { ...node, children: [...node.children, ...orphans.map((row) => row.id)] }
        : node,
    ),
  };
}

function patchNode(
  doc: BehaviourTreeDocument,
  nodeId: string,
  patch: Partial<BtNode>,
): BehaviourTreeDocument {
  return {
    ...doc,
    nodes: doc.nodes.map((node) =>
      node.id === nodeId ? { ...node, ...patch } : node,
    ),
  };
}

export function BehaviourTreeEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { assetRegistry, openDocument } = useDocuments();
  const play = usePlay();
  const doc = useMemo(() => asTree(payload), [payload]);
  const [selectedId, setSelectedId] = useState<string | null>(doc.rootId);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [blackboardPick, setBlackboardPick] = useState(false);
  const commit = (next: BehaviourTreeDocument) => {
    onChange(next as unknown as Record<string, unknown>);
  };
  const selected = doc.nodes.find((node) => node.id === selectedId) ?? null;
  const overlay: BtGraphOverlay | undefined =
    play.playing && play.liveBtState
      ? {
          lastResults: play.liveBtState.lastResults as Record<string, BtResult>,
          btNodeId: play.liveBtState.btNodeId,
          stack: [],
        }
      : undefined;
  const initialGraph = useMemo(
    () =>
      hydrateBehaviourTreeForEditor(
        behaviourTreeToSerialized(doc, overlay),
      ),
    [doc, overlay],
  );
  const paletteNodes =
    !selected || selected.kind === "task"
      ? []
      : [...COMPOSITE_PALETTE, ...TASK_PALETTE];
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const blackboard = doc.blackboardGuid
    ? assetRegistry?.getByGuid(doc.blackboardGuid)
    : undefined;
  const attachment =
    selected?.decorators.find((row) => row.id === attachmentId) ??
    selected?.services.find((row) => row.id === attachmentId) ??
    null;
  const rows: PropertyRow[] = [
    {
      id: "blackboard",
      kind: "asset",
      label: "Blackboard",
      value: doc.blackboardGuid,
      placeholder: "None",
      displayLabel: blackboard?.header.name,
      onPick: () => setBlackboardPick(true),
      onChange: (value) => commit({ ...doc, blackboardGuid: value }),
    },
  ];
  if (selected) {
    rows.push({
      id: "classId",
      kind: "text",
      label: "Class",
      value: selected.classId,
      onChange: (classId) => commit(patchNode(doc, selected.id, { classId })),
    });
    if (selected.classId === "bt.task.wait") {
      rows.push({
        id: "durationMs",
        kind: "number",
        label: "Duration Ms",
        value: Number(selected.properties.durationMs ?? 0),
        onChange: (durationMs) =>
          commit(
            patchNode(doc, selected.id, {
              properties: { ...selected.properties, durationMs },
            }),
          ),
      });
    }
  }
  if (attachment && "abortMode" in attachment) {
    rows.push({
      id: "abortMode",
      kind: "enum",
      label: "Abort Mode",
      value: attachment.abortMode,
      options: [
        { value: "none", label: "None" },
        { value: "self", label: "Self" },
        { value: "lowerPriority", label: "Lower Priority" },
        { value: "both", label: "Both" },
      ],
      onChange: (value) => {
        if (!selected) return;
        commit(
          patchNode(doc, selected.id, {
            decorators: selected.decorators.map((row) =>
              row.id === attachment.id
                ? { ...row, abortMode: value as BtAbortMode }
                : row,
            ),
          }),
        );
      },
    });
  }
  const openClass = (nodeId: string) => {
    const node = doc.nodes.find((entry) => entry.id === nodeId);
    if (!node) return;
    const asset = (assetRegistry?.list() ?? []).find(
      (entry) =>
        entry.header.type === "Class" &&
        (entry.header.name === node.classId || entry.header.guid === node.classId),
    );
    if (!asset) return;
    void openDocument({
      kind: "graph",
      path: asset.path,
      label: asset.header.name,
    });
  };
  const blackboardWatch = play.liveBtState?.blackboard ?? null;

  return (
    <div className="flex min-h-0 flex-1" data-testid="behaviour-tree-editor">
      <div className="flex min-h-0 min-w-0 flex-1">
        <GraphEditor
          initialGraph={initialGraph}
          nodeTypes={treeNodeTypes}
          nodesDraggable={!play.playing}
          readOnly={play.playing}
          paletteNodes={paletteNodes}
          focusedNodeId={play.focusedNodeId ?? selectedId ?? undefined}
          selectedAttachmentId={attachmentId}
          onAttachmentSelect={setAttachmentId}
          onNodeDoubleClick={openClass}
          onNavigateRequest={(request) => {
            if (request.nodeId) openClass(request.nodeId);
          }}
          onSelectionChange={(nodeIds) => {
            setSelectedId(nodeIds[0] ?? null);
            setAttachmentId(null);
          }}
          toolbarExtra={
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="bt-relayout"
              onClick={() => commit({ ...doc })}
            >
              Re-layout
            </Button>
          }
          onChange={(graph) => {
            const positions: Record<string, { x: number; y: number }> = {};
            for (const node of graph.nodes) {
              positions[node.id] = node.position;
            }
            const restored = serializedToBehaviourTree(graph, doc);
            const adopted = adoptOrphans(restored, doc, selectedId);
            commit(reorderSiblingsByPosition(adopted, positions));
          }}
        />
      </div>
      <PanelFrame className="w-72 shrink-0 border-l border-border" title="Details">
        <div data-testid="bt-details" className="flex flex-col gap-2 p-2">
          <PropertyGrid rows={rows} />
          {selected && selected.kind !== "task" ? (
            <p className="text-xs text-muted-foreground">
              Add Node inserts a child of the selected composite.
            </p>
          ) : null}
          {selected ? (
            <div className="flex flex-col gap-1">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                data-testid="bt-add-decorator"
                onClick={() => {
                  const used = new Set(selected.decorators.map((row) => row.id));
                  const id = uniqueId("decorator", used);
                  commit(
                    patchNode(doc, selected.id, {
                      decorators: [
                        ...selected.decorators,
                        {
                          id,
                          classId: DECORATORS[0],
                          abortMode: "none",
                          observedKeys: [],
                          properties: {},
                        },
                      ],
                    }),
                  );
                  setAttachmentId(id);
                }}
              >
                Add Decorator
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                data-testid="bt-add-service"
                onClick={() => {
                  const used = new Set(selected.services.map((row) => row.id));
                  const id = uniqueId("service", used);
                  commit(
                    patchNode(doc, selected.id, {
                      services: [
                        ...selected.services,
                        {
                          id,
                          classId: SERVICES[0],
                          intervalMs: 250,
                          randomDeviationMs: 0,
                          properties: {},
                        },
                      ],
                    }),
                  );
                  setAttachmentId(id);
                }}
              >
                Add Service
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Select a node</p>
          )}
          {blackboardWatch ? (
            <div data-testid="bt-blackboard-watch" className="text-xs">
              {Object.entries(blackboardWatch).map(([key, value]) => (
                <div key={key}>
                  {key}: {String(value)}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </PanelFrame>
      <AssetPicker
        open={blackboardPick}
        onOpenChange={setBlackboardPick}
        assets={assets}
        allowedTypes={["Blackboard"]}
        title="Pick Blackboard"
        allowNone
        onPick={(guid) => {
          commit({ ...doc, blackboardGuid: guid });
          setBlackboardPick(false);
        }}
        data-testid="bt-blackboard-picker"
      />
    </div>
  );
}
