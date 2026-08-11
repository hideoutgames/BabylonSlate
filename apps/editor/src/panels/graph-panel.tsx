import type { IDockviewPanelProps } from "dockview-react";
import { GraphEditor } from "@babylonslate/graph-ui";
import { createDefaultGraph, type SerializedGraph } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";

export function GraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyGraphChange } = useDocuments();

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const graph =
    doc?.ref.kind === "graph"
      ? (doc.content as SerializedGraph)
      : createDefaultGraph();

  return (
    <div className="h-full w-full">
      <GraphEditor
        key={documentId}
        initialGraph={graph}
        onChange={(next) => applyGraphChange(documentId, next)}
      />
    </div>
  );
}
