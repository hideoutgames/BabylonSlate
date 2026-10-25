import type { Dispatch, SetStateAction } from "react";
import type { SerializedGraph } from "@haptic/core";
import {
  AssetPicker,
  ClassPicker,
  MultilineTextField,
  PIN_PICKER_TYPES,
  ParameterListEditor,
  NamedListEditor,
  NamePromptDialog,
  PinListEditor,
  PropertyGrid,
  formatEventMemberName,
  useTags,
  type PinListRow,
} from "@haptic/editor-kit";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@haptic/ui/components/field";
import { Input } from "@haptic/ui/components/input";
import { Button } from "@haptic/ui/components/button";
import { useRegistryState } from "../context/document-context";
import { GraphDataLiteralDefaults } from "../components/graph-data-literal-editor";
import { JsBodyEditor } from "../components/js-body-editor";
import { GlslCodePreview } from "../components/glsl-code-preview";
import { DataTreeEntryField } from "../components/data-tree-entry-picker";
import { subclassClassEntries } from "../lib/component-property-rows";
import { executeJavaScriptNameError } from "@haptic/scripting-nodes";
import { isReservedConsoleCommandName } from "@haptic/debugger";
import {
  assetPickerAllowedTypes,
  commandParameterRows,
  commandParametersFromRows,
  connectedEnumGuidFromSerialized,
  containerConstructorPropertyRows,
  developmentOnlyPropertyRows,
  dataNodePropertyRows,
  dataNodePathOptions,
  graphDataLiteralField,
  enumNodePropertyRows,
  flowSwitchCaseListValues,
  inspectorLiteralPinDefaults,
  inputEventPropertyRows,
  isFlowSwitchTypeId,
  logNodePropertyRows,
  javaScriptPinRows,
  patchFlowSwitchCases,
  pinDefaultPropertyRows,
  javaScriptPinsFromRows,
  structNodePropertyRows,
  tagNodePropertyRows,
} from "../lib/graph-inspector";
import { pinDefaultPropertyKey } from "@haptic/scripting";
import { canRenameCustomEvent, customEventRenameError, patchClassMember, renameCustomEvent } from "../lib/class-members";
import { filterInspectorPinPickerAssets } from "../lib/content-browser-helpers";
import { dataGraphAssetCreateOptions, dataGraphAssetPickPatch, isDataGraphNode, patchDataGraphNode, patchInspectedGraphNode } from "../lib/data-graph";
import { classIdForGraphPath } from "../services/script-compiler";
import {
  MATERIAL_DOCUMENT_KINDS,
  useOpenDocumentsOfKinds,
} from "../lib/use-open-documents-of-kinds";
import {
  committedPinRowIds,
  memberPinsFromRows,
  pinRowIdsFor,
  type CommittedPinRowIds,
} from "./inspector-member-rows";
import type { InspectorCatalogs } from "./use-inspector-catalogs";

/** The pin whose default the Class picker fills, and the base Class it allows. */
export type ClassPinPick = { pinId: string; constraintClassId: string };
/** The pin whose default the asset picker fills, and the asset types it allows. */
export type AssetPinPick = { pinId: string; assetType: string; allowedTypes: string[] };
/** Command parameter row ids from the last commit, as for member pins. */
export type CommandRowIds = { nodeId: string; parameters: string; ids: string[] };

/**
 * What the selected node's details read from the Inspector. The Inspector
 * owns the pin list and picker state, so it outlives a switch to a member,
 * prefab component or empty view and back.
 */
export interface GraphNodeDetailsProps {
  graph: SerializedGraph;
  /** The event graph, or the active function's slice of it. */
  inspectGraph: SerializedGraph | null;
  /** `inspectGraph` with editor pins, when the selected node needs them. */
  hydratedInspectGraph: SerializedGraph | null;
  selectedNode: SerializedGraph["nodes"][number];
  activeFunctionId: string | null;
  /** The inspected document's path; a renamed event's Calls are scoped to its Class. */
  docPath: string | undefined;
  /** The focused diagnostic's line in an Execute JavaScript body. */
  focusBodyLine?: number;
  catalogs: InspectorCatalogs;
  persistGraph: (next: SerializedGraph) => void;
  selectedJsPin: string | null;
  selectJsPin: Dispatch<SetStateAction<string | null>>;
  renameEventOpen: boolean;
  setRenameEventOpen: Dispatch<SetStateAction<boolean>>;
  classPinPick: ClassPinPick | null;
  setClassPinPick: Dispatch<SetStateAction<ClassPinPick | null>>;
  assetPinPick: AssetPinPick | null;
  setAssetPinPick: Dispatch<SetStateAction<AssetPinPick | null>>;
  eventPinRowIds: CommittedPinRowIds | null;
  setEventPinRowIds: Dispatch<SetStateAction<CommittedPinRowIds | null>>;
  commandRowIds: CommandRowIds | null;
  setCommandRowIds: Dispatch<SetStateAction<CommandRowIds | null>>;
}

