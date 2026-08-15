import { useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  ContextMenuOverlay,
  NamePromptDialog,
  PanelFrame,
  TreeView,
  TypeColorMark,
  formatEventTitle,
  pinPickerColorVar,
  useContextMenu,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import type { GraphClassMemberKind, SerializedGraph } from "@babylonslate/core";
import {
  addClassMember,
  ensureEventNodeOnGraph,
  memberNamePromptCopy,
  nativeEventStubs,
  nativeStubId,
  patchClassMember,
  removeClassMember,
} from "../lib/class-members";
import { PlusIcon } from "lucide-react";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useValidation } from "../context/validation-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { defaultNodeRegistry } from "../services/graph-validation";
import { classIdForGraphPath } from "../services/script-compiler";
import { IconActionButton } from "../components/icon-action-button";
import { classParentLookup } from "../lib/content-browser-helpers";

export type MyClassMember = {
  kind: "variable" | "function" | "event" | "interface";
  name: string;
  detail?: string;
  inherited?: boolean;
  hasError?: boolean;
  typeId?: string;
  eventType?: string;
};

export type MyClassPanelProps = IDockviewPanelProps;

export const BLUEPRINT_SECTIONS = [
  { id: "functions", label: "Functions", kind: "function" },
  { id: "variables", label: "Variables", kind: "variable" },
  { id: "events", label: "Events", kind: "event" },
  { id: "interfaces", label: "Interfaces", kind: "interface" },
] as const;

export type MembersForGraphOptions = {
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
  parentGraphs?: Record<string, SerializedGraph>;
};

function eventDisplayName(node: SerializedGraph["nodes"][number]): string {
  const title = node.data.title;
  if (typeof title === "string" && title.trim()) {
    return formatEventTitle(title);
  }
  const named = node.data.name;
  if (typeof named === "string" && named.trim()) {
    return formatEventTitle(named);
  }
  const catalog = defaultNodeRegistry.get(node.type)?.title;
  if (catalog) return formatEventTitle(catalog);
  const typeName = node.type.startsWith("flow.event.")
    ? node.type.slice("flow.event.".length)
    : node.type;
  return formatEventTitle(typeName);
}

function memberIcon(member: MyClassMember) {
  if (member.kind === "variable") {
    return (
      <TypeColorMark
        colorVar={pinPickerColorVar(member.typeId ?? "float")}
        data-testid={`class-var-type-${member.detail ?? member.name}`}
      />
    );
  }
  if (member.kind === "function") {
    return <TypeColorMark colorVar="var(--node-function)" />;
  }
  if (member.kind === "event") {
    return <TypeColorMark colorVar="var(--node-event)" />;
  }
  return <TypeColorMark colorVar="var(--asset-script-type)" />;
}

function inheritedCustomEvents(
  options: MembersForGraphOptions | undefined,
): MyClassMember[] {
  if (!options?.parentGraphs) return [];
  const parentOf = options.parentOf;
  const chain: string[] = [];
  let current = options.parentClass ?? null;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parentOf?.(current) ?? null;
  }
  const rows: MyClassMember[] = [];
  const seenNames = new Set<string>();
  for (const className of chain) {
    const parentGraph = options.parentGraphs[className];
    if (!parentGraph) continue;
    for (const node of parentGraph.nodes) {
      if (node.type !== "flow.event.custom") continue;
      const name = eventDisplayName(node);
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      rows.push({
        kind: "event",
        name,
        detail: nativeStubId(`custom:${name}`),
        eventType: "flow.event.custom",
        inherited: true,
      });
    }
    for (const member of parentGraph.members ?? []) {
      if (member.kind !== "event") continue;
      const name = formatEventTitle(member.name);
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      rows.push({
        kind: "event",
        name,
        detail: nativeStubId(`custom:${name}`),
        eventType: "flow.event.custom",
        inherited: true,
      });
    }
  }
  return rows;
}

/**
 * Members the current graph declares. Native events always appear; custom
 * events come from canvas nodes; other kinds from `members`.
 */
