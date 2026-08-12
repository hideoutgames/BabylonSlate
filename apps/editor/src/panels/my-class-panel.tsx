import { useMemo } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Card } from "@babylonslate/ui/components/card";
import { Button } from "@babylonslate/ui/components/button";
import { PanelFrame } from "@babylonslate/editor-kit";
import type { SerializedGraph } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
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

/** My Class panel — variables, functions, events, interfaces. */
export function MyClassPanel(_props: MyClassPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments } = useDocuments();

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const graph =
    doc?.ref.kind === "graph" ? (doc.content as SerializedGraph) : null;
  const members = useMemo(() => membersForGraph(graph), [graph]);
  const className = doc?.ref.path ? classIdForGraphPath(doc.ref.path) : null;

  return (
    <PanelFrame
      title={className ?? "My Class"}
      data-testid="my-class-panel"
      toolbar={
        <Button type="button" size="sm" variant="outline" disabled>
          Add
        </Button>
      }
    >
      <ScrollArea className="min-h-0 flex-1 p-2">
        <div className="flex flex-col gap-1 pr-2">
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No events yet. Add an Event Begin Play or Event Tick node.
            </p>
          ) : (
            members.map((m) => (
              <Card
                key={`${m.kind}-${m.name}-${m.detail ?? ""}`}
                className="flex min-h-11 flex-row items-center justify-between gap-2 p-3"
                data-testid="my-class-member"
              >
                <div className="flex flex-col">
                  <span className="text-sm">
                    {m.inherited ? `(inherited) ${m.name}` : m.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {m.kind}
                    {m.detail ? ` · ${m.detail}` : ""}
                  </span>
                </div>
                {m.hasError ? (
                  <span className="text-xs text-destructive">error</span>
                ) : null}
              </Card>
            ))
          )}
        </div>
      </ScrollArea>
    </PanelFrame>
  );
}
