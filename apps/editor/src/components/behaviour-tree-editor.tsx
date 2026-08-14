import { useMemo, useState } from "react";
import {
  addDecorator,
  addService,
  behaviourTreeToSerialized,
  BT_COMPOSITE_CATALOG,
  BT_DECORATOR_CATALOG,
  BT_NODE_TYPE,
  BT_SERVICE_CATALOG,
  BT_TASK_CATALOG,
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
  pruneUnreachable,
  removeAttachment,
  reorderSiblingsByPosition,
  serializedToBehaviourTree,
  titleForBtClassId,
  validateBehaviourTree,
  wrapInSequence,
  type BehaviourTreeDocument,
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
  useCatalogSearchState,
  walkAncestry,
  type NestedMenuItem,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import { GraphEditor, treeNodeTypes, type PaletteNode } from "@babylonslate/graph-ui";
import { Button } from "@babylonslate/ui/components/button";
import { classParentLookup } from "../lib/content-browser-helpers";
import { useDocuments } from "../context/document-context";
import { usePlay } from "../context/play-context";

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

export function BehaviourTreeEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { assetRegistry, openDocument, openDocuments } = useDocuments();
  const play = usePlay();
  const doc = useMemo(() => asTree(payload), [payload]);
  const [selectedId, setSelectedId] = useState<string | null>(doc.rootId);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [blackboardPick, setBlackboardPick] = useState(false);
  const [attachmentCatalog, setAttachmentCatalog] = useState<
    "decorator" | "service" | null
  >(null);
  const catalogSearch = useCatalogSearchState();
  const commit = (next: BehaviourTreeDocument) => {
    onChange(next as unknown as Record<string, unknown>);
  };
  const selected = doc.nodes.find((node) => node.id === selectedId) ?? null;
  const overlay: BtGraphOverlay | undefined =
    play.playing && play.liveBtState
      ? {
          lastResults: play.liveBtState.lastResults as Record<string, BtResult>,
          btNodeId: play.liveBtState.btNodeId,
          stack: (play.liveBtState.stack ?? []).map((frame) => ({
            nodeId: frame.nodeId,
            childIndex: frame.childIndex,
            opened: frame.opened,
          })),
        }
      : undefined;
  const initialGraph = useMemo(
    () =>
      hydrateBehaviourTreeForEditor(
        behaviourTreeToSerialized(doc, overlay),
      ),
    [doc, overlay],
  );
  const assets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
    parentClass: asset.header.parentClass,
  }));
  const parentOf = classParentLookup(assetRegistry?.list() ?? []);
  const customEntries = (kind: "BTTask" | "BTDecorator" | "BTService" | "BTComposite") =>
    assets.filter((asset) => {
      if (asset.type !== "Class") return false;
      const chain = walkAncestry(asset.parentClass ?? asset.name, parentOf);
      return chain.includes(kind) || asset.parentClass === kind || asset.name === kind;
    });
  const paletteNodes: PaletteNode[] = [
    ...catalogPalette(BT_COMPOSITE_CATALOG),
    ...catalogPalette(BT_TASK_CATALOG),
    ...customEntries("BTComposite").map((asset) => ({
      id: asset.name,
      title: titleForBtClassId(asset.name),
      category: "Composites",
      nodeType: BT_NODE_TYPE,
      pins: pinsForBtKind("selector"),
      defaultData: {
        title: titleForBtClassId(asset.name),
        classId: asset.name,
        kind: "selector" as const,
      },
    })),
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
  const blackboardKeys = useMemo(() => {
    if (!blackboardAsset) return [];
    const open = (openDocuments ?? []).find(
      (entry) => entry.ref.path === blackboardAsset.path,
    );
    const parsed = open?.content
      ? parseBlackboardDocument(open.content as Record<string, unknown>)
      : null;
    return parsed?.keys.map((key) => key.name) ?? [];
  }, [blackboardAsset, openDocuments]);
  const attachment =
    selected?.decorators.find((row) => row.id === attachmentId) ??
    selected?.services.find((row) => row.id === attachmentId) ??
    null;
  const isDecorator = Boolean(
    selected?.decorators.some((row) => row.id === attachmentId),
  );
  const diagnostics = validateBehaviourTree(doc, {
    assetGuid: blackboardAsset?.header.guid ?? "tree",
    blackboardKeys: blackboardKeys.length > 0 ? blackboardKeys : undefined,
  }).map((row) => ({
    nodeId: row.nodeId,
    severity: row.severity,
    message: row.message,
  }));

  const keyOptions = [
    { value: "", label: "None" },
    ...blackboardKeys.map((key) => ({ value: key, label: key })),
  ];

  const toRows = (
    fields: BtPropertyField[],
    properties: Record<string, unknown>,
    write: (key: string, value: unknown) => void,
  ): PropertyRow[] =>
    fields.map((field) => {
      const raw = propertyValue(field, properties);
      if (field.kind === "number") {
        return {
          id: field.id,
          kind: "number",
          label: field.label,
          value: Number(raw ?? 0),
          min: field.min,
          onChange: (value) => write(field.key, value),
        };
      }
      if (field.kind === "boolean") {
        return {
          id: field.id,
          kind: "boolean",
          label: field.label,
          value: Boolean(raw),
          onChange: (value) => write(field.key, value),
        };
      }
      if (field.kind === "vector3") {
        return {
          id: field.id,
          kind: "vector3",
          label: field.label,
          value: vectorFromUnknown(raw),
          onChange: (value) =>
            write(field.key, { x: value[0], y: value[1], z: value[2] }),
        };
      }
      if (field.kind === "enum" || (field.kind === "blackboardKey" && keyOptions.length > 1)) {
        return {
          id: field.id,
          kind: "enum",
          label: field.label,
          value: String(raw ?? ""),
          options: field.options ?? keyOptions,
          onChange: (value) => write(field.key, value),
        };
      }
      return {
        id: field.id,
        kind: "text",
        label: field.label,
        value: raw === undefined ? "" : String(raw),
        onChange: (value) => write(field.key, value),
      };
    });

  const rows: PropertyRow[] = [
    {
      id: "blackboard",
      kind: "asset",
      label: "Blackboard",
      value: doc.blackboardGuid,
      placeholder: "None",
      displayLabel: blackboardAsset?.header.name,
      onPick: () => setBlackboardPick(true),
      onChange: (value) => commit({ ...doc, blackboardGuid: value }),
    },
  ];
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
            kind: kindForCatalogClassId(classId),
            properties: { ...selected.properties },
          }),
        ),
    });
    rows.push(
      ...toRows(propertyFieldsForClassId(selected.classId), selected.properties, (key, value) =>
        commit(
          patchNode(doc, selected.id, {
            properties: { ...selected.properties, [key]: value },
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
      ...toRows(propertyFieldsForClassId(attachment.classId), attachment.properties, (key, value) =>
        commit(
          patchNode(doc, selected.id, {
            decorators: selected.decorators.map((row) =>
              row.id === attachment.id
                ? { ...row, properties: { ...row.properties, [key]: value } }
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
      ...toRows(propertyFieldsForClassId(attachment.classId), attachment.properties, (key, value) =>
        commit(
          patchNode(doc, selected.id, {
            services: selected.services.map((row) =>
              row.id === attachment.id
                ? { ...row, properties: { ...row.properties, [key]: value } }
                : row,
            ),
          }),
        ),
      ),
    );
  }

  const openClass = (classId: string) => {
    const asset = (assetRegistry?.list() ?? []).find(
      (entry) =>
        entry.header.type === "Class" &&
        (entry.header.name === classId || entry.header.guid === classId),
    );
    if (!asset) return;
    void openDocument({
      kind: "graph",
      path: asset.path,
      label: asset.header.name,
    });
  };

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
        const node = doc.nodes.find((entry) => entry.id === nodeId);
        const row =
          node?.decorators.find((entry) => entry.id === id) ??
          node?.services.find((entry) => entry.id === id);
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

  const blackboardWatch = play.liveBtState?.blackboard ?? null;
  const catalogEntries =
    attachmentCatalog === "service" ? serviceCatalog : decoratorCatalog;
  const filteredCatalog = catalogEntries.filter((entry) => {
    const needle = catalogSearch.search.trim().toLowerCase();
    if (!needle) return true;
    return `${entry.title} ${entry.classId}`.toLowerCase().includes(needle);
  });

  return (
    <div className="flex min-h-0 flex-1" data-testid="behaviour-tree-editor">
      <div className="flex min-h-0 min-w-0 flex-1">
        <GraphEditor
          initialGraph={initialGraph}
          nodeTypes={treeNodeTypes}
          nodesDraggable={!play.playing}
          lockNodeDragAxis="x"
          readOnly={play.playing}
          paletteNodes={paletteNodes}
          diagnostics={diagnostics}
          focusedNodeId={play.focusedNodeId ?? selectedId ?? undefined}
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
            const node = doc.nodes.find((entry) => entry.id === nodeId);
            const row =
              node?.decorators.find((entry) => entry.id === id) ??
              node?.services.find((entry) => entry.id === id);
            if (row) openClass(row.classId);
          }}
          onNodeDoubleClick={(nodeId) => {
            const node = doc.nodes.find((entry) => entry.id === nodeId);
            if (node) openClass(node.classId);
          }}
          onNavigateRequest={(request) => {
            if (request.nodeId) {
              const node = doc.nodes.find((entry) => entry.id === request.nodeId);
              if (node) openClass(node.classId);
            }
          }}
          contextMenuItemsForNode={nodeMenu}
          contextMenuItemsForAttachment={attachmentMenu}
          hiddenToolbarActions={["breakLinks", "format"]}
          onSelectionChange={(nodeIds) => {
            const nextId = nodeIds[0] ?? null;
            setSelectedId(nextId);
            setAttachmentId((current) => {
              if (!current || !nextId) return null;
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
            const parentId =
              selected && selected.kind !== "task" ? selected.id : doc.rootId;
            const adopted = adoptOrphans(restored, doc, parentId);
            commit(pruneUnreachable(reorderSiblingsByPosition(adopted, positions)));
          }}
        />
      </div>
      <PanelFrame className="w-72 shrink-0 border-l border-border" title="Details">
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
    </div>
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
