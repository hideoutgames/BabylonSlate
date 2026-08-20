import { useMemo, useState } from "react";
import {
  AssetPicker,
  ClassPicker,
  FUNCTION_PIN_PICKER_TYPES,
  PIN_PICKER_TYPES,
  PanelFrame,
  ParameterListEditor,
  NamedListEditor,
  PinListEditor,
  PropertyGrid,
  SearchDropdown,
  TypeVisualIcon,
  VariableTypeFields,
  assetRowIdentity,
  classRowIdentity,
  formatEventMemberName,
  resolveTypeVisual,
  selectedPickerIdentity,
  ASSET_REF_PICKER_TYPES,
  type ClassPickerEntry,
  type PinListRow,
  type VariableTypeFieldsValue,
} from "@babylonslate/editor-kit";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { Button } from "@babylonslate/ui/components/button";
import type { IDockviewPanelProps } from "dockview-react";
import {
  DEFAULT_COLLISION_LAYERS,
  DEFAULT_SORTING_LAYERS,
  identitySerializedTransform,
  isEditorGraphHost,
  type GraphClassMember,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedTransform,
  type ViewportMode,
} from "@babylonslate/core";
import { normalizeInputMappings } from "@babylonslate/input";
import {
  animGraphMembersFromVariables,
  decorateTransitionRuleGraph,
  persistTransitionRuleGraph,
  findReverseTransition,
  parseAnimGraphDocument,
  patchTransition,
} from "@babylonslate/anim-graph";
import { useDocuments } from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useValidation } from "../context/validation-context";
import { usePlay } from "../context/play-context";
import {
  resolveInspectorNodeId,
  useGraphEditing,
} from "../context/graph-editing-context";
import { useOptionalAnimGraphEditing } from "../context/anim-graph-editing-context";
import { usePrefabEditing } from "../context/prefab-editing-context";
import { useOptionalSceneEditing } from "../context/scene-editing-context";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";
import { spatialTransformPropertyRows } from "../lib/transform-property-rows";
import { fontAssetHasFacetype } from "../lib/play-fonts";
import {
  componentPropertyRows,
  subclassClassEntries,
  type AssetPickRequest,
} from "../lib/component-property-rows";
import { JsBodyEditor } from "../components/js-body-editor";
import { isValidJsIdentifier } from "@babylonslate/scripting-nodes";
import { isReservedConsoleCommandName } from "@babylonslate/debugger";
import {
  collectEnumMemberNames,
  commandParameterRows,
  commandParametersFromRows,
  connectedEnumGuidFromSerialized,
  containerConstructorPropertyRows,
  developmentOnlyPropertyRows,
  enumNodePropertyRows,
  flowSwitchCaseListValues,
  inspectorLiteralPinDefaults,
  isFlowSwitchTypeId,
  logNodePropertyRows,
  parameterRowsFromPinList,
  patchFlowSwitchCases,
  pinDefaultPropertyRows,
  pinListFromParameterRows,
  pinsFromNodeData,
  variableDefaultPropertyRows,
} from "../lib/graph-inspector";
import { defaultValueForMember, keepsTypeClassId, pinDefaultPropertyKey } from "@babylonslate/scripting";
import { patchClassMember } from "../lib/class-members";
import { classParentLookup } from "../lib/content-browser-helpers";
import { physicsWorldFromOpenDocuments } from "./add-component-catalog";
import {
  commitLogicGraph,
  collectGraphTypeAssets,
  serializedGraphFromDocument,
  typeAssetPickerEntries,
  typeSchemasFromGraphAssets,
} from "../lib/logic-graph-document";

function memberPinRows(
  pins: GraphClassMember["pins"],
  memberId: string,
  direction: "in" | "out",
): PinListRow[] {
  return (pins ?? [])
    .filter((pin) => pin.direction === direction)
    .map((pin, index) => ({
      id: `${memberId}-${direction}-${index}`,
      name: pin.name,
      type: pin.typeId,
      ...(pin.typeClassId ? { typeClassId: pin.typeClassId } : {}),
    }));
}

