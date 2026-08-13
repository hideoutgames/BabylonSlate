import { useMemo } from "react";
import {
  PanelFrame,
  ParameterListEditor,
  PropertyGrid,
} from "@babylonslate/editor-kit";
import { Field, FieldGroup, FieldLabel } from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import type { IDockviewPanelProps } from "dockview-react";
import type { SerializedGraph } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useValidation } from "../context/validation-context";
import { usePlay } from "../context/play-context";
import {
  resolveInspectorNodeId,
  useGraphEditing,
} from "../context/graph-editing-context";
import { JsBodyEditor } from "../components/js-body-editor";
import { isValidJsIdentifier } from "@babylonslate/scripting-nodes";
import {
  commandParameterRows,
  commandParametersFromRows,
  inspectorLiteralPinDefaults,
  logNodePropertyRows,
  parameterRowsFromPinList,
  pinDefaultPropertyRows,
  pinListFromParameterRows,
} from "../lib/graph-inspector";

export function InspectorPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyGraphChange } = useDocuments();
  const { focusDiagnostic } = useValidation();
  const { focusedNodeId } = usePlay();
  const { selectedNodeIds } = useGraphEditing();

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const graph =
    doc?.ref.kind === "graph" ? (doc.content as SerializedGraph) : null;

  const selectedNode = useMemo(() => {
    if (!graph) return null;
    const id = resolveInspectorNodeId(
      selectedNodeIds,
      focusDiagnostic?.nodeId,
      focusedNodeId,
    );
    if (!id) return null;
    return graph.nodes.find((n) => n.id === id) ?? null;
  }, [graph, selectedNodeIds, focusDiagnostic, focusedNodeId]);

  if (!graph || !selectedNode) {
    return (
      <PanelFrame data-testid="inspector-panel">
        <p className="p-4 text-sm text-muted-foreground">
          Select a graph node to edit properties.
        </p>
      </PanelFrame>
    );
  }

  const isExecJs = selectedNode.type === "debug.executeJavaScript";
  const isCommandRun = selectedNode.type === "flow.event.commandRun";
  const isLog = selectedNode.type === "debug.log";
  const inputs = Array.isArray(selectedNode.data.inputs)
    ? (selectedNode.data.inputs as Array<{ name: string; type?: unknown }>)
    : [];
  const outputs = Array.isArray(selectedNode.data.outputs)
    ? (selectedNode.data.outputs as Array<{ name: string; type?: unknown }>)
    : [];
  const commandParams = Array.isArray(selectedNode.data.parameters)
    ? (selectedNode.data.parameters as Array<{
        name: string;
        type?: unknown;
        optional?: boolean;
        defaultValue?: unknown;
        enumValues?: unknown;
      }>)
    : [];
  const title =
    typeof selectedNode.data.title === "string" && selectedNode.data.title
      ? selectedNode.data.title
      : selectedNode.type;

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

  const pinDefaultRows = pinDefaultPropertyRows(
    inspectorLiteralPinDefaults(selectedNode, graph.edges),
    updateNodeData,
  );
  const logRows = isLog
    ? logNodePropertyRows(selectedNode.data, updateNodeData)
    : [];

  return (
    <PanelFrame data-testid="inspector-panel">
      <div className="flex flex-col gap-3 p-3">
        <div className="text-sm font-medium">{title}</div>
        {logRows.length > 0 ? (
          <PropertyGrid rows={logRows} data-testid="inspector-log-properties" />
        ) : null}
        {pinDefaultRows.length > 0 ? (
          <PropertyGrid
            title="Defaults"
            rows={pinDefaultRows}
            data-testid="inspector-pin-defaults"
          />
        ) : null}
        {isExecJs ? (
          <>
            <ParameterListEditor
              title="Inputs"
              rows={parameterRowsFromPinList(inputs, "in")}
              onChange={(rows) => {
                const invalid = rows.find((r) => !isValidJsIdentifier(r.name));
                updateNodeData({
                  inputs: pinListFromParameterRows(rows),
                  ...(invalid
                    ? { __identError: invalid.name }
                    : { __identError: undefined }),
                });
              }}
            />
            <ParameterListEditor
              title="Outputs"
              rows={parameterRowsFromPinList(outputs, "out")}
              onChange={(rows) => {
                const invalid = rows.find((r) => !isValidJsIdentifier(r.name));
                updateNodeData({
                  outputs: pinListFromParameterRows(rows),
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
        ) : null}
        {isCommandRun ? (
          <>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="command-name">Command Name</FieldLabel>
                <Input
                  id="command-name"
                  className="min-h-11"
                  value={String(selectedNode.data.commandName ?? "")}
                  data-testid="command-name"
                  onChange={(event) =>
                    updateNodeData({ commandName: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="command-description">Description</FieldLabel>
                <Input
                  id="command-description"
                  className="min-h-11"
                  value={String(selectedNode.data.description ?? "")}
                  data-testid="command-description"
                  onChange={(event) =>
                    updateNodeData({ description: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="command-category">Category</FieldLabel>
                <Input
                  id="command-category"
                  className="min-h-11"
                  value={String(selectedNode.data.category ?? "game")}
                  data-testid="command-category"
                  onChange={(event) =>
                    updateNodeData({ category: event.target.value })
                  }
                />
              </Field>
            </FieldGroup>
            <ParameterListEditor
              title="Parameters"
              rows={commandParameterRows(commandParams)}
              onChange={(rows) =>
                updateNodeData({ parameters: commandParametersFromRows(rows) })
              }
            />
          </>
        ) : null}
      </div>
    </PanelFrame>
  );
}
