import { useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  AssetPicker,
  ContextMenuOverlay,
  NamePromptDialog,
  NestedMenu,
  PanelFrame,
  TreeView,
  TypeColorMark,
  formatEventTitle,
  pinPickerColorVar,
  useContextMenu,
  type NestedMenuItem,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import type { GraphClassMemberKind, SerializedGraph } from "@babylonslate/core";
import {
  addClassMember,
  memberNamePromptCopy,
  patchClassMember,
  removeClassMember,
} from "../lib/class-members";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useValidation } from "../context/validation-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { defaultNodeRegistry } from "../services/graph-validation";
import { classIdForGraphPath } from "../services/script-compiler";
import { IconActionButton } from "../components/icon-action-button";

export type MyClassMember = {
  kind: "variable" | "function" | "event" | "interface";
  name: string;
  detail?: string;
  inherited?: boolean;
  hasError?: boolean;
  typeId?: string;
};

export type MyClassPanelProps = IDockviewPanelProps;

export const BLUEPRINT_SECTIONS = [
  { id: "functions", label: "Functions", kind: "function" },
  { id: "variables", label: "Variables", kind: "variable" },
  { id: "events", label: "Events", kind: "event" },
  { id: "interfaces", label: "Interfaces", kind: "interface" },
] as const;

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

/**
 * Members the current graph declares. Events come from event nodes; other
 * kinds come from the optional `members` list on the serialized graph.
 */
export function membersForGraph(graph: SerializedGraph | null): MyClassMember[] {
  if (!graph) return [];
  const declared = (graph.members ?? [])
    .filter((member) => member.kind !== "event")
    .map((member) => ({
      kind: member.kind,
      name: member.name,
      detail: member.id,
      ...(member.typeId ? { typeId: member.typeId } : {}),
    }));
  const events = graph.nodes
    .filter((node) => node.type.startsWith("flow.event."))
    .map((node) => ({
      kind: "event" as const,
      name: eventDisplayName(node),
      detail: node.id,
    }));
  return [...declared, ...events];
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
}: {
  graph: SerializedGraph | null;
  onGraphChange: (next: SerializedGraph) => void;
  selectedId?: string | null;
  onSelectMember?: (id: string, member: MyClassMember | undefined) => void;
  interfaceAssets?: Array<{ guid: string; name: string; type: string }>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [memberPromptKind, setMemberPromptKind] =
    useState<GraphClassMemberKind | null>(null);
  const [renameMemberId, setRenameMemberId] = useState<string | null>(null);
  const [interfacePickerOpen, setInterfacePickerOpen] = useState(false);
  const members = useMemo(() => membersForGraph(graph), [graph]);
  const nodes = useMemo(
    () => blueprintTreeNodes(members, collapsed),
    [collapsed, members],
  );

  const addKind = (kind: GraphClassMemberKind) => {
    if (kind === "interface") {
      setInterfacePickerOpen(true);
      return;
    }
    setMemberPromptKind(kind);
  };

  const addItems: NestedMenuItem[] = BLUEPRINT_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label.slice(0, -1),
    testId: `class-add-${section.id}`,
    onSelect: () => addKind(section.kind),
  }));

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
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-1 py-1">
        <NestedMenu
          items={addItems}
          trigger={
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label="Add member"
              data-testid="class-add-member"
            >
              <PlusIcon />
            </Button>
          }
        />
        <IconActionButton
          label="Remove member"
          disabled={!selectedId || selectedId.startsWith("section-")}
          onClick={() => {
            if (!graph || !selectedId) return;
            onGraphChange(removeClassMember(graph, selectedId));
            onSelectMember?.("", undefined);
          }}
          data-testid="class-remove-member"
        >
          <Trash2Icon />
        </IconActionButton>
      </div>
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
        onGraphChange={(next) => {
          void applyGraphChange(documentId, next);
        }}
        onSelectMember={(id, member) => {
          if (!id) {
            setSelectedMemberId(null);
            return;
          }
          if (member?.kind === "event" && member.detail) {
            setSelectedNodeIds([member.detail]);
            setFocusDiagnostic({
              severity: "info",
              code: "my-blueprint",
              message: member.name,
              assetGuid: doc?.ref.path ?? documentId,
              graphId: documentId,
              nodeId: member.detail,
            });
            return;
          }
          setSelectedMemberId(id);
        }}
      />
    </PanelFrame>
  );
}
