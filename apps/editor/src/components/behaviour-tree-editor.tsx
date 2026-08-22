import { useEffect, useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  addDecorator,
  addService,
  arrangeBehaviourTree,
  behaviourTreeToSerialized,
  BT_CHILDREN_HANDLE,
  BT_COMPOSITE_CATALOG,
  BT_DECORATOR_CATALOG,
  BT_NODE_TYPE,
  BT_PARENT_HANDLE,
  BT_SERVICE_CATALOG,
  BT_TASK_CATALOG,
  canReparentNode,
  createDefaultBehaviourTree,
  defaultPropertiesForClassId,
  deleteSubtree,
  duplicateSubtree,
  hydrateBehaviourTreeForEditor,
  kindForCatalogClassId,
  moveAttachment,
  parseBehaviourTreeDocument,
  parseBlackboardDocument,
  pinsForBtKind,
  propertyFieldsForClassId,
  removeAttachment,
  titleForBtClassId,
  validateBehaviourTree,
  wrapInSequence,
  type BehaviourTreeDocument,
  type BlackboardDocument,
  type BtAbortMode,
  type BtCatalogEntry,
  type BtGraphOverlay,
  type BtNode,
  type BtPropertyField,
  type BtResult,
} from "@babylonslate/behaviour-tree";
import {
  AssetPicker,
  CatalogDialog,
  CatalogItemButton,
  NamedListEditor,
  PanelFrame,
  PropertyGrid,
  SelectableText,
  TypeColorMark,
  WindowedList,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
  assetRowIdentity,
  humanizePropertyLabel,
  pinPickerColorVar,
  pinPickerLabel,
  useCatalogSearchState,
  walkAncestry,
  type NestedMenuItem,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { GraphEditor, treeNodeTypes, type PaletteNode } from "@babylonslate/graph-ui";
import { defaultJsValue } from "@babylonslate/scripting";
import { Badge } from "@babylonslate/ui/components/badge";
import { Button } from "@babylonslate/ui/components/button";
import { Empty, EmptyDescription, EmptyTitle } from "@babylonslate/ui/components/empty";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { commitBehaviourTreeGraphChange } from "../lib/behaviour-tree-graph-commit";
import { classParentLookup } from "../lib/content-browser-helpers";
import { pinDefaultPropertyRows } from "../lib/graph-inspector";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useOpenAssetDocument } from "../lib/use-open-asset-document";
import { useBehaviourTreeEditing } from "../context/behaviour-tree-editing-context";
import { usePlay } from "../context/play-context";
import { useGraphSessionViewport } from "../lib/graph-session-viewport";

function asTree(payload: Record<string, unknown>): BehaviourTreeDocument {
  return parseBehaviourTreeDocument(payload) ?? createDefaultBehaviourTree();
}

function catalogPalette(entries: readonly BtCatalogEntry[]): PaletteNode[] {
  return entries.map((entry) => ({
    id: entry.classId,
    title: entry.title,
    category: entry.category,
    nodeType: BT_NODE_TYPE,
    pins: pinsForBtKind(kindForCatalogClassId(entry.classId)),
    defaultData: {
      title: entry.title,
      classId: entry.classId,
      kind: kindForCatalogClassId(entry.classId),
      properties: defaultPropertiesForClassId(entry.classId),
    },
  }));
}

function vectorFromUnknown(value: unknown): [number, number, number] {
  if (Array.isArray(value) && value.length >= 3) {
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return [Number(row.x) || 0, Number(row.y) || 0, Number(row.z) || 0];
  }
  return [0, 0, 0];
}

function propertyValue(field: BtPropertyField, properties: Record<string, unknown>): unknown {
  return properties[field.key];
}