export function membersForGraph(
  graph: SerializedGraph | null,
  options?: MembersForGraphOptions,
): MyClassMember[] {
  if (!graph) return [];
  const declared = (graph.members ?? [])
    .filter((member) => member.kind !== "event")
    .map((member) => ({
      kind: member.kind,
      name: member.name,
      detail: member.id,
      ...(member.typeId ? { typeId: member.typeId } : {}),
    }));
  const stubs = nativeEventStubs({
    parentClass: options?.parentClass,
    parentOf: options?.parentOf,
  });
  const events: MyClassMember[] = stubs.map((stub) => {
    const node = graph.nodes.find((entry) => entry.type === stub.eventType);
    return {
      kind: "event" as const,
      name: stub.name,
      detail: node?.id ?? nativeStubId(stub.eventType),
      eventType: stub.eventType,
    };
  });
  const listedTypes = new Set(stubs.map((stub) => stub.eventType));
  for (const node of graph.nodes) {
    if (!node.type.startsWith("flow.event.")) continue;
    if (node.type === "flow.event.call") continue;
    if (listedTypes.has(node.type) && node.type !== "flow.event.custom") {
      continue;
    }
    events.push({
      kind: "event",
      name: eventDisplayName(node),
      detail: node.id,
      eventType: node.type,
    });
  }
  const inherited = inheritedCustomEvents(options).filter((row) => {
    return !events.some(
      (event) =>
        event.eventType === "flow.event.custom" && event.name === row.name,
    );
  });
  return [...declared, ...events, ...inherited];
}

export function membersForSection(
  members: MyClassMember[],
  kind: MyClassMember["kind"] | null,
): MyClassMember[] {
  if (!kind) return [];
  return members.filter((member) => member.kind === kind);
}

export function blueprintTreeNodes(
  members: MyClassMember[],
  collapsed: ReadonlySet<string>,
): TreeViewNode[] {
  const rows: TreeViewNode[] = [];
  for (const section of BLUEPRINT_SECTIONS) {
    const kids = membersForSection(members, section.kind);
    const expanded = !collapsed.has(section.id);
    rows.push({
      id: `section-${section.id}`,
      label: section.label,
      depth: 0,
      hasChildren: true,
      expanded,
    });
    if (!expanded) continue;
    for (const member of kids) {
      rows.push({
        id: member.detail ?? `${section.id}-${member.name}`,
        label: member.inherited ? `(inherited) ${member.name}` : member.name,
        depth: 1,
        hasChildren: false,
        expanded: false,
        muted: member.hasError,
        icon: memberIcon(member),
      });
    }
  }
  return rows;
}

