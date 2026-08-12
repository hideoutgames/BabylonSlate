import { useMemo, useState, type MouseEvent, type PointerEvent } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  PanelFrame,
  TreeView,
  formatEventTitle,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import type { GraphClassMemberKind, SerializedGraph } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useValidation } from "../context/validation-context";
import { addClassMember } from "../lib/class-members";
import { defaultNodeRegistry } from "../services/graph-validation";
import { classIdForGraphPath } from "../services/script-compiler";

export type MyClassMember = {
  kind: "variable" | "function" | "event" | "interface";
  name: string;
  detail?: string;
  inherited?: boolean;
  hasError?: boolean;
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
      });
    }
  }
  return rows;
}

function promptMemberName(kind: GraphClassMemberKind): string | null {
  const label =
    kind === "function"
      ? "Function name"
      : kind === "variable"
        ? "Variable name"
        : kind === "event"
          ? "Event name"
          : "Interface name";
  const raw = window.prompt(label);
  if (raw === null) return null;
  const name = raw.trim();
  return name.length > 0 ? name : null;
}

function stopRowGesture(event: MouseEvent | PointerEvent) {
  event.stopPropagation();
}

/** Class panel — compact member tree stacked under Components. */
export function MyClassPanel(_props: MyClassPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyGraphChange } = useDocuments();
  const { setFocusDiagnostic } = useValidation();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const graph =
    doc?.ref.kind === "graph" ? (doc.content as SerializedGraph) : null;
  const members = useMemo(() => membersForGraph(graph), [graph]);
  const className = doc?.ref.path ? classIdForGraphPath(doc.ref.path) : null;
  const nodes = useMemo(() => {
    const rows = blueprintTreeNodes(members, collapsed);
    return rows.map((row) => {
      if (!row.id.startsWith("section-")) return row;
      const sectionId = row.id.replace(/^section-/, "");
      const section = BLUEPRINT_SECTIONS.find((entry) => entry.id === sectionId);
      if (!section) return row;
      return {
        ...row,
        trailing: (
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Add ${section.label.slice(0, -1).toLowerCase()}`}
            data-testid={`class-add-${section.id}`}
            onPointerDown={stopRowGesture}
            onClick={(event) => {
              stopRowGesture(event);
              if (!graph) return;
              const name = promptMemberName(section.kind);
              if (!name) return;
              void applyGraphChange(
                documentId,
                addClassMember(graph, section.kind, name),
              );
            }}
          >
            +
          </button>
        ),
      };
    });
  }, [applyGraphChange, collapsed, documentId, graph, members]);

  return (
    <PanelFrame data-testid="my-class-panel">
      {className ? (
        <p className="border-b border-border px-2 py-1 text-xs text-muted-foreground">
          {className}
        </p>
      ) : null}
      <TreeView
        nodes={nodes}
        onSelect={(id) => {
          if (id.startsWith("section-")) return;
          const member = members.find(
            (entry) => (entry.detail ?? `${entry.kind}-${entry.name}`) === id,
          );
          if (member?.kind !== "event" || !member.detail) return;
          setFocusDiagnostic({
            severity: "info",
            code: "my-blueprint",
            message: member.name,
            assetGuid: doc?.ref.path ?? documentId,
            graphId: documentId,
            nodeId: member.detail,
          });
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
        emptyLabel="No class members"
        data-testid="my-blueprint-tree"
      />
    </PanelFrame>
  );
}