function useBehaviourTreeDocument() {
  const { documentId: workspaceDocumentId } = useDocumentWorkspace();
  const {
    assetRegistry,
    openDocument,
    openDocuments,
    applyAssetDocumentChange,
    loadAssetDocument,
  } = useDocuments();
  const play = usePlay();
  const entry = openDocuments.find((item) => item.id === workspaceDocumentId);
  const doc = useMemo(
    () => asTree((entry?.content ?? {}) as Record<string, unknown>),
    [entry?.content],
  );
  const commit = (next: BehaviourTreeDocument) => {
    void applyAssetDocumentChange(
      workspaceDocumentId,
      next as unknown as Record<string, unknown>,
    );
  };
  const overlay = useMemo((): BtGraphOverlay | undefined => {
    if (!play.playing || !play.liveBtState) return undefined;
    return {
      lastResults: play.liveBtState.lastResults as Record<string, BtResult>,
      btNodeId: play.liveBtState.btNodeId,
      stack: (play.liveBtState.stack ?? []).map((frame) => ({
        nodeId: frame.nodeId,
        childIndex: frame.childIndex,
        opened: frame.opened,
      })),
    };
  }, [play.playing, play.liveBtState]);
  const initialGraph = useMemo(
    () => hydrateBehaviourTreeForEditor(behaviourTreeToSerialized(doc, overlay)),
    [doc, overlay],
  );
  const assets = (assetRegistry?.list() ?? []).map((asset) => {
    const payload =
      asset.header.payload && typeof asset.header.payload === "object"
        ? (asset.header.payload as Record<string, unknown>)
        : {};
    return {
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
      path: asset.path,
      parentClass: asset.header.parentClass,
      clipName: typeof payload.clipName === "string" ? payload.clipName : "",
    };
  });
  const parentOf = classParentLookup(assetRegistry?.list() ?? []);
  const customEntries = (
    kind: "BTTask" | "BTDecorator" | "BTService" | "BTComposite",
  ) =>
    assets.filter((asset) => {
      if (asset.type !== "Class") return false;
      const chain = walkAncestry(asset.parentClass ?? asset.name, parentOf);
      return chain.includes(kind) || asset.parentClass === kind || asset.name === kind;
    });
  const paletteNodes: PaletteNode[] = [
    ...catalogPalette(BT_COMPOSITE_CATALOG),
    ...catalogPalette(BT_TASK_CATALOG),
    ...customEntries("BTComposite").map((asset) => {
      const kind = kindForCatalogClassId(asset.name, parentOf);
      return {
        id: asset.name,
        title: titleForBtClassId(asset.name),
        category: "Composites",
        nodeType: BT_NODE_TYPE,
        pins: pinsForBtKind(kind),
        defaultData: {
          title: titleForBtClassId(asset.name),
          classId: asset.name,
          kind,
        },
      };
    }),
    ...customEntries("BTTask").map((asset) => ({
      id: asset.name,
      title: titleForBtClassId(asset.name),
      category: "Tasks",
      nodeType: BT_NODE_TYPE,
      pins: pinsForBtKind("task"),
      defaultData: {
        title: titleForBtClassId(asset.name),
        classId: asset.name,
        kind: "task" as const,
      },
    })),
  ];
  const decoratorCatalog: BtCatalogEntry[] = [
    ...BT_DECORATOR_CATALOG,
    ...customEntries("BTDecorator").map((asset) => ({
      classId: asset.name,
      title: titleForBtClassId(asset.name),
      category: "Decorators" as const,
      kind: "decorator" as const,
    })),
  ];
  const serviceCatalog: BtCatalogEntry[] = [
    ...BT_SERVICE_CATALOG,
    ...customEntries("BTService").map((asset) => ({
      classId: asset.name,
      title: titleForBtClassId(asset.name),
      category: "Services" as const,
      kind: "service" as const,
    })),
  ];
  const blackboardAsset = doc.blackboardGuid
    ? assetRegistry?.getByGuid(doc.blackboardGuid)
    : undefined;
  const blackboardPath = blackboardAsset?.path;
  const linkedBlackboardContent = blackboardPath
    ? openDocuments.find(
        (item) =>
          item.ref.kind === "blackboard" && item.ref.path === blackboardPath,
      )?.content
    : undefined;
  const [loadedBlackboard, setLoadedBlackboard] = useState<BlackboardDocument | null>(
    null,
  );
  useEffect(() => {
    if (!blackboardPath) {
      setLoadedBlackboard(null);
      return;
    }
    if (linkedBlackboardContent && typeof linkedBlackboardContent === "object") {
      return;
    }
    let cancelled = false;
    void loadAssetDocument("blackboard", blackboardPath).then((payload) => {
      if (cancelled || !payload || typeof payload !== "object") return;
      setLoadedBlackboard(
        parseBlackboardDocument(payload as Record<string, unknown>),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [blackboardPath, linkedBlackboardContent, loadAssetDocument]);
  const blackboardDocument = useMemo(() => {
    if (linkedBlackboardContent && typeof linkedBlackboardContent === "object") {
      return parseBlackboardDocument(
        linkedBlackboardContent as Record<string, unknown>,
      );
    }
    return loadedBlackboard;
  }, [linkedBlackboardContent, loadedBlackboard]);
  const blackboardKeyEntries = blackboardDocument?.keys ?? [];
  const blackboardKeys = blackboardKeyEntries.map((key) => key.name);
  const diagnostics = validateBehaviourTree(doc, {
    assetGuid: blackboardAsset?.header.guid ?? "tree",
    blackboardKeys: blackboardKeys.length > 0 ? blackboardKeys : undefined,
  });
  const openClass = (classId: string) => {
    const asset = (assetRegistry?.list() ?? []).find(
      (item) =>
        item.header.type === "Class" &&
        (item.header.name === classId || item.header.guid === classId),
    );
    if (!asset) return;
    void openDocument({
      kind: "graph",
      path: asset.path,
      label: asset.header.name,
    });
  };
  return {
    doc,
    commit,
    play,
    initialGraph,
    paletteNodes,
    decoratorCatalog,
    serviceCatalog,
    assets,
    parentOf,
    blackboardAsset,
    blackboardDocument,
    blackboardKeys,
    blackboardKeyEntries,
    diagnostics,
    openClass,
    openDocument,
    openDocuments,
    applyAssetDocumentChange,
    documentId: workspaceDocumentId,
  };
}

export function BehaviourTreeGraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const {
    doc,
    commit,
    play,
    initialGraph,
    paletteNodes,
    diagnostics,
    openClass,
    documentId,
  } = useBehaviourTreeDocument();
  const { sessionViewport, onSessionViewportChange } =
    useGraphSessionViewport(documentId);
  const {
    selectedId,
    attachmentId,
    focusedNodeId,
    setSelectedId,
    setAttachmentId,
    setAttachmentCatalog,
  } = useBehaviourTreeEditing();
  const knownNodeIds = useRef<Set<string> | null>(null);
  const nodeIdKey = doc.nodes.map((node) => node.id).join("\0");
  useEffect(() => {
    const current = new Set(doc.nodes.map((node) => node.id));
    if (knownNodeIds.current === null) {
      knownNodeIds.current = current;
      return;
    }
    const added = [...current].filter((id) => !knownNodeIds.current!.has(id));
    knownNodeIds.current = current;
    if (added.length === 0) return;
    setSelectedId(added[added.length - 1]!);
    setAttachmentId(null);
  }, [doc.nodes, nodeIdKey, setAttachmentId, setSelectedId]);

  const selected = doc.nodes.find((node) => node.id === selectedId) ?? null;

  const nodeMenu = (nodeId: string): NestedMenuItem[] => [
    {
      id: "add-decorator",
      label: "Add Decorator",
      testId: "bt-menu-add-decorator",
      onSelect: () => {
        setSelectedId(nodeId);
        setAttachmentCatalog("decorator");
      },
    },
    {
      id: "wrap",
      label: "Wrap In Sequence",
      testId: "bt-menu-wrap",
      onSelect: () => commit(wrapInSequence(doc, nodeId)),
    },
    {
      id: "duplicate",
      label: "Duplicate",
      testId: "bt-menu-duplicate",
      disabled: nodeId === doc.rootId,
      onSelect: () => commit(duplicateSubtree(doc, nodeId)),
    },
    {
      id: "delete",
      label: "Delete",
      testId: "bt-menu-delete",
      variant: "destructive",
      disabled: nodeId === doc.rootId,
      onSelect: () => {
        commit(deleteSubtree(doc, nodeId));
        if (selectedId === nodeId) setSelectedId(doc.rootId);
      },
    },
  ];

  const attachmentMenu = (nodeId: string, id: string): NestedMenuItem[] => [
    {
      id: "open-class",
      label: "Open Class",
      onSelect: () => {
        const node = doc.nodes.find((item) => item.id === nodeId);
        const row =
          node?.decorators.find((item) => item.id === id) ??
          node?.services.find((item) => item.id === id);
        if (row) openClass(row.classId);
      },
    },
    {
      id: "remove",
      label: "Remove",
      variant: "destructive",
      testId: "bt-menu-remove-attachment",
      onSelect: () => {
        commit(removeAttachment(doc, nodeId, id));
        setAttachmentId(null);
      },
    },
  ];

  return (
    <PanelFrame className="flex-1">
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="behaviour-tree-editor"
      >
        <GraphEditor
          initialGraph={initialGraph}
          nodeTypes={treeNodeTypes}
          nodesDraggable={!play.playing}
          nodeDragHandle=".bt-node-drag-handle"
          connectEndMode="add-node"
          replaceIncomingOnConnect
          deleteKeyCode={null}
          nodesFocusable={false}
          sessionViewport={sessionViewport}
          onSessionViewportChange={onSessionViewportChange}
          canConnect={(connection) => {
            if (connection.sourceHandle !== BT_CHILDREN_HANDLE) return false;
            if (connection.targetHandle !== BT_PARENT_HANDLE) return false;
            return canReparentNode(doc, connection.target, connection.source);
          }}
          commitPositionsOnDragEnd
          readOnly={play.playing}
          paletteNodes={paletteNodes}
          diagnostics={diagnostics}
          focusedNodeId={play.focusedNodeId ?? focusedNodeId ?? undefined}
          selectedAttachmentId={attachmentId}
          onAttachmentSelect={(id) => {
            setAttachmentId(id);
            if (!id) return;
            const owner = doc.nodes.find(
              (node) =>
                node.decorators.some((row) => row.id === id) ||
                node.services.some((row) => row.id === id),
            );
            if (owner) setSelectedId(owner.id);
          }}
          onAttachmentDoubleClick={(nodeId, id) => {
            const node = doc.nodes.find((item) => item.id === nodeId);
            const row =
              node?.decorators.find((item) => item.id === id) ??
              node?.services.find((item) => item.id === id);
            if (row) openClass(row.classId);
          }}
          onNodeDoubleClick={(nodeId) => {
            const node = doc.nodes.find((item) => item.id === nodeId);
            if (node) openClass(node.classId);
          }}
          onNavigateRequest={(request) => {
            if (request.nodeId) {
              const node = doc.nodes.find((item) => item.id === request.nodeId);
              if (node) openClass(node.classId);
            }
          }}
          contextMenuItemsForNode={nodeMenu}
          contextMenuItemsForAttachment={attachmentMenu}
          hiddenToolbarActions={["copy", "paste", "breakLinks", "format"]}
          onSelectionChange={(nodeIds) => {
            const nextId = nodeIds[0];
            if (!nextId) return;
            setSelectedId(nextId);
            setAttachmentId((current) => {
              if (!current) return null;
              const owner = doc.nodes.find((node) => node.id === nextId);
              if (!owner) return null;
              const onNode =
                owner.decorators.some((row) => row.id === current) ||
                owner.services.some((row) => row.id === current);
              return onNode ? current : null;
            });
          }}
          toolbarExtra={
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="bt-auto-arrange"
              onClick={() => commit(arrangeBehaviourTree(doc))}
            >
              Auto Arrange
            </Button>
          }
          onChange={(graph, meta) => {
            const parentId =
              selected && selected.kind !== "task" ? selected.id : doc.rootId;
            const { next } = commitBehaviourTreeGraphChange(
              doc,
              graph,
              meta,
              parentId,
            );
            commit(next);
          }}
        />
      </div>
    </PanelFrame>
  );
}

export function BehaviourTreeBlackboardPanel(_props: IDockviewPanelProps) {
  void _props;
  const {
    doc,
    commit,
    play,
    assets,
    blackboardAsset,
    blackboardDocument,
  } = useBehaviourTreeDocument();
  const [blackboardPick, setBlackboardPick] = useState(false);
  const openAssetDocument = useOpenAssetDocument();
  const blackboardWatch = play.liveBtState?.blackboard ?? null;
  const keys = blackboardDocument?.keys ?? [];

  return (
    <PanelFrame className="flex-1" data-testid="behaviour-tree-blackboard">
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <PropertyGrid
          rows={[
            {
              id: "blackboard",
              kind: "asset",
              label: "Blackboard",
              value: doc.blackboardGuid,
              placeholder: "None",
              onPick: () => setBlackboardPick(true),
              onOpenAsset: blackboardAsset
                ? () =>
                    void openAssetDocument({
                      type: blackboardAsset.header.type,
                      path: blackboardAsset.path,
                    })
                : undefined,
              onChange: (value) => commit({ ...doc, blackboardGuid: value }),
              ...assetRowIdentity(
                blackboardAsset
                  ? {
                      name: blackboardAsset.header.name,
                      type: blackboardAsset.header.type,
                      path: blackboardAsset.path,
                    }
                  : undefined,
              ),
            },
          ]}
        />
        {doc.blackboardGuid ? (
          keys.length > 0 ? (
            <ScrollArea className="min-h-0 flex-1" data-testid="bt-blackboard-keys">
              <ul className="flex flex-col gap-1">
                {keys.map((key) => (
                  <li
                    key={key.name}
                    className="flex min-h-11 items-center justify-between gap-2 rounded-md px-2 text-sm"
                    data-testid={`bt-blackboard-key-${key.name}`}
                  >
                    <SelectableText>{key.name}</SelectableText>
                    <TypeColorMark
                      colorVar={pinPickerColorVar(key.type.kind)}
                      label={pinPickerLabel(key.type.kind)}
                    />
                  </li>
                ))}
              </ul>
            </ScrollArea>
          ) : (
            <Empty>
              <EmptyTitle>No Keys</EmptyTitle>
              <EmptyDescription>
                Open the Blackboard document to add keys.
              </EmptyDescription>
            </Empty>
          )
        ) : (
          <Empty>
            <EmptyTitle>No Blackboard</EmptyTitle>
            <EmptyDescription>
              Link a Blackboard asset to inspect keys.
            </EmptyDescription>
          </Empty>
        )}
        {blackboardWatch ? (
          <div data-testid="bt-blackboard-watch" className="text-xs">
            {Object.entries(blackboardWatch).map(([key, value]) => (
              <div key={key}>
                <SelectableText>
                  {key}: {String(value)}
                </SelectableText>
              </div>
            ))}
          </div>
        ) : null}
      </div>
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
    </PanelFrame>
  );
}

export function BehaviourTreeCompilerResultsPanel(_props: IDockviewPanelProps) {
  void _props;
  const { diagnostics } = useBehaviourTreeDocument();
  const { focusNode } = useBehaviourTreeEditing();

  return (
    <PanelFrame className="flex-1" data-testid="behaviour-tree-compiler-results">
      {diagnostics.length === 0 ? (
        <Empty>
          <EmptyTitle>No Issues</EmptyTitle>
          <EmptyDescription>
            This behaviour tree compiles cleanly.
          </EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="h-full p-2">
          <WindowedList
            itemCount={diagnostics.length}
            rowHeight={WINDOWED_LIST_TOUCH_ROW_HEIGHT}
          >
            {(index) => {
              const row = diagnostics[index]!;
              return (
                <Button
                  type="button"
                  variant="ghost"
                  size="touch"
                  className="h-full w-full min-h-0 justify-start gap-2 overflow-hidden text-left"
                  onClick={() => {
                    if (row.nodeId) focusNode(row.nodeId);
                  }}
                  data-testid={`behaviour-tree-diagnostic-${row.code}`}
                  data-severity={row.severity}
                >
                  <Badge variant={row.severity === "error" ? "destructive" : "secondary"}>
                    {humanizePropertyLabel(row.severity)}
                  </Badge>
                  <SelectableText className="truncate">{row.message}</SelectableText>
                </Button>
              );
            }}
          </WindowedList>
        </ScrollArea>
      )}
    </PanelFrame>
  );
}

export function BehaviourTreeDetailsPanel(_props: IDockviewPanelProps) {
  void _props;
  const {
    doc,
    commit,
    decoratorCatalog,
    serviceCatalog,
    parentOf,
    blackboardKeys,
    blackboardKeyEntries,
    assets,
  } = useBehaviourTreeDocument();
  const openAssetDocument = useOpenAssetDocument();
  const {
    selectedId,
    attachmentId,
    attachmentCatalog,
    setAttachmentId,
    setAttachmentCatalog,
  } = useBehaviourTreeEditing();
  const catalogSearch = useCatalogSearchState();
  const [assetPick, setAssetPick] = useState<{
    key: string;
    assetType: string;
    write: (value: string | null) => void;
  } | null>(null);
  const selected = doc.nodes.find((node) => node.id === selectedId) ?? null;
  const attachment =
    selected?.decorators.find((row) => row.id === attachmentId) ??
    selected?.services.find((row) => row.id === attachmentId) ??
    null;
  const isDecorator = Boolean(
    selected?.decorators.some((row) => row.id === attachmentId),
  );
  const keyOptions = [
    { value: "", label: "None" },
    ...blackboardKeys.map((key) => ({ value: key, label: key })),
  ];

  const toRows = (
    fields: BtPropertyField[],
    properties: Record<string, unknown>,
    write: (updates: Record<string, unknown>) => void,
  ): PropertyRow[] => {
    const typedValue =
      fields.some((field) => field.kind === "blackboardKey") &&
      fields.some((field) => field.key === "value");
    const selectedKey = typeof properties.key === "string" ? properties.key : "";
    const selectedType = blackboardKeyEntries.find(
      (entry) => entry.name === selectedKey,
    )?.type;
    return fields.flatMap((field) => {
      if (typedValue && field.key === "value") {
        if (!selectedKey || !selectedType) return [];
        const rows = pinDefaultPropertyRows(
          [
            {
              pinId: field.id,
              name: field.key,
              type: selectedType,
              value: propertyValue(field, properties),
            },
          ],
          (patch) => {
            if ("default:value" in patch) write({ value: patch["default:value"] });
          },
        );
        if (rows.length > 0) return rows;
        const raw = propertyValue(field, properties);
        return [
          {
            id: field.id,
            kind: "text" as const,
            label: field.label,
            value: raw === undefined ? "" : String(raw),
            onChange: (value: string) => write({ [field.key]: value }),
          },
        ];
      }
      const raw = propertyValue(field, properties);
      if (field.kind === "number") {
        return [
          {
            id: field.id,
            kind: "number" as const,
            label: field.label,
            value: Number(raw ?? 0),
            min: field.min,
            max: field.max,
            onChange: (value: number) => write({ [field.key]: value }),
          },
        ];
      }
      if (field.kind === "boolean") {
        return [
          {
            id: field.id,
            kind: "boolean" as const,
            label: field.label,
            value: Boolean(raw),
            onChange: (value: boolean) => write({ [field.key]: value }),
          },
        ];
      }
      if (field.kind === "vector3") {
        return [
          {
            id: field.id,
            kind: "vector3" as const,
            label: field.label,
            value: vectorFromUnknown(raw),
            onChange: (value: [number, number, number]) =>
              write({ [field.key]: { x: value[0], y: value[1], z: value[2] } }),
          },
        ];
      }
      if (field.kind === "enum" || (field.kind === "blackboardKey" && keyOptions.length > 1)) {
        return [
          {
            id: field.id,
            kind: "enum" as const,
            label: field.label,
            value: String(raw ?? ""),
            options: field.options ?? keyOptions,
            onChange: (value: string) => {
              if (field.key === "clipKind") {
                write({ clipKind: value, clipAssetGuid: "", clipName: "" });
                return;
              }
              if (field.kind === "blackboardKey" && typedValue) {
                const type = blackboardKeyEntries.find(
                  (entry) => entry.name === value,
                )?.type;
                write(
                  type
                    ? { [field.key]: value, value: defaultJsValue(type) }
                    : { [field.key]: value },
                );
                return;
              }
              write({ [field.key]: value });
            },
          },
        ];
      }
      if (field.kind === "asset") {
        const guid = typeof raw === "string" ? raw : "";
        const picked = assets.find((asset) => asset.guid === guid);
        return [
          {
            id: field.id,
            kind: "asset" as const,
            label: field.label,
            value: guid || null,
            placeholder: "None",
            onPick: () =>
              setAssetPick({
                key: field.key,
                assetType: field.assetType ?? "Audio",
                write: (value) => {
                  if (field.key === "clipAssetGuid") {
                    const picked = assets.find((asset) => asset.guid === value);
                    write({
                      clipAssetGuid: value ?? "",
                      clipName:
                        field.assetType === "Animation"
                          ? (picked?.clipName ?? "")
                          : "",
                    });
                    return;
                  }
                  write({ [field.key]: value ?? "" });
                },
              }),
            onChange: (value: string | null) => {
              if (field.key === "clipAssetGuid") {
                write({ clipAssetGuid: value ?? "", clipName: "" });
                return;
              }
              write({ [field.key]: value ?? "" });
            },
            onOpenAsset: picked
              ? () => void openAssetDocument(picked)
              : undefined,
            path: picked?.path,
            ...assetRowIdentity(
              picked ? { name: picked.name, type: picked.type } : undefined,
            ),
          },
        ];
      }
      return [
        {
          id: field.id,
          kind: "text" as const,
          label: field.label,
          value: raw === undefined ? "" : String(raw),
          onChange: (value: string) => write({ [field.key]: value }),
        },
      ];
    });
  };

  const rows: PropertyRow[] = [];
  if (selected && !attachment) {
    const classOptions = (
      selected.kind === "task" ? BT_TASK_CATALOG : BT_COMPOSITE_CATALOG
    ).map((entry) => ({ value: entry.classId, label: entry.title }));
    rows.push({
      id: "classId",
      kind: "enum",
      label: "Class",
      value: selected.classId,
      options: classOptions.some((row) => row.value === selected.classId)
        ? classOptions
        : [{ value: selected.classId, label: titleForBtClassId(selected.classId) }, ...classOptions],
      onChange: (classId) =>
        commit(
          patchNode(doc, selected.id, {
            classId,
            kind: kindForCatalogClassId(classId, parentOf),
            properties: { ...selected.properties },
          }),
        ),
    });
    rows.push(
      ...toRows(
        propertyFieldsForClassId(selected.classId, selected.properties),
        selected.properties,
        (updates) =>
        commit(
          patchNode(doc, selected.id, {
            properties: { ...selected.properties, ...updates },
          }),
        ),
      ),
    );
  }
  if (selected && attachment && isDecorator) {
    const classOptions = decoratorCatalog.map((entry) => ({
      value: entry.classId,
      label: entry.title,
    }));
    rows.push({
      id: "attachmentClass",
      kind: "enum",
      label: "Decorator",
      value: attachment.classId,
      options: classOptions.some((row) => row.value === attachment.classId)
        ? classOptions
        : [
            {
              value: attachment.classId,
              label: titleForBtClassId(attachment.classId),
            },
            ...classOptions,
          ],
      onChange: (classId) =>
        commit(
          patchNode(doc, selected.id, {
            decorators: selected.decorators.map((row) =>
              row.id === attachment.id ? { ...row, classId } : row,
            ),
          }),
        ),
    });
    rows.push({
      id: "abortMode",
      kind: "enum",
      label: "Abort Mode",
      value: "abortMode" in attachment ? attachment.abortMode : "none",
      options: [
        { value: "none", label: "None" },
        { value: "self", label: "Self" },
        { value: "lowerPriority", label: "Lower Priority" },
        { value: "both", label: "Both" },
      ],
      onChange: (value) =>
        commit(
          patchNode(doc, selected.id, {
            decorators: selected.decorators.map((row) =>
              row.id === attachment.id
                ? { ...row, abortMode: value as BtAbortMode }
                : row,
            ),
          }),
        ),
    });
    rows.push(
      ...toRows(propertyFieldsForClassId(attachment.classId, attachment.properties), attachment.properties, (updates) =>
        commit(
          patchNode(doc, selected.id, {
            decorators: selected.decorators.map((row) =>
              row.id === attachment.id
                ? { ...row, properties: { ...row.properties, ...updates } }
                : row,
            ),
          }),
        ),
      ),
    );
  }
  if (selected && attachment && !isDecorator) {
    const classOptions = serviceCatalog.map((entry) => ({
      value: entry.classId,
      label: entry.title,
    }));
    rows.push({
      id: "attachmentClass",
      kind: "enum",
      label: "Service",
      value: attachment.classId,
      options: classOptions.some((row) => row.value === attachment.classId)
        ? classOptions
        : [
            {
              value: attachment.classId,
              label: titleForBtClassId(attachment.classId),
            },
            ...classOptions,
          ],
      onChange: (classId) =>
        commit(
          patchNode(doc, selected.id, {
            services: selected.services.map((row) =>
              row.id === attachment.id ? { ...row, classId } : row,
            ),
          }),
        ),
    });
    if ("intervalMs" in attachment) {
      rows.push({
        id: "intervalMs",
        kind: "number",
        label: "Interval MS",
        value: attachment.intervalMs,
        min: 0,
        onChange: (intervalMs) =>
          commit(
            patchNode(doc, selected.id, {
              services: selected.services.map((row) =>
                row.id === attachment.id ? { ...row, intervalMs } : row,
              ),
            }),
          ),
      });
      rows.push({
        id: "randomDeviationMs",
        kind: "number",
        label: "Random Deviation MS",
        value: attachment.randomDeviationMs,
        min: 0,
        onChange: (randomDeviationMs) =>
          commit(
            patchNode(doc, selected.id, {
              services: selected.services.map((row) =>
                row.id === attachment.id ? { ...row, randomDeviationMs } : row,
              ),
            }),
          ),
      });
    }
    rows.push(
      ...toRows(propertyFieldsForClassId(attachment.classId, attachment.properties), attachment.properties, (updates) =>
        commit(
          patchNode(doc, selected.id, {
            services: selected.services.map((row) =>
              row.id === attachment.id
                ? { ...row, properties: { ...row.properties, ...updates } }
                : row,
            ),
          }),
        ),
      ),
    );
  }

  const catalogEntries =
    attachmentCatalog === "service" ? serviceCatalog : decoratorCatalog;
  const filteredCatalog = catalogEntries.filter((entry) => {
    const needle = catalogSearch.search.trim().toLowerCase();
    if (!needle) return true;
    return `${entry.title} ${entry.classId}`.toLowerCase().includes(needle);
  });

  return (
    <PanelFrame>
      <div data-testid="bt-details" className="flex flex-col gap-2 p-2">
        <PropertyGrid rows={rows} />
        {selected && attachment && "observedKeys" in attachment ? (
          <NamedListEditor
            title="Observed Keys"
            values={attachment.observedKeys}
            addLabel="Add Key"
            data-testid="bt-observed-keys"
            onChange={(observedKeys) =>
              commit(
                patchNode(doc, selected.id, {
                  decorators: selected.decorators.map((row) =>
                    row.id === attachment.id ? { ...row, observedKeys } : row,
                  ),
                }),
              )
            }
          />
        ) : null}
        {selected ? (
          <div className="flex flex-col gap-1">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              data-testid="bt-add-decorator"
              onClick={() => setAttachmentCatalog("decorator")}
            >
              Add Decorator
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              data-testid="bt-add-service"
              onClick={() => setAttachmentCatalog("service")}
            >
              Add Service
            </Button>
            {attachment ? (
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  data-testid="bt-attachment-up"
                  onClick={() => commit(moveAttachment(doc, selected.id, attachment.id, -1))}
                >
                  Move Up
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  data-testid="bt-attachment-down"
                  onClick={() => commit(moveAttachment(doc, selected.id, attachment.id, 1))}
                >
                  Move Down
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  data-testid="bt-remove-attachment"
                  onClick={() => {
                    commit(removeAttachment(doc, selected.id, attachment.id));
                    setAttachmentId(null);
                  }}
                >
                  Remove
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Select a node</p>
        )}
      </div>
      <AssetPicker
        open={assetPick !== null}
        onOpenChange={(open) => {
          if (!open) setAssetPick(null);
        }}
        assets={assets}
        allowedTypes={assetPick ? [assetPick.assetType] : ["Audio"]}
        title={
          assetPick
            ? `Pick ${humanizePropertyLabel(assetPick.assetType)}`
            : "Pick Asset"
        }
        allowNone
        onPick={(guid) => {
          assetPick?.write(guid);
          setAssetPick(null);
        }}
        data-testid="bt-asset-picker"
      />
      <CatalogDialog
        open={attachmentCatalog !== null}
        onOpenChange={(open) => {
          if (!open) setAttachmentCatalog(null);
        }}
        title={attachmentCatalog === "service" ? "Add Service" : "Add Decorator"}
        categories={[{ id: "all", label: "All", count: catalogEntries.length }]}
        activeCategoryId="all"
        onCategoryChange={() => undefined}
        search={catalogSearch.search}
        onSearchChange={catalogSearch.setSearch}
        data-testid="bt-attachment-catalog"
      >
        <div className="flex flex-col gap-2">
          {filteredCatalog.map((entry) => (
            <CatalogItemButton
              key={entry.classId}
              data-testid={`bt-attachment-item-${entry.classId}`}
              onClick={() => {
                if (!selected) return;
                const next =
                  attachmentCatalog === "service"
                    ? addService(doc, selected.id, entry.classId)
                    : addDecorator(doc, selected.id, entry.classId);
                const node = next.nodes.find((row) => row.id === selected.id);
                const added =
                  attachmentCatalog === "service"
                    ? node?.services.at(-1)?.id
                    : node?.decorators.at(-1)?.id;
                commit(next);
                if (added) setAttachmentId(added);
                setAttachmentCatalog(null);
              }}
            >
              {entry.title}
            </CatalogItemButton>
          ))}
        </div>
      </CatalogDialog>
    </PanelFrame>
  );
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