function memberPinsFromRows(
  inputs: PinListRow[],
  outputs: PinListRow[],
): NonNullable<GraphClassMember["pins"]> {
  const toPin = (row: PinListRow, direction: "in" | "out") => {
    const pin: NonNullable<GraphClassMember["pins"]>[number] = {
      name: row.name,
      typeId: String(row.type),
      direction,
    };
    if (row.typeClassId?.trim()) pin.typeClassId = row.typeClassId.trim();
    return pin;
  };
  return [
    ...inputs.map((row) => toPin(row, "in")),
    ...outputs.map((row) => toPin(row, "out")),
  ];
}

function variableContainerOf(
  member: GraphClassMember,
): "single" | "array" | "map" {
  return member.container === "array" || member.container === "map"
    ? member.container
    : "single";
}

function defaultValueForVariableType(
  spec: {
    typeId: string;
    typeClassId?: string;
    container: "single" | "array" | "map";
  },
  schemas: ReturnType<typeof typeSchemasFromGraphAssets>,
): unknown {
  if (spec.container === "array") return [];
  if (spec.container === "map") return undefined;
  if (
    spec.typeId === "object" ||
    spec.typeId === "actor" ||
    spec.typeId === "wildcard" ||
    spec.typeId === "asset"
  ) {
    return undefined;
  }
  if (spec.typeId === "class") return spec.typeClassId ?? "BObject";
  return defaultValueForMember(spec.typeId, spec.typeClassId, schemas);
}

function constrainedTypeClassId(typeId: string, typeClassId?: string): string | undefined {
  const trimmed = typeClassId?.trim();
  if (trimmed) return trimmed;
  if (typeId === "actor") return "Actor";
  if (typeId === "object" || typeId === "class") return "BObject";
  return undefined;
}

