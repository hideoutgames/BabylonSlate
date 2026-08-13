import { useMemo, useState } from "react";
import {
  AssetPicker,
  PanelFrame,
  ParameterListEditor,
  PinListEditor,
  PinTypePicker,
  PropertyGrid,
  type PinListRow,
} from "@babylonslate/editor-kit";
import { Field, FieldGroup, FieldLabel } from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { Button } from "@babylonslate/ui/components/button";
import type { IDockviewPanelProps } from "dockview-react";
import type { GraphClassMember, SerializedGraph } from "@babylonslate/core";
import { normalizeInputMappings } from "@babylonslate/input";
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
  collectEnumMemberNames,
  commandParameterRows,
  commandParametersFromRows,
  inspectorLiteralPinDefaults,
  logNodePropertyRows,
  parameterRowsFromPinList,
  pinDefaultPropertyRows,
  pinListFromParameterRows,
} from "../lib/graph-inspector";
import { patchClassMember } from "../lib/class-members";

function ClassMemberDetails({
  graph,
  member,
  interfaceAssets,
  onChange,
}: {
  graph: SerializedGraph;
  member: GraphClassMember;
  interfaceAssets: Array<{ guid: string; name: string; type: string }>;
  onChange: (next: SerializedGraph) => void;
}) {
  const [interfacePickerOpen, setInterfacePickerOpen] = useState(false);
  const commit = (patch: Partial<GraphClassMember>) => {
    onChange(patchClassMember(graph, member.id, patch));
  };

  if (member.kind === "variable") {
    const defaultText =
      member.defaultValue === undefined || member.defaultValue === null
        ? ""
        : String(member.defaultValue);
    return (
      <div className="flex flex-col gap-3 p-3" data-testid="inspector-member-variable">
        <div className="text-sm font-medium">{member.name}</div>
        <PropertyGrid
          rows={[
            {
              id: "name",
              kind: "text",
              label: "Name",
              value: member.name,
              onChange: (name) => commit({ name }),
            },
            {
              id: "default",
              kind: "text",
              label: "Default",
              value: defaultText,
              onChange: (value) => commit({ defaultValue: value }),
            },
          ]}
        />
        <div className="flex flex-col gap-1">
          <div className="text-sm font-medium">Type</div>
          <PinTypePicker
            value={member.typeId ?? "float"}
            onChange={(typeId) => commit({ typeId })}
            data-testid="inspector-member-type"
          />
        </div>
      </div>
    );
  }

  if (member.kind === "function") {
    const rows: PinListRow[] = (member.pins ?? []).map((pin, index) => ({
      id: `${member.id}-pin-${index}`,
      name: pin.name,
      type: pin.typeId,
      direction: pin.direction,
    }));
    return (
      <div className="flex flex-col gap-3 p-3" data-testid="inspector-member-function">
        <div className="text-sm font-medium">{member.name}</div>
        <PropertyGrid
          rows={[
            {
              id: "name",
              kind: "text",
              label: "Name",
              value: member.name,
              onChange: (name) => commit({ name }),
            },
          ]}
        />
        <PinListEditor
          title="Pins"
          rows={rows}
          showDirection
          testIdPrefix="class-fn-pin"
          data-testid="inspector-member-pins"
          onChange={(nextRows) =>
            commit({
              pins: nextRows.map((row) => ({
                name: row.name,
                typeId: String(row.type),
                direction: row.direction === "out" ? "out" : "in",
              })),
            })
          }
        />
      </div>
    );
  }

  if (member.kind === "interface") {
    const picked =
      interfaceAssets.find((asset) => asset.guid === member.assetGuid)?.name ??
      member.name;
    return (
      <div className="flex flex-col gap-3 p-3" data-testid="inspector-member-interface">
        <div className="text-sm font-medium">{member.name}</div>
        <PropertyGrid
          rows={[
            {
              id: "name",
              kind: "text",
              label: "Name",
              value: member.name,
              onChange: (name) => commit({ name }),
            },
          ]}
        />
        <Button
          type="button"
          variant="outline"
          data-testid="inspector-member-interface-pick"
          onClick={() => setInterfacePickerOpen(true)}
        >
          {picked || "Pick Script Interface"}
        </Button>
        <AssetPicker
          open={interfacePickerOpen}
          onOpenChange={setInterfacePickerOpen}
          assets={interfaceAssets}
          allowedTypes={["ScriptInterface"]}
          allowNone={false}
          title="Pick Script Interface"
          onPick={(guid) => {
            if (!guid) return;
            const named =
              interfaceAssets.find((asset) => asset.guid === guid)?.name ??
              member.name;
            commit({ assetGuid: guid, name: named });
          }}
          data-testid="inspector-interface-picker"
        />
      </div>
    );
  }

  return null;
}

export function InspectorPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyGraphChange, projectDocument, assetRegistry } =
    useDocuments();
  const { focusDiagnostic } = useValidation();
  const { focusedNodeId } = usePlay();
  const { selectedNodeIds, selectedMemberId } = useGraphEditing();

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const graph =
    doc?.ref.kind === "graph" ? (doc.content as SerializedGraph) : null;

  const selectedMember =
    graph && selectedMemberId
      ? (graph.members ?? []).find((member) => member.id === selectedMemberId)
      : undefined;

  const selectedNode = useMemo(() => {
    if (!graph || selectedMember) return null;
    const id = resolveInspectorNodeId(
      selectedNodeIds,
      focusDiagnostic?.nodeId,
      focusedNodeId,
    );
    if (!id) return null;
    return graph.nodes.find((n) => n.id === id) ?? null;
  }, [
    focusDiagnostic?.nodeId,
    focusedNodeId,
    graph,
    selectedMember,
    selectedNodeIds,
  ]);

  const interfaceAssets = (assetRegistry?.list() ?? [])
    .filter((asset) => asset.header.type === "ScriptInterface")
    .map((asset) => ({
      guid: asset.header.guid,
      name: asset.header.name,
      type: asset.header.type,
    }));

  if (graph && selectedMember && selectedMember.kind !== "event") {
    return (
      <PanelFrame data-testid="inspector-panel">
        <ClassMemberDetails
          graph={graph}
          member={selectedMember}
          interfaceAssets={interfaceAssets}
          onChange={(next) => {
            void applyGraphChange(documentId, next);
          }}
        />
      </PanelFrame>
    );
  }

  if (!graph || !selectedNode) {
    return (
      <PanelFrame data-testid="inspector-panel">
        <p className="p-4 text-sm text-muted-foreground">
          Select a graph node or class member to edit properties.
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

  const inputMappings = normalizeInputMappings(projectDocument?.settings.input);
  const enumMembers = collectEnumMemberNames(
    openDocuments,
    assetRegistry?.list() ?? [],
  );
  const pinDefaultRows = pinDefaultPropertyRows(
    inspectorLiteralPinDefaults(selectedNode, graph.edges),
    updateNodeData,
    {
      actionNames: inputMappings.actions.map((action) => action.name),
      axisNames: inputMappings.axes.map((axis) => axis.name),
      enumMembers,
    },
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
