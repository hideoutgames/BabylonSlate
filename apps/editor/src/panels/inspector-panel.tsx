import { useMemo, useState } from "react";
import {
  AssetPicker,
  FUNCTION_PIN_PICKER_TYPES,
  PanelFrame,
  ParameterListEditor,
  PinListEditor,
  PinTypePicker,
  PropertyGrid,
  TypeVisualIcon,
  resolveTypeVisual,
  type PinListRow,
  type PropertyRow,
} from "@babylonslate/editor-kit";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { Button } from "@babylonslate/ui/components/button";
import type { IDockviewPanelProps } from "dockview-react";
import {
  DEFAULT_SORTING_LAYERS,
  eulerDegreesToQuaternion,
  identitySerializedTransform,
  quaternionToEulerDegrees,
  type GraphClassMember,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedTransform,
  type ViewportMode,
} from "@babylonslate/core";
import { normalizeInputMappings } from "@babylonslate/input";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useValidation } from "../context/validation-context";
import { usePlay } from "../context/play-context";
import {
  resolveInspectorNodeId,
  useGraphEditing,
} from "../context/graph-editing-context";
import { usePrefabEditing } from "../context/prefab-editing-context";
import { useOptionalSceneEditing } from "../context/scene-editing-context";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";
import {
  componentPropertyRows,
  type AssetPickRequest,
} from "../lib/component-property-rows";
import { JsBodyEditor } from "../components/js-body-editor";
import { isValidJsIdentifier } from "@babylonslate/scripting-nodes";
import {
  collectEnumMemberNames,
  commandParameterRows,
  commandParametersFromRows,
  developmentOnlyPropertyRows,
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
      <div
        className="flex flex-col gap-3 p-3"
        data-testid="inspector-member-variable"
      >
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
    const pins = member.pins ?? [];
    const inputRows: PinListRow[] = pins
      .filter((pin) => pin.direction === "in")
      .map((pin, index) => ({
        id: `${member.id}-in-${index}`,
        name: pin.name,
        type: pin.typeId,
      }));
    const outputRows: PinListRow[] = pins
      .filter((pin) => pin.direction === "out")
      .map((pin, index) => ({
        id: `${member.id}-out-${index}`,
        name: pin.name,
        type: pin.typeId,
      }));
    const commitPins = (
      nextInputs: PinListRow[],
      nextOutputs: PinListRow[],
    ) => {
      commit({
        pins: [
          ...nextInputs.map((row) => ({
            name: row.name,
            typeId: String(row.type),
            direction: "in" as const,
          })),
          ...nextOutputs.map((row) => ({
            name: row.name,
            typeId: String(row.type),
            direction: "out" as const,
          })),
        ],
      });
    };
    return (
      <div
        className="flex flex-col gap-3 p-3"
        data-testid="inspector-member-function"
      >
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
          title="Inputs"
          rows={inputRows}
          types={FUNCTION_PIN_PICKER_TYPES}
          testIdPrefix="class-fn-in"
          data-testid="inspector-member-inputs"
          onChange={(nextRows) => commitPins(nextRows, outputRows)}
        />
        <PinListEditor
          title="Outputs"
          rows={outputRows}
          types={FUNCTION_PIN_PICKER_TYPES}
          testIdPrefix="class-fn-out"
          data-testid="inspector-member-outputs"
          onChange={(nextRows) => commitPins(inputRows, nextRows)}
        />
      </div>
    );
  }

  if (member.kind === "interface") {
    const picked =
      interfaceAssets.find((asset) => asset.guid === member.assetGuid)?.name ??
      member.name;
    return (
      <div
        className="flex flex-col gap-3 p-3"
        data-testid="inspector-member-interface"
      >
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

function prefabComponentTransformRows(
  component: SerializedComponent,
  viewportMode: ViewportMode,
  onUpdateTransform: (transform: SerializedTransform) => void,
): PropertyRow[] {
  const transform = component.transform ?? identitySerializedTransform();
  const twoD = viewportMode === "2d";
  return [
    {
      kind: "vector3",
      id: `${component.id}-position`,
      label: "Position",
      value: transform.position,
      defaultValue: [0, 0, 0],
      axes: twoD ? ["X", "Y"] : ["X", "Y", "Z"],
      onChange: (position) =>
        onUpdateTransform({
          ...transform,
          position: [position[0], position[1], position[2]],
        }),
    },
    {
      kind: "vector3",
      id: `${component.id}-rotation`,
      label: "Rotation",
      value: twoD
        ? [quaternionToEulerDegrees(transform.rotation)[2], 0, 0]
        : quaternionToEulerDegrees(transform.rotation),
      defaultValue: [0, 0, 0],
      axes: twoD ? ["Z"] : ["X", "Y", "Z"],
      onChange: (next) =>
        onUpdateTransform({
          ...transform,
          rotation: eulerDegreesToQuaternion(
            twoD ? [0, 0, next[0]] : [next[0], next[1], next[2]],
          ),
        }),
    },
    {
      kind: "vector3",
      id: `${component.id}-scale`,
      label: "Scale",
      value: transform.scale,
      defaultValue: [1, 1, 1],
      axes: twoD ? ["X", "Y"] : ["X", "Y", "Z"],
      onChange: (scale) =>
        onUpdateTransform({
          ...transform,
          scale: [scale[0], scale[1], scale[2]],
        }),
    },
  ];
}

function PrefabComponentDetails({
  component,
  sortingLayers,
  physicsWorld,
  viewportMode,
  pickerAssets,
  assetLabel,
  onUpdate,
  onUpdateTransform,
}: {
  component: SerializedComponent;
  sortingLayers: readonly string[];
  physicsWorld: "3d" | "2d";
  viewportMode: ViewportMode;
  pickerAssets: Array<{
    guid: string;
    name: string;
    type: string;
    path?: string;
  }>;
  assetLabel: (guid: string | null | undefined) => string | undefined;
  onUpdate: (property: string, value: unknown) => void;
  onUpdateTransform: (transform: SerializedTransform) => void;
}) {
  const [assetPick, setAssetPick] = useState<AssetPickRequest | null>(null);
  return (
    <div
      className="flex flex-col gap-3 p-3"
      data-testid="inspector-prefab-component"
    >
      <PropertyGrid
        title="Transform"
        rows={prefabComponentTransformRows(
          component,
          viewportMode,
          onUpdateTransform,
        )}
        data-testid="prefab-component-transform-grid"
      />
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border bg-secondary px-2 py-1">
          <span className="flex min-w-0 items-center gap-2 truncate text-sm font-medium">
            <TypeVisualIcon
              visual={resolveTypeVisual({ classId: component.classId })}
              data-testid={`inspector-prefab-type-icon-${component.id}`}
            />
            {component.classId}
          </span>
        </div>
        <PropertyGrid
          rows={componentPropertyRows(PREFAB_ROOT_ID, component, onUpdate, {
            sortingLayers,
            assetLabel,
            physicsWorld,
            onPickAsset: setAssetPick,
          })}
        />
      </div>
      <AssetPicker
        open={assetPick !== null}
        onOpenChange={(open) => {
          if (!open) setAssetPick(null);
        }}
        assets={pickerAssets}
        allowedTypes={assetPick?.allowedTypes}
        title={assetPick?.title ?? "Pick Asset"}
        allowNone
        onPick={(guid) => {
          if (!assetPick) return;
          onUpdate(assetPick.property, guid);
          setAssetPick(null);
        }}
        data-testid="inspector-prefab-asset-picker"
      />
    </div>
  );
}

export function InspectorPanel(_props: IDockviewPanelProps) {
  void _props;
  const { documentId } = useDocumentWorkspace();
  const { openDocuments, applyGraphChange, projectDocument, assetRegistry } =
    useDocuments();
  const { focusDiagnostic } = useValidation();
  const { focusedNodeId } = usePlay();
  const { selectedNodeIds, selectedMemberId, activeFunctionId } =
    useGraphEditing();
  const {
    selectedId: prefabSelectedId,
    components: prefabComponents,
    updateComponent,
    updateComponentTransform,
  } = usePrefabEditing();
  const viewportMode = useOptionalSceneEditing()?.viewportMode ?? "3d";

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const graph =
    doc?.ref.kind === "graph" ? (doc.content as SerializedGraph) : null;
  const inspectGraph = useMemo(() => {
    if (!graph) return null;
    if (!activeFunctionId) return graph;
    const slice = graph.functionGraphs?.[activeFunctionId];
    if (!slice) return graph;
    return { ...graph, nodes: slice.nodes, edges: slice.edges };
  }, [activeFunctionId, graph]);

  const selectedMember =
    graph && selectedMemberId
      ? (graph.members ?? []).find((member) => member.id === selectedMemberId)
      : undefined;

  const selectedNode = useMemo(() => {
    if (!inspectGraph || selectedMember) return null;
    const id = resolveInspectorNodeId(
      selectedNodeIds,
      focusDiagnostic?.nodeId,
      focusedNodeId,
    );
    if (!id) return null;
    return inspectGraph.nodes.find((n) => n.id === id) ?? null;
  }, [
    focusDiagnostic?.nodeId,
    focusedNodeId,
    inspectGraph,
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

  const pickerAssets = (assetRegistry?.list() ?? []).map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  }));
  const sortingLayers =
    projectDocument?.settings.twoD?.sortingLayers ?? DEFAULT_SORTING_LAYERS;
  const assetLabel = (guid: string | null | undefined) => {
    if (!guid) return undefined;
    return (
      assetRegistry?.getByGuid?.(guid)?.header.name ??
      pickerAssets.find((asset) => asset.guid === guid)?.name
    );
  };

  const selectedPrefabComponent =
    prefabSelectedId && prefabSelectedId !== PREFAB_ROOT_ID
      ? prefabComponents.find((component) => component.id === prefabSelectedId)
      : undefined;

  if (selectedPrefabComponent) {
    return (
      <PanelFrame data-testid="inspector-panel">
        <PrefabComponentDetails
          component={selectedPrefabComponent}
          sortingLayers={sortingLayers}
          physicsWorld="3d"
          viewportMode={viewportMode}
          pickerAssets={pickerAssets}
          assetLabel={assetLabel}
          onUpdate={(property, value) =>
            updateComponent(selectedPrefabComponent.id, property, value)
          }
          onUpdateTransform={(transform) =>
            updateComponentTransform(selectedPrefabComponent.id, transform)
          }
        />
      </PanelFrame>
    );
  }

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

  if (prefabSelectedId === PREFAB_ROOT_ID) {
    return (
      <PanelFrame data-testid="inspector-panel">
        <p
          className="p-4 text-sm text-muted-foreground"
          data-testid="inspector-prefab-origin"
        >
          Prefab Origin is the actor transform in the Scene. Drag the viewport
          gizmo on Prefab Root to move that origin relative to the components.
        </p>
      </PanelFrame>
    );
  }

  if (!graph || !selectedNode) {
    return (
      <PanelFrame data-testid="inspector-panel">
        <p className="p-4 text-sm text-muted-foreground">
          Select a graph node, class member, or prefab component to edit
          properties.
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
        n.id === selectedNode.id ? { ...n, data: { ...n.data, ...patch } } : n,
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
  const developmentOnlyRows = developmentOnlyPropertyRows(
    selectedNode.type,
    selectedNode.data,
    updateNodeData,
  );

  return (
    <PanelFrame data-testid="inspector-panel">
      <div className="flex flex-col gap-3 p-3">
        <div className="text-sm font-medium">{title}</div>
        {logRows.length > 0 ? (
          <PropertyGrid rows={logRows} data-testid="inspector-log-properties" />
        ) : null}
        <PropertyGrid
          rows={developmentOnlyRows}
          data-testid="inspector-development-only"
        />
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
                <FieldLabel htmlFor="command-description">
                  Description
                </FieldLabel>
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