/** The selected graph node's property rows, pin defaults and pin pickers. */
export function GraphNodeDetails({
  graph,
  inspectGraph,
  hydratedInspectGraph,
  selectedNode,
  activeFunctionId,
  docPath,
  focusBodyLine,
  catalogs,
  persistGraph,
  selectedJsPin,
  selectJsPin,
  renameEventOpen,
  setRenameEventOpen,
  classPinPick,
  setClassPinPick,
  assetPinPick,
  setAssetPinPick,
  eventPinRowIds,
  setEventPinRowIds,
  commandRowIds,
  setCommandRowIds,
}: GraphNodeDetailsProps) {
  const {
    dataAssets,
    editorGraph,
    enumMembers,
    objectClassEntries,
    pickerAssets,
    typeAssets,
    typeCatalog,
    typeSchemas,
  } = catalogs;
  const { assetRegistry } = useRegistryState();
  const { entries: tags } = useTags();
  // Open Material tabs' unsaved domains filter the post-process picker.
  const pickerMaterialDocuments = useOpenDocumentsOfKinds(MATERIAL_DOCUMENT_KINDS);

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
  // Inputs and outputs share one generated function scope.
  const jsNameError = isExecJs
    ? executeJavaScriptNameError([...inputs, ...outputs].map((pin) => pin.name))
    : undefined;
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
  const eventOutputIds = pinRowIdsFor(eventPinRowIds, selectedNode.id, eventMember?.pins, "out");
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
      id: eventOutputIds?.[index] ?? `${selectedNode.id}-out-${index}`,
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
    persistGraph(isDataGraphNode(selectedNode.type)
      ? patchDataGraphNode(graph, selectedNode, patch, activeFunctionId)
      : patchInspectedGraphNode(graph, selectedNode.id, patch, activeFunctionId));
  };

  const dataPinWired = (pinId: string) => (inspectGraph?.edges ?? graph.edges)
    .some((edge) => edge.target === selectedNode.id && edge.targetHandle === pinId);
  const literalDefaults = inspectorLiteralPinDefaults(selectedNode, inspectGraph?.edges ?? graph.edges, (hydratedInspectGraph ?? inspectGraph)?.nodes);
  const pathDefaults = literalDefaults.flatMap((entry) => {
    const options = dataNodePathOptions(selectedNode.type, entry.pinId, selectedNode.data, dataAssets, dataPinWired);
    return options ? [{ ...options, pin: entry }] : [];
  });
  const dataLiteralDefaults = literalDefaults.filter((entry) => graphDataLiteralField(entry, typeSchemas));
  const pinDefaultRows = pinDefaultPropertyRows(
    literalDefaults.filter((entry) =>
      !graphDataLiteralField(entry, typeSchemas) &&
      !pathDefaults.some((path) => path.pin.pinId === entry.pinId) &&
      !((selectedNode.type === "input.actionEvent" || selectedNode.type === "input.axisEvent") && entry.pinId === "binding")),
    updateNodeData,
    {
      enumMembers,
      classEntries: objectClassEntries,
      onPickClass: (pinId, constraintClassId) => {
        setClassPinPick({ pinId, constraintClassId });
      },
      assetEntries: pickerAssets.map((asset) => ({
        id: asset.guid,
        name: asset.name,
        type: asset.type,
      })),
      onPickAsset: (pinId, assetType) => {
        setAssetPinPick({
          pinId,
          assetType,
          allowedTypes: assetPickerAllowedTypes(assetType),
        });
      },
      schemas: typeSchemas,
    },
  );
  /** A Structure field inside a pin default writes through its own row, not as a pin. */
  const nestedPinDefaultRow = (rowId: string) =>
    literalDefaults.some((entry) => entry.pinId === rowId)
      ? undefined
      : pinDefaultRows.find((row) => row.id === rowId);
  const isEnumNode = selectedNode.type.startsWith("enum.");
  const enumNodeRows = isEnumNode
    ? enumNodePropertyRows(
        selectedNode.type,
        selectedNode.data,
        updateNodeData,
        {
          enums: typeCatalog.enums,
          // The wire lives in the graph being inspected (event or function).
          typeSelectDisabled: Boolean(
            connectedEnumGuidFromSerialized(
              hydratedInspectGraph ?? inspectGraph ?? graph,
              selectedNode.id,
            ),
          ),
        },
      )
    : [];
  const logRows = isLog
    ? logNodePropertyRows(selectedNode.data, updateNodeData)
    : [];
  const structNodeRows = structNodePropertyRows(
    selectedNode.type,
    selectedNode.data,
    updateNodeData,
    typeCatalog.structures,
    typeCatalog.dataDefinitions,
  );
  const dataNodeRows = dataNodePropertyRows(
    selectedNode.type,
    selectedNode.data,
    updateNodeData,
    typeCatalog.dataDefinitions,
  );
  const inputEventRows = inputEventPropertyRows(
    selectedNode.type,
    selectedNode.data,
    updateNodeData,
    pickerAssets.map((asset) => ({ id: asset.guid, name: asset.name, type: asset.type })),
    dataPinWired("binding"),
  );
  const containerConstructorRows = containerConstructorPropertyRows(
    selectedNode.type,
    selectedNode.data,
    updateNodeData,
  );
  const tagNodeRows = tagNodePropertyRows(
    selectedNode.type,
    selectedNode.data,
    updateNodeData,
    tags,
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
    <>
      <div className="flex flex-col gap-3 p-3">
        <div className="text-sm font-medium">{title}</div>
        {inputEventRows.length > 0 ? (
          <PropertyGrid rows={inputEventRows} data-testid="inspector-input-event" />
        ) : null}
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
        {structNodeRows.length > 0 ? (
          <PropertyGrid
            rows={structNodeRows}
            data-testid="inspector-struct-properties"
          />
        ) : null}
        {dataNodeRows.length > 0 ? (
          <PropertyGrid rows={dataNodeRows} data-testid="inspector-data-properties" />
        ) : null}
        {containerConstructorRows.length > 0 ? (
          <PropertyGrid
            rows={containerConstructorRows}
            data-testid="inspector-container-constructor"
          />
        ) : null}
        {tagNodeRows.length > 0 ? (
          <PropertyGrid
            rows={tagNodeRows}
            data-testid="inspector-tag-cases"
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
        {pinDefaultRows.length > 0 || pathDefaults.length > 0 ? (
          <div data-testid="inspector-pin-defaults" className="flex flex-col gap-2">
            <PropertyGrid title="Defaults" rows={pinDefaultRows} />
            {pathDefaults.map(({ pin, ...options }) => <DataTreeEntryField key={pin.pinId} {...options}
              value={typeof pin.value === "string" ? pin.value : ""} label={pin.name}
              testId={`property-default:${pin.pinId}`}
              onChange={(path) => updateNodeData(dataGraphAssetPickPatch(selectedNode.type, pin.pinId, path, dataAssets, selectedNode.data))} />)}
          </div>
        ) : null}
        {dataLiteralDefaults.length > 0 ? <GraphDataLiteralDefaults entries={dataLiteralDefaults}
          nodeData={selectedNode.data} onPatch={updateNodeData} /> : null}
        {isExecJs ? (
          <>
            <PinListEditor
              title="Inputs"
              rows={javaScriptPinRows(inputs, "in")}
              showContainer showOptional={false} showDefault={false}
              selectedId={selectedJsPin} onSelect={selectJsPin}
              classEntries={objectClassEntries}
              typeAssets={typeAssets}
              itemLabel="Input"
              testIdPrefix="js-input"
              onChange={(rows) =>
                updateNodeData({ inputs: javaScriptPinsFromRows(rows) })
              }
            />
            <PinListEditor
              title="Outputs"
              rows={javaScriptPinRows(outputs, "out")}
              showContainer showOptional={false} showDefault={false}
              selectedId={selectedJsPin} onSelect={selectJsPin}
              classEntries={objectClassEntries}
              typeAssets={typeAssets}
              itemLabel="Output"
              testIdPrefix="js-output"
              onChange={(rows) =>
                updateNodeData({ outputs: javaScriptPinsFromRows(rows) })
              }
            />
            {jsNameError ? (
              <FieldError data-testid="js-name-error">{jsNameError}</FieldError>
            ) : null}
            <MultilineTextField code title="JavaScript Function Body" data-testid="class-node-code"
              value={String(selectedNode.data.body ?? "")}
              onChange={(body) => updateNodeData({ body })}
              renderPreview={(value) => <GlslCodePreview value={value} language="javascript" />}
              renderEditor={(value, onChange) => <JsBodyEditor value={value} onChange={onChange} bodyLine={focusBodyLine} names={[...inputs, ...outputs].map((pin) => pin.name)} />}
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
                  className="pointer-coarse:min-h-11"
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
                    Command Name '
                    {String(selectedNode.data.commandName ?? "").trim()}' is
                    reserved by the engine
                  </FieldError>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="command-description">
                  Description
                </FieldLabel>
                <Input
                  id="command-description"
                  className="pointer-coarse:min-h-11"
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
                  className="pointer-coarse:min-h-11"
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
              rows={commandParameterRows(
                commandParams,
                commandRowIds?.nodeId === selectedNode.id &&
                  commandRowIds.parameters === JSON.stringify(commandParams)
                  ? commandRowIds.ids
                  : undefined,
              )}
              onChange={(rows) => {
                const parameters = commandParametersFromRows(rows);
                setCommandRowIds({
                  nodeId: selectedNode.id,
                  parameters: JSON.stringify(parameters),
                  ids: rows.map((row) => row.id),
                });
                updateNodeData({ parameters });
              }}
            />
          </>
        ) : null}
        {isCustomEvent ? (
          <>
          {canRenameCustomEvent(graph, selectedNode.id) ? (
            <Button variant="outline" size="sm" onClick={() => setRenameEventOpen(true)}>
              Rename Event
            </Button>
          ) : null}
          <NamePromptDialog
            key={selectedNode.id}
            open={renameEventOpen}
            onOpenChange={setRenameEventOpen}
            title="Rename Event"
            label="Event Name"
            confirmLabel="Rename"
            initialValue={formatEventMemberName(String(selectedNode.data.name ?? selectedNode.data.title ?? ""))}
            validate={(name) => customEventRenameError(graph, selectedNode.id, name)}
            onSubmit={(name) => persistGraph(renameCustomEvent(graph, selectedNode.id, name, docPath ? classIdForGraphPath(docPath) : undefined))}
          />
          <PinListEditor
            title="Outputs"
            rows={eventOutputRows}
            types={PIN_PICKER_TYPES}
            classEntries={objectClassEntries}
            typeAssets={typeAssets}
            itemLabel="Output"
            testIdPrefix="event-out"
            data-testid="inspector-event-outputs"
            showOptional={false}
            showDefault={false}
            showUnit
            onChange={(rows) => {
              const pins = memberPinsFromRows([], rows);
              setEventPinRowIds(committedPinRowIds(selectedNode.id, pins, [], rows));
              if (eventMember) {
                persistGraph(patchClassMember(graph, eventMember.id, { pins }));
                return;
              }
              // Canvas custom-event without a members[] row: upsert then sync Calls.
              const bodyName = formatEventMemberName(
                String(
                  selectedNode.data.name ?? selectedNode.data.title ?? "Custom",
                ),
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
          </>
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
        createBaseClass={classPinPick?.constraintClassId}
        onPick={(classId) => {
          if (classPinPick && classId) {
            const nested = nestedPinDefaultRow(classPinPick.pinId);
            if (nested?.kind === "asset") nested.onChange(classId);
            else updateNodeData({
              [pinDefaultPropertyKey(classPinPick.pinId)]: classId,
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
        assets={
          // Only while picking: every edit of the graph re-renders this branch.
          assetPinPick
            ? filterInspectorPinPickerAssets(
                pickerAssets,
                assetRegistry?.list() ?? [],
                pickerMaterialDocuments,
                { nodeType: selectedNode.type },
              )
            : []
        }
        allowedTypes={assetPinPick?.allowedTypes}
        createOptions={
          selectedNode.type === "scene-layer.registerPostProcess" ||
          selectedNode.type === "scene-layer.unregisterPostProcess"
            ? { materialDomain: "postProcess" }
            : assetPinPick
              ? dataGraphAssetCreateOptions(selectedNode.type, assetPinPick.pinId, selectedNode.data)
              : undefined
        }
        allowNone
        title={assetPinPick ? `Pick ${assetPinPick.assetType || "Asset"}` : "Pick Asset"}
        onPick={(guid) => {
          if (assetPinPick) {
            const nested = nestedPinDefaultRow(assetPinPick.pinId);
            if (nested?.kind === "asset") nested.onChange(guid ?? "");
            else updateNodeData(dataGraphAssetPickPatch(selectedNode.type, assetPinPick.pinId, guid, dataAssets, selectedNode.data, dataPinWired));
          }
          setAssetPinPick(null);
        }}
        data-testid="inspector-asset-picker"
      />
    </>
  );
}
