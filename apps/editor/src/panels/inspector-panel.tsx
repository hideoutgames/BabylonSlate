import { useMemo } from "react";
import { PanelFrame, ParameterListEditor } from "@babylonslate/editor-kit";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useValidation } from "../context/validation-context";
import { JsBodyEditor } from "../components/js-body-editor";
import { isValidJsIdentifier } from "@babylonslate/scripting-nodes";

export function InspectorPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyGraphChange } = useDocuments();
  const { focusDiagnostic } = useValidation();

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const graph =
    doc?.ref.kind === "graph" ? (doc.content as SerializedGraph) : null;

  const selectedNode = useMemo(() => {
    if (!graph) return null;
    const id =
      focusDiagnostic?.nodeId ??
      graph.nodes.find((n) => n.type === "debug.executeJavaScript")?.id;
    return graph.nodes.find((n) => n.id === id) ?? null;
  }, [graph, focusDiagnostic]);

  if (!graph || !selectedNode) {
    return (
      <PanelFrame title="Inspector" data-testid="inspector-panel">
        <p className="p-4 text-sm text-muted-foreground">
          Select a graph node to edit properties.
        </p>
      </PanelFrame>
    );
  }

  const isExecJs = selectedNode.type === "debug.executeJavaScript";
  const inputs = Array.isArray(selectedNode.data.inputs)
    ? (selectedNode.data.inputs as Array<{ name: string; type?: unknown }>)
    : [];

  const updateNodeData = (patch: Record<string, unknown>) => {
    const next: SerializedGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === selectedNode.id
          ? { ...n, data: { ...n.data, ...patch } }
          : n,
      ),
    };
    void applyGraphChange(documentId, next);
  };

  return (
    <PanelFrame title="Inspector" data-testid="inspector-panel">
      <div className="flex flex-col gap-3 p-3">
        <div className="text-sm font-medium">{selectedNode.type}</div>
        {isExecJs ? (
          <>
            <ParameterListEditor
              title="Inputs"
              rows={inputs.map((row, i) => ({
                id: `in-${i}-${row.name}`,
                name: row.name,
                typeLabel: "float",
              }))}
              onChange={(rows) => {
                const invalid = rows.find((r) => !isValidJsIdentifier(r.name));
                updateNodeData({
                  inputs: rows.map((r) => ({
                    name: r.name,
                    type: { kind: "float" },
                  })),
                  ...(invalid
                    ? { __identError: invalid.name }
                    : { __identError: undefined }),
                });
              }}
            />
            <JsBodyEditor
              value={String(selectedNode.data.body ?? "")}
              bodyLine={focusDiagnostic?.bodyLine}
              onChange={(body) => updateNodeData({ body })}
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Node properties for {selectedNode.id}.
          </p>
        )}
      </div>
    </PanelFrame>
  );
}