export function ClassMembersView({
  graph,
  onGraphChange,
  selectedId,
  onSelectMember,
  interfaceAssets,
  membersOptions,
}: {
  graph: SerializedGraph | null;
  onGraphChange: (next: SerializedGraph) => void;
  selectedId?: string | null;
  onSelectMember?: (id: string, member: MyClassMember | undefined) => void;
  interfaceAssets?: Array<{ guid: string; name: string; type: string }>;
  membersOptions?: MembersForGraphOptions;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [memberPromptKind, setMemberPromptKind] =
    useState<GraphClassMemberKind | null>(null);
  const [renameMemberId, setRenameMemberId] = useState<string | null>(null);
  const [interfacePickerOpen, setInterfacePickerOpen] = useState(false);
  const members = useMemo(
    () => membersForGraph(graph, membersOptions),
    [graph, membersOptions],
  );
  const addKind = (kind: GraphClassMemberKind) => {
    if (kind === "interface") {
      setInterfacePickerOpen(true);
      return;
    }
    setMemberPromptKind(kind);
  };
  const nodes = useMemo(
    () =>
      blueprintTreeNodes(members, collapsed).map((row) => {
        if (!row.id.startsWith("section-")) return row;
        const sectionId = row.id.replace(/^section-/, "");
        const section = BLUEPRINT_SECTIONS.find((entry) => entry.id === sectionId);
        if (!section) return row;
        return {
          ...row,
          trailing: (
            <IconActionButton
              label={`Add ${section.label.slice(0, -1)}`}
              data-testid={`class-add-${section.id}`}
              onClick={(event) => {
                event.stopPropagation();
                addKind(section.kind);
              }}
            >
              <PlusIcon />
            </IconActionButton>
          ),
        };
      }),
    [collapsed, members],
  );

  const { menu, closeMenu, openMenuAt } = useContextMenu({
    items: [
      {
        id: "rename",
        label: "Rename",
        onSelect: () => {
          if (!selectedId || selectedId.startsWith("section-")) return;
          const member = members.find(
            (entry) => (entry.detail ?? `${entry.kind}-${entry.name}`) === selectedId,
          );
          if (!member || member.kind === "event") return;
          setRenameMemberId(selectedId);
        },
      },
      {
        id: "delete",
        label: "Delete",
        onSelect: () => {
          if (!graph || !selectedId) return;
          onGraphChange(removeClassMember(graph, selectedId));
        },
      },
    ],
  });

  return (
    <>
      <TreeView
        nodes={nodes}
        selectedId={selectedId}
        onSelect={(id) => {
          if (id.startsWith("section-")) return;
          const member = members.find(
            (entry) => (entry.detail ?? `${entry.kind}-${entry.name}`) === id,
          );
          onSelectMember?.(id, member);
        }}
        onToggleExpanded={(id) => {
          const sectionId = id.replace(/^section-/, "");
          setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(sectionId)) next.delete(sectionId);
            else next.add(sectionId);
            return next;
          });
        }}
        onContextMenu={(id, x, y) => {
          if (id.startsWith("section-")) return;
          const member = members.find(
            (entry) => (entry.detail ?? `${entry.kind}-${entry.name}`) === id,
          );
          onSelectMember?.(id, member);
          openMenuAt(x, y);
        }}
        emptyLabel="No class members"
        data-testid="my-blueprint-tree"
      />
      <ContextMenuOverlay menu={menu} onClose={closeMenu} />
      <NamePromptDialog
        open={memberPromptKind !== null}
        onOpenChange={(open) => {
          if (!open) setMemberPromptKind(null);
        }}
        title={
          memberPromptKind
            ? memberNamePromptCopy(memberPromptKind).title
            : "Add Member"
        }
        label={
          memberPromptKind
            ? memberNamePromptCopy(memberPromptKind).label
            : "Name"
        }
        onSubmit={(name) => {
          if (!graph || !memberPromptKind) return;
          const next = addClassMember(graph, memberPromptKind, name);
          onGraphChange(next);
          if (memberPromptKind === "event") {
            const node = next.nodes[next.nodes.length - 1];
            if (node) {
              onSelectMember?.(node.id, {
                kind: "event",
                name: node.data.name as string,
                detail: node.id,
                eventType: "flow.event.custom",
              });
            }
            return;
          }
          const added = next.members?.[next.members.length - 1];
          if (added) {
            onSelectMember?.(added.id, {
              kind: added.kind,
              name: added.name,
              detail: added.id,
              typeId: added.typeId,
            });
          }
        }}
      />
      <NamePromptDialog
        open={renameMemberId !== null}
        onOpenChange={(open) => {
          if (!open) setRenameMemberId(null);
        }}
        title="Rename"
        label="Name"
        confirmLabel="Rename"
        onSubmit={(name) => {
          if (!graph || !renameMemberId) return;
          onGraphChange(patchClassMember(graph, renameMemberId, { name }));
        }}
      />
      <AssetPicker
        open={interfacePickerOpen}
        onOpenChange={setInterfacePickerOpen}
        assets={interfaceAssets ?? []}
        allowedTypes={["ScriptInterface"]}
        allowNone={false}
        title="Pick Script Interface"
        onPick={(guid) => {
          if (!graph || !guid) return;
          const named =
            (interfaceAssets ?? []).find((asset) => asset.guid === guid)?.name ??
            "Interface";
          const next = addClassMember(graph, "interface", named, undefined, {
            assetGuid: guid,
          });
          onGraphChange(next);
          const added = next.members?.[next.members.length - 1];
          if (added) {
            onSelectMember?.(added.id, {
              kind: added.kind,
              name: added.name,
              detail: added.id,
            });
          }
        }}
        data-testid="class-interface-picker"
      />
    </>
  );
}

