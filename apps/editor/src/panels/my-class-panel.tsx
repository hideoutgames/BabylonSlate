import { useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  PanelFrame,
  TreeView,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import type { SerializedGraph } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useValidation } from "../context/validation-context";
import { classIdForGraphPath } from "../services/script-compiler";
import { defaultNodeRegistry } from "../services/graph-validation";

export type MyClassMember = {
  kind: "variable" | "function" | "event" | "interface";
  name: string;
  detail?: string;
  inherited?: boolean;
  hasError?: boolean;
};

export type MyClassPanelProps = IDockviewPanelProps;

export const BLUEPRINT_SECTIONS = [
  { id: "graphs", label: "Graphs", kind: null },
  { id: "functions", label: "Functions", kind: "function" },
  { id: "variables", label: "Variables", kind: "variable" },
  { id: "events", label: "Events", kind: "event" },
  { id: "interfaces", label: "Interfaces", kind: "interface" },
] as const;

/**
 * Members the current graph actually declares. Variables, functions, and
 * implemented interfaces stay empty until class documents store that metadata.
 */
export function membersForGraph(graph: SerializedGraph | null): MyClassMember[] {
  if (!graph) return [];
  return graph.nodes
    .filter((node) => node.type.startsWith("flow.event."))
    .map((node) => ({
      kind: "event" as const,
      name: defaultNodeRegistry.get(node.type)?.title ?? node.type,
      detail: node.id,
    }));
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

/** My Blueprint panel — compact member tree stacked under Components. */
export function MyClassPanel(_props: MyClassPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();
  const { setFocusDiagnostic } = useValidation();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const graph =
    doc?.ref.kind === "graph" ? (doc.content as SerializedGraph) : null;
  const members = useMemo(() => membersForGraph(graph), [graph]);
  const className = doc?.ref.path ? classIdForGraphPath(doc.ref.path) : null;
  const nodes = useMemo(
    () => blueprintTreeNodes(members, collapsed),
    [collapsed, members],
  );

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