function ClassMemberDetails({
  graph,
  member,
  interfaceAssets,
  classEntries,
  typeAssets,
  schemas,
  enumMembers,
  onChange,
}: {
  graph: SerializedGraph;
  member: GraphClassMember;
  interfaceAssets: Array<{ guid: string; name: string; type: string }>;
  classEntries: ClassPickerEntry[];
  typeAssets: Array<{ guid: string; name: string; type: string }>;
  schemas: ReturnType<typeof typeSchemasFromGraphAssets>;
  enumMembers: Record<string, string[]>;
  onChange: (next: SerializedGraph) => void;
}) {
  const [interfacePickerOpen, setInterfacePickerOpen] = useState(false);
  const [classPickerOpen, setClassPickerOpen] = useState(false);
  const [typeAssetPickerOpen, setTypeAssetPickerOpen] = useState(false);
  const commit = (patch: Partial<GraphClassMember>) => {
    onChange(patchClassMember(graph, member.id, patch));
  };

  if (member.kind === "variable") {
    const typeId = member.typeId ?? "float";
    const container = variableContainerOf(member);
    const isObject = typeId === "object";
    const isActor = typeId === "actor";
    const isClass = typeId === "class";
    const isStruct = typeId === "struct";
    const isEnum = typeId === "enum";
    const isAsset = typeId === "asset";
    const typeClassId =
      member.typeClassId?.trim() ||
      (isObject || isClass ? "BObject" : isActor ? "Actor" : "");
    const typeAsset = typeAssets.find((asset) => asset.guid === typeClassId);
    const typeAssetIdentity = assetRowIdentity(
      typeAsset
        ? { name: typeAsset.name, type: typeAsset.type }
        : typeClassId
          ? { name: typeClassId, type: isEnum ? "Enum" : "Structure" }
          : undefined,
    );
    const commitTypeFields = (next: VariableTypeFieldsValue) => {
      const nextContainer =
        next.container === "array" || next.container === "map"
          ? next.container
          : "single";
      const keepParam = keepsTypeClassId(next.typeId);
      const nextClassId = keepParam
        ? constrainedTypeClassId(next.typeId, next.typeClassId)
        : undefined;
      const typeChanged = next.typeId !== typeId;
      const containerChanged = nextContainer !== container;
      const patch: Partial<GraphClassMember> = {
        typeId: next.typeId,
        container: nextContainer === "single" ? undefined : nextContainer,
        keyTypeId:
          nextContainer === "map" ? (next.keyTypeId ?? "string") : undefined,
        keyTypeClassId:
          nextContainer === "map" ? next.keyTypeClassId : undefined,
        typeClassId: nextClassId,
      };
      if (typeChanged || containerChanged) {
        patch.defaultValue = defaultValueForVariableType(
          {
            typeId: next.typeId,
            typeClassId: nextClassId,
            container: nextContainer,
          },
          schemas,
        );
      }
      commit(patch);
    };
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
            ...variableDefaultPropertyRows(
              typeId,
              member.defaultValue,
              (value) => commit({ defaultValue: value }),
              {
                typeClassId: member.typeClassId,
                schemas,
                enumMembers,
                container,
              },
            ),
          ]}
        />
        <VariableTypeFields
          value={{
            typeId,
            typeClassId: member.typeClassId,
            container,
            keyTypeId: member.keyTypeId,
            keyTypeClassId: member.keyTypeClassId,
          }}
          onChange={commitTypeFields}
          classEntries={classEntries}
          typeAssets={typeAssets}
        />
        {isObject || isActor || isClass ? (
          <Field>
            <FieldLabel>Class Type</FieldLabel>
            <Button
              type="button"
              variant="outline"
              className="h-auto w-full justify-start"
              data-testid="inspector-member-class-type"
              onClick={() => setClassPickerOpen(true)}
            >
              {selectedPickerIdentity(
                classRowIdentity(
                  classEntries.find((entry) => entry.id === typeClassId),
                  typeClassId,
                ),
              )}
            </Button>
          </Field>
        ) : isStruct || isEnum ? (
          <Field>
            <FieldLabel>
              {isEnum ? "Enum Type" : "Structure Type"}
            </FieldLabel>
            <Button
              type="button"
              variant="outline"
              className="h-auto w-full justify-start"
              data-testid="inspector-member-type-asset"
              onClick={() => setTypeAssetPickerOpen(true)}
            >
              {selectedPickerIdentity(
                typeAssetIdentity,
                typeClassId || "Pick type",
              )}
            </Button>
          </Field>
        ) : isAsset ? (
          <Field>
            <FieldLabel>Asset Type</FieldLabel>
            <SearchDropdown
              title="Asset Type"
              items={ASSET_REF_PICKER_TYPES.map((assetType) => ({
                id: assetType,
                label: assetType,
                description: "Asset",
              }))}
              onSelect={(id) => commit({ typeClassId: id })}
              data-testid="inspector-member-asset-type-picker"
            >
              <Button
                type="button"
                variant="outline"
                className="h-auto w-full justify-start"
                data-testid="inspector-member-asset-type"
              >
                {selectedPickerIdentity(
                  typeClassId
                    ? { displayLabel: typeClassId, displayType: "Asset" }
                    : { displayLabel: undefined },
                  "Pick type",
                )}
              </Button>
            </SearchDropdown>
          </Field>
        ) : null}
        <ClassPicker
          open={classPickerOpen}
          onOpenChange={setClassPickerOpen}
          classes={classEntries}
          allowNone={false}
          title="Pick Class Type"
          onPick={(classId) => {
            if (!classId) return;
            const patch: Partial<GraphClassMember> = { typeClassId: classId };
            if (isClass) patch.defaultValue = classId;
            commit(patch);
            setClassPickerOpen(false);
          }}
          data-testid="inspector-member-class-picker"
        />
        <AssetPicker
          open={typeAssetPickerOpen}
          onOpenChange={setTypeAssetPickerOpen}
          assets={typeAssets}
          allowedTypes={isEnum ? ["Enum"] : ["Structure"]}
          allowNone
          title={isEnum ? "Pick Enum Type" : "Pick Structure Type"}
          onPick={(guid) => {
            commit({
              typeClassId: guid ?? undefined,
              defaultValue:
                container === "single"
                  ? defaultValueForMember(typeId, guid ?? undefined, schemas)
                  : member.defaultValue,
            });
            setTypeAssetPickerOpen(false);
          }}
          data-testid="inspector-member-type-asset-picker"
        />
      </div>
    );
  }

  if (member.kind === "function") {
    const inputRows = memberPinRows(member.pins, member.id, "in");
    const outputRows = memberPinRows(member.pins, member.id, "out");
    const commitPins = (
      nextInputs: PinListRow[],
      nextOutputs: PinListRow[],
    ) => {
      commit({ pins: memberPinsFromRows(nextInputs, nextOutputs) });
    };
    const interfaceImpl = member.implementsInterface;
    const lockSignature = Boolean(interfaceImpl);
    return (
      <div
        className="flex flex-col gap-3 p-3"
        data-testid="inspector-member-function"
      >
        <div className="text-sm font-medium">{member.name}</div>
        {interfaceImpl ? (
          <div
            className="text-xs text-muted-foreground"
            data-testid="inspector-member-interface-impl"
          >
            Interface Implementation
          </div>
        ) : null}
        <PropertyGrid
          rows={[
            {
              id: "name",
              kind: "text",
              label: "Name",
              value: member.name,
              disabled: lockSignature,
              onChange: (name) => commit({ name }),
            },
            ...(lockSignature
              ? []
              : [
                  {
                    id: "overridable",
                    kind: "boolean" as const,
                    label: "Overridable",
                    value: member.overridable === true,
                    onChange: (overridable: boolean) =>
                      commit({ overridable: overridable ? true : undefined }),
                  },
                ]),
          ]}
        />
        <PinListEditor
          title="Inputs"
          rows={inputRows}
          types={FUNCTION_PIN_PICKER_TYPES}
          classEntries={classEntries}
          typeAssets={typeAssets}
          testIdPrefix="class-fn-in"
          data-testid="inspector-member-inputs"
          readOnly={lockSignature}
          onChange={(nextRows) => commitPins(nextRows, outputRows)}
        />
        <PinListEditor
          title="Outputs"
          rows={outputRows}
          types={FUNCTION_PIN_PICKER_TYPES}
          classEntries={classEntries}
          typeAssets={typeAssets}
          testIdPrefix="class-fn-out"
          data-testid="inspector-member-outputs"
          readOnly={lockSignature}
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
          className="h-auto w-full justify-start"
          data-testid="inspector-member-interface-pick"
          onClick={() => setInterfacePickerOpen(true)}
        >
          {selectedPickerIdentity(
            assetRowIdentity(
              interfaceAssets.find((asset) => asset.guid === member.assetGuid),
            ),
            picked || "Pick Script Interface",
          )}
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

function PrefabComponentDetails({
  component,
  sortingLayers,
  collisionLayers,
  physicsWorld,
  viewportMode,
  pickerAssets,
  assetLabel,
  assetType,
  fontHasFacetype,
  onUpdate,
  onUpdateTransform,
}: {
  component: SerializedComponent;
  sortingLayers: readonly string[];
  collisionLayers: readonly string[];
  physicsWorld: "3d" | "2d";
  viewportMode: ViewportMode;
  pickerAssets: Array<{
    guid: string;
    name: string;
    type: string;
    path?: string;
  }>;
  assetLabel: (guid: string | null | undefined) => string | undefined;
  assetType: (guid: string | null | undefined) => string | undefined;
  fontHasFacetype?: (guid: string | null | undefined) => boolean;
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
        rows={spatialTransformPropertyRows(
          component.id,
          viewportMode,
          component.transform ?? identitySerializedTransform(),
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
            collisionLayers,
            assetLabel,
            assetType,
            fontHasFacetype,
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
  const {
    openDocuments,
    applyGraphChange,
    applyAssetDocumentChange,
    projectDocument,
    assetRegistry,
  } = useDocuments();
  const { focusDiagnostic } = useValidation();
  const { focusedNodeId } = usePlay();
  const { selectedNodeIds, selectedMemberId, activeFunctionId } =
    useGraphEditing();
  const animEditing = useOptionalAnimGraphEditing();
  const {
    selectedId: prefabSelectedId,
    selectedIds: prefabSelectedIds,
    components: prefabComponents,
    updateComponent,
    updateComponentTransform,
  } = usePrefabEditing();
  const viewportMode = useOptionalSceneEditing()?.viewportMode ?? "3d";
  const [classPinPick, setClassPinPick] = useState<{
    pinId: string;
    name: string;
    constraintClassId: string;
  } | null>(null);
  const [assetPinPick, setAssetPinPick] = useState<{
    pinId: string;
    name: string;
    assetType: string;
  } | null>(null);

  const doc = openDocuments.find((entry) => entry.id === documentId);
  const indexed = (assetRegistry?.list() ?? []).find(
    (asset) => asset.path === doc?.ref.path,
  );
  const parentClass = indexed?.header.parentClass ?? null;
  const parentOf = classParentLookup(assetRegistry?.list() ?? []);
  const editorGraph = isEditorGraphHost({
    parentClass,
    parentOf,
    assetType: indexed?.header.type,
  });
  const parsedAnim =
    doc?.ref.kind === "anim-graph"
      ? parseAnimGraphDocument(doc.content)
      : null;
  const openRuleId = animEditing?.openTransitionId ?? null;
  const ruleTransition =
    openRuleId && parsedAnim
      ? (parsedAnim.transitions.find((row) => row.id === openRuleId) ?? null)
      : null;
  const graph = ruleTransition && parsedAnim
    ? {
        ...decorateTransitionRuleGraph(
          ruleTransition.ruleGraph,
          !findReverseTransition(
            parsedAnim.transitions,
            ruleTransition.fromStateId,
            ruleTransition.toStateId,
          ),
        ),
        members: animGraphMembersFromVariables(parsedAnim.variables),
      }
    : serializedGraphFromDocument(doc?.ref.kind ?? "", doc?.content);
  const persistGraph = (next: SerializedGraph) => {
    if (!doc) return;
    if (ruleTransition && parsedAnim) {
      void applyAssetDocumentChange(
        documentId,
        patchTransition(parsedAnim, ruleTransition.id, {
          ruleGraph: persistTransitionRuleGraph(next),
        }) as unknown as Record<string, unknown>,
      );
      return;
    }
    const commit = commitLogicGraph(doc.ref.kind, doc.content, next);
    if (commit.kind !== "graph") {
      void applyAssetDocumentChange(documentId, commit.payload);
      return;
    }
    void applyGraphChange(documentId, commit.graph);
  };
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
  const typeCatalog = collectGraphTypeAssets({
    assets: assetRegistry?.list() ?? [],
    openDocuments,
  });
  const typeSchemas = typeSchemasFromGraphAssets(typeCatalog);
  const typeAssets = typeAssetPickerEntries(typeCatalog);
  const sortingLayers =
    projectDocument?.settings.twoD?.sortingLayers ?? DEFAULT_SORTING_LAYERS;
  const collisionLayers =
    projectDocument?.settings.physics?.collisionLayers ?? DEFAULT_COLLISION_LAYERS;
  const physicsWorld = physicsWorldFromOpenDocuments(openDocuments);
  const assetLabel = (guid: string | null | undefined) => {
    if (!guid) return undefined;
    return (
      assetRegistry?.getByGuid?.(guid)?.header.name ??
      pickerAssets.find((asset) => asset.guid === guid)?.name
    );
  };
  const assetType = (guid: string | null | undefined) => {
    if (!guid) return undefined;
    return (
      assetRegistry?.getByGuid?.(guid)?.header.type ??
      pickerAssets.find((asset) => asset.guid === guid)?.type
    );
  };
  const fontHasFacetype = (guid: string | null | undefined) => {
    if (!guid) return false;
    return fontAssetHasFacetype(assetRegistry?.getByGuid?.(guid)?.header.payload);
  };

  const selectedPrefabComponentIds = prefabSelectedIds.filter(
    (id) => id !== PREFAB_ROOT_ID,
  );

  if (selectedPrefabComponentIds.length > 1) {
    return (
      <PanelFrame data-testid="inspector-panel">
        <p
          className="p-4 text-sm font-semibold text-foreground"
          data-testid="inspector-prefab-multi"
        >
          {`${selectedPrefabComponentIds.length} Components`}
        </p>
      </PanelFrame>
    );
  }

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
          collisionLayers={collisionLayers}
          physicsWorld={physicsWorld}
          viewportMode={viewportMode}
          pickerAssets={pickerAssets}
          assetLabel={assetLabel}
          assetType={assetType}
          fontHasFacetype={fontHasFacetype}
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

  if (graph && selectedMember && !openRuleId && selectedMember.kind !== "event") {
    return (
      <PanelFrame data-testid="inspector-panel">
        <ClassMemberDetails
          graph={graph}
          member={selectedMember}
          interfaceAssets={interfaceAssets}
          classEntries={subclassClassEntries(
            "BObject",
            assetRegistry?.list() ?? [],
            { editorGraph },
          )}
          typeAssets={typeAssets}
          schemas={typeSchemas}
          enumMembers={collectEnumMemberNames(
            openDocuments,
            assetRegistry?.list() ?? [],
          )}
          onChange={persistGraph}
        />
      </PanelFrame>
    );
  }

  if (prefabSelectedId === PREFAB_ROOT_ID && doc?.ref.kind === "graph") {
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
        <p
          className="p-4 text-sm text-muted-foreground"
          data-testid={openRuleId ? "anim-rule-details-empty" : undefined}
        >
          {openRuleId
            ? "Select a Node"
            : "Select a graph node, class member, or prefab component to edit properties."}
        </p>
      </PanelFrame>
    );
  }

  const isExecJs = selectedNode.type === "debug.executeJavaScript";
  const isCommandRun = selectedNode.type === "flow.event.commandRun";
  const isCustomEvent = selectedNode.type === "flow.event.custom";
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
  const eventMember = isCustomEvent
    ? (graph.members ?? []).find(
        (member) =>
          member.kind === "event" &&
          (member.id === selectedNode.id ||
            formatEventMemberName(String(member.name)) ===
              formatEventMemberName(String(selectedNode.data.name ?? ""))),
      )
    : undefined;
  const eventOutputRows: PinListRow[] = (
    eventMember?.pins ??
    (Array.isArray(selectedNode.data.pins)
      ? (selectedNode.data.pins as Array<{
          name?: string;
          typeId?: string;
          typeClassId?: string;
          direction?: string;
        }>)
      : [])
  )
    .filter((pin) => pin.direction !== "in" && pin.name)
    .map((pin, index) => ({
      id: `${selectedNode.id}-out-${index}`,
      name: String(pin.name),
      type: pin.typeId ?? "float",
      ...("typeClassId" in pin && pin.typeClassId
        ? { typeClassId: pin.typeClassId }
        : {}),
    }));
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
    persistGraph(next);
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
      classEntries: subclassClassEntries(
        "BObject",
        assetRegistry?.list() ?? [],
        { editorGraph },
      ),
      onPickClass: (pinId, constraintClassId) => {
        const name =
          pinsFromNodeData(selectedNode.data).find((pin) => pin.id === pinId)
            ?.name ?? pinId;
        setClassPinPick({ pinId, name, constraintClassId });
      },
      assetEntries: pickerAssets.map((asset) => ({
        id: asset.guid,
        name: asset.name,
        type: asset.type,
      })),
      onPickAsset: (pinId, assetType) => {
        const name =
          pinsFromNodeData(selectedNode.data).find((pin) => pin.id === pinId)
            ?.name ?? pinId;
        setAssetPinPick({ pinId, name, assetType });
      },
      schemas: typeSchemas,
    },
  );
  const isEnumNode = selectedNode.type.startsWith("enum.");
  const enumNodeRows = isEnumNode
    ? enumNodePropertyRows(
        selectedNode.type,
        selectedNode.data,
        updateNodeData,
        {
          enums: typeCatalog.enums,
          typeSelectDisabled: Boolean(
            connectedEnumGuidFromSerialized(graph, selectedNode.id),
          ),
        },
      )
    : [];
  const logRows = isLog
    ? logNodePropertyRows(selectedNode.data, updateNodeData)
    : [];
  const containerConstructorRows = containerConstructorPropertyRows(
    selectedNode.type,
    selectedNode.data,
    updateNodeData,
  );
  const isFlowSwitch = isFlowSwitchTypeId(selectedNode.type);
  const flowSwitchCases = isFlowSwitch
    ? flowSwitchCaseListValues(selectedNode.type, selectedNode.data)
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
        {enumNodeRows.length > 0 ? (
          <PropertyGrid
            rows={enumNodeRows}
            data-testid="inspector-enum-properties"
          />
        ) : null}
        {containerConstructorRows.length > 0 ? (
          <PropertyGrid
            rows={containerConstructorRows}
            data-testid="inspector-container-constructor"
          />
        ) : null}
        {isFlowSwitch ? (
          <NamedListEditor
            title="Cases"
            values={flowSwitchCases}
            addPlaceholder={
              selectedNode.type === "flow.switchInt" ? "0" : "case"
            }
            onChange={(values) =>
              updateNodeData(patchFlowSwitchCases(selectedNode.type, values))
            }
            data-testid="inspector-flow-switch-cases"
          />
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
              <Field
                data-invalid={
                  isReservedConsoleCommandName(
                    String(selectedNode.data.commandName ?? ""),
                  ) || undefined
                }
              >
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
                {isReservedConsoleCommandName(
                  String(selectedNode.data.commandName ?? ""),
                ) ? (
                  <FieldError data-testid="command-name-reserved">
                    Command Name '{String(selectedNode.data.commandName ?? "").trim()}' is reserved by the engine
                  </FieldError>
                ) : null}
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
        {isCustomEvent ? (
          <PinListEditor
            title="Outputs"
            rows={eventOutputRows}
            types={PIN_PICKER_TYPES}
            classEntries={subclassClassEntries(
              "BObject",
              assetRegistry?.list() ?? [],
              { editorGraph },
            )}
            typeAssets={typeAssets}
            testIdPrefix="event-out"
            data-testid="inspector-event-outputs"
            onChange={(rows) => {
              const pins = memberPinsFromRows([], rows);
              if (eventMember) {
                persistGraph(patchClassMember(graph, eventMember.id, { pins }));
                return;
              }
              // Canvas custom-event without a members[] row: upsert then sync Calls.
              const bodyName = formatEventMemberName(
                String(selectedNode.data.name ?? selectedNode.data.title ?? "Custom"),
              );
              const memberId = selectedNode.id;
              const withMember: SerializedGraph = {
                ...graph,
                members: [
                  ...(graph.members ?? []).filter(
                    (entry) => entry.id !== memberId,
                  ),
                  {
                    id: memberId,
                    kind: "event",
                    name: bodyName,
                    pins,
                  },
                ],
                nodes: graph.nodes.map((node) =>
                  node.id === selectedNode.id
                    ? {
                        ...node,
                        data: {
                          ...node.data,
                          name: bodyName,
                          title: `Event ${bodyName}`,
                          pins,
                        },
                      }
                    : node,
                ),
              };
              persistGraph(patchClassMember(withMember, memberId, { pins }));
            }}
          />
        ) : null}
      </div>
      <ClassPicker
        open={classPinPick !== null}
        onOpenChange={(open) => {
          if (!open) setClassPinPick(null);
        }}
        classes={
          classPinPick
            ? subclassClassEntries(
                classPinPick.constraintClassId,
                assetRegistry?.list() ?? [],
                { editorGraph },
              )
            : []
        }
        allowNone={false}
        onPick={(classId) => {
          if (classPinPick && classId) {
            updateNodeData({
              [pinDefaultPropertyKey(classPinPick.name)]: classId,
            });
          }
          setClassPinPick(null);
        }}
        data-testid="inspector-class-picker"
      />
      <AssetPicker
        open={assetPinPick !== null}
        onOpenChange={(open) => {
          if (!open) setAssetPinPick(null);
        }}
        assets={pickerAssets}
        allowedTypes={assetPinPick ? [assetPinPick.assetType] : undefined}
        allowNone
        title={assetPinPick ? `Pick ${assetPinPick.assetType}` : "Pick Asset"}
        onPick={(guid) => {
          if (assetPinPick) {
            updateNodeData({
              [pinDefaultPropertyKey(assetPinPick.name)]: guid ?? "",
            });
          }
          setAssetPinPick(null);
        }}
        data-testid="inspector-asset-picker"
      />
    </PanelFrame>
  );
}