/** Class panel — My Blueprint member tree stacked under Components. */
export function MyClassPanel(_props: MyClassPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyGraphChange, assetRegistry } = useDocuments();
  const { setFocusDiagnostic } = useValidation();
  const {
    selectedMemberId,
    selectedNodeIds,
    setSelectedMemberId,
    setSelectedNodeIds,
    setActiveFunctionId,
  } = useGraphEditing();
  const selectedId = selectedMemberId ?? selectedNodeIds[0] ?? null;

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const graph =
    doc?.ref.kind === "graph" ? (doc.content as SerializedGraph) : null;
  const className = doc?.ref.path ? classIdForGraphPath(doc.ref.path) : null;
  const interfaceAssets = (assetRegistry?.list() ?? [])
    .filter((asset) => asset.header.type === "ScriptInterface")
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
    }));
  const indexed = (assetRegistry?.list() ?? []).find(
    (asset) => asset.path === doc?.ref.path,
  );
  const parentOf = classParentLookup(assetRegistry?.list() ?? []);
  const parentGraphs: Record<string, SerializedGraph> = {};
  for (const entry of openDocuments) {
    if (entry.ref.kind !== "graph") continue;
    parentGraphs[classIdForGraphPath(entry.ref.path)] =
      entry.content as SerializedGraph;
  }
  const membersOptions = {
    parentClass: indexed?.header.parentClass ?? null,
    parentOf,
    parentGraphs,
  };

  const focusEvent = (nodeId: string, name: string) => {
    setActiveFunctionId(null);
    setSelectedNodeIds([nodeId]);
    setFocusDiagnostic({
      severity: "info",
      code: "my-blueprint",
      message: name,
      assetGuid: doc?.ref.path ?? documentId,
      graphId: documentId,
      nodeId,
    });
  };

  return (
    <PanelFrame data-testid="my-class-panel">
      {className ? (
        <p className="border-b border-border px-2 py-1 text-xs text-muted-foreground">
          {className}
        </p>
      ) : null}
      <ClassMembersView
        graph={graph}
        selectedId={selectedId}
        interfaceAssets={interfaceAssets}
        membersOptions={membersOptions}
        onGraphChange={(next) => {
          void applyGraphChange(documentId, next);
        }}
        onSelectMember={(id, member) => {
          if (!id) {
            setSelectedMemberId(null);
            setActiveFunctionId(null);
            return;
          }
          if (member?.kind === "function") {
            setSelectedMemberId(id);
            setActiveFunctionId(id);
            return;
          }
          setActiveFunctionId(null);
          if (member?.kind === "event") {
            const eventType = member.eventType ?? "flow.event.custom";
            const existing =
              graph?.nodes.find((node) => node.id === member.detail) ??
              graph?.nodes.find((node) => {
                if (node.type !== eventType) return false;
                if (eventType !== "flow.event.custom") return true;
                return eventDisplayName(node) === member.name;
              });
            if (existing) {
              focusEvent(existing.id, member.name);
              return;
            }
            if (!graph) return;
            const next = ensureEventNodeOnGraph(graph, eventType, {
              name:
                eventType === "flow.event.custom"
                  ? member.name.replace(/^Event\s+/, "")
                  : undefined,
              title: member.name,
            });
            void applyGraphChange(documentId, next);
            const spawned = next.nodes.find((node) => {
              if (node.type !== eventType) return false;
              if (eventType !== "flow.event.custom") return true;
              return eventDisplayName(node) === member.name;
            });
            if (spawned) focusEvent(spawned.id, member.name);
            return;
          }
          setSelectedMemberId(id);
        }}
      />
    </PanelFrame>
  );
}
