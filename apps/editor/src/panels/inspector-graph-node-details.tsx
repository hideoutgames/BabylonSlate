import { useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import type { SerializedGraph } from "@haptic/core";
import {
  AssetPicker,
  CLASS_PIN_PICKER_TYPES,
  ClassPicker,
  MultilineTextField,
  ParameterListEditor,
  NamedListEditor,
  NamePromptDialog,
  PinListEditor,
  PropertyGrid,
  formatEventMemberName,
  mergePropertyRows,
  useTags,
  type DelegateSignatureEntry,
  type PinListRow,
  type PropertyRow,
} from "@haptic/editor-kit";
import { OUTPUT_DELEGATE_PIN_ID, POST_PROCESS_MATERIAL_NODE_IDS, isDispatcherNodeType, isTimelineProxyPickerNode } from "@haptic/scripting-nodes";
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
import { LazyGlslCodePreview, LazyJsBodyEditor } from "../components/lazy-code-editors";
import { DataTreeEntryField } from "../components/data-tree-entry-picker";
import { subclassClassEntries } from "../lib/component-property-rows";
import { executeJavaScriptNameError } from "@haptic/scripting-nodes";
import { isReservedConsoleCommandName } from "@haptic/debugger";
import {
  commandParameterRows,
  commandParametersFromRows,
  flowSwitchCaseListValues,
  isFlowSwitchTypeId,
  javaScriptPinRows,
  patchFlowSwitchCases,
  javaScriptPinsFromRows,
} from "../lib/graph-inspector";
import { canRenameCustomEvent, customEventRenameError, patchClassMember, renameCustomEvent } from "../lib/class-members";
import { filterInspectorPinPickerAssets } from "../lib/content-browser-helpers";
import { dataGraphAssetCreateOptions, dataGraphAssetPickPatch, isDataGraphNode, patchDataGraphNode, patchInspectedGraphNode } from "../lib/data-graph";
import { classIdForGraphPath } from "../services/script-compiler";
import {
  MATERIAL_DOCUMENT_KINDS,
  TIMELINE_CLIP_DOCUMENT_KINDS,
  useOpenDocumentsOfKinds,
} from "../lib/use-open-documents-of-kinds";
import { projectTimelineClips } from "../lib/timeline-asset-index";
import { timelineProxyNodeTarget, timelineScriptAssets } from "../lib/timeline-script-catalog";
import {
  committedPinRowIds,
  memberPinsFromRows,
  pinRowIdsFor,
  type CommittedPinRowIds,
} from "./inspector-member-rows";
import { FunctionPinListEditors } from "./inspector-function-pins";
import {
  GRAPH_NODE_ROW_SECTIONS,
  graphNodeInspectorRows,
  type AssetPinPick,
  type ClassPinPick,
  type GraphNodeRowSection,
} from "./inspector-node-rows";
import type { InspectorCatalogs } from "./use-inspector-catalogs";


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
  /** The graph's host class id, so a function signature edit reaches only its own Calls. */
  classId?: string;
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
  /** Event Dispatchers a Delegate type can take its signature from. */
  delegateSignatures?: readonly DelegateSignatureEntry[];
}

/** The selected graph node's property rows, pin defaults and pin pickers. */
export function GraphNodeDetails({
  graph,
  inspectGraph,
  hydratedInspectGraph,
  selectedNode,
  activeFunctionId,
  docPath,
  classId,
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
  delegateSignatures = [],
}: GraphNodeDetailsProps) {
  const { dataAssets, objectClassEntries, typeAssets } = catalogs;
  const { assetRegistry, registryEpoch } = useRegistryState();
  const { entries: tags } = useTags();
  // A Timeline Proxy node's clip asset, from its header or its open tab.
  const clipDocuments = useOpenDocumentsOfKinds(TIMELINE_CLIP_DOCUMENT_KINDS);
  const proxyPicker = isTimelineProxyPickerNode(selectedNode.type);
  const proxyClip = useMemo(() => {
    void registryEpoch;
    if (!proxyPicker) return undefined;
    const assets = assetRegistry?.list() ?? [];
    return timelineProxyNodeTarget(timelineScriptAssets(assets, projectTimelineClips(assets, clipDocuments)), selectedNode.data).clip;
  }, [assetRegistry, clipDocuments, proxyPicker, registryEpoch, selectedNode.data]);

  const isExecJs = selectedNode.type === "debug.executeJavaScript";
  const isCommandRun = selectedNode.type === "flow.event.commandRun";
  const isCustomEvent = selectedNode.type === "flow.event.custom";
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
      ...(pin.typeId === "delegate"
        ? { signature: (pin as { signature?: PinListRow["signature"] }).signature ?? [] }
        : {}),
    }));
  // A function's Input node edits its Inputs, its Output node its Outputs.
  const functionEndpoint =
    selectedNode.type === "flow.function.input" ? "in"
      : selectedNode.type === "flow.function.output" ? "out"
        : null;
  const endpointFunction = functionEndpoint && activeFunctionId
    ? (graph.members ?? []).find((member) => member.kind === "function" && member.id === activeFunctionId)
    : undefined;
  // Wired to a delegate input, a custom event takes that delegate's signature (as in Unreal).
  const eventSignatureFrom = isCustomEvent ? customEventSignatureSource(graph, selectedNode.id) : null;
  const title =
    typeof selectedNode.data.title === "string" && selectedNode.data.title
      ? selectedNode.data.title
      : selectedNode.type;

  const updateNodeData = (patch: Record<string, unknown>) => {
    persistGraph(isDataGraphNode(selectedNode.type)
      ? patchDataGraphNode(graph, selectedNode, patch, activeFunctionId)
      : patchInspectedGraphNode(graph, selectedNode.id, patch, activeFunctionId));
  };

  const nodeRows = graphNodeInspectorRows(selectedNode, {
    graph,
    inspectGraph,
    hydratedInspectGraph,
    catalogs,
    tags,
    proxyClip,
    updateNodeData,
    onPickClass: setClassPinPick,
    onPickAsset: setAssetPinPick,
  });
  const { sections, pinDefaults: pinDefaultRows, pathDefaults, dataLiteralDefaults } = nodeRows;
  const isFlowSwitch = isFlowSwitchTypeId(selectedNode.type);
  const flowSwitchCases = isFlowSwitch
    ? flowSwitchCaseListValues(selectedNode.type, selectedNode.data)
    : [];

  return (
    <>
      <div className="flex flex-col gap-3 p-3">
        <div className="text-sm font-medium">{title}</div>
        <GraphNodeRowSections sections={sections} />
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
        {functionEndpoint && endpointFunction ? (
          <FunctionPinListEditors
            graph={graph}
            member={endpointFunction}
            only={functionEndpoint}
            classEntries={objectClassEntries}
            typeAssets={typeAssets}
            classId={classId}
            delegateSignatures={delegateSignatures}
            onChange={persistGraph}
          />
        ) : null}
        {isExecJs ? (
          <>
            <PinListEditor
              title="Inputs"
              rows={javaScriptPinRows(inputs, "in")}
              showContainer showOptional={false} showDefault={false}
              selectedId={selectedJsPin} onSelect={selectJsPin}
              classEntries={objectClassEntries}
              typeAssets={typeAssets}
              types={CLASS_PIN_PICKER_TYPES}
              delegateSignatures={delegateSignatures}
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
              types={CLASS_PIN_PICKER_TYPES}
              delegateSignatures={delegateSignatures}
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
              renderPreview={(value) => <LazyGlslCodePreview value={value} language="javascript" />}
              renderEditor={(value, onChange) => <LazyJsBodyEditor value={value} onChange={onChange} bodyLine={focusBodyLine} names={[...inputs, ...outputs].map((pin) => pin.name)} />}
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
          {eventSignatureFrom ? (
            <div className="text-xs text-muted-foreground" data-testid="inspector-event-signature-from">
              Signature From: {eventSignatureFrom}
            </div>
          ) : null}
          <PinListEditor
            title="Outputs"
            rows={eventOutputRows}
            types={CLASS_PIN_PICKER_TYPES}
            classEntries={objectClassEntries}
            typeAssets={typeAssets}
            delegateSignatures={delegateSignatures}
            itemLabel="Output"
            testIdPrefix="event-out"
            data-testid="inspector-event-outputs"
            readOnly={eventSignatureFrom !== null}
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
      <GraphPinPickers
        node={selectedNode}
        catalogs={catalogs}
        classPinPick={classPinPick}
        setClassPinPick={setClassPinPick}
        assetPinPick={assetPinPick}
        setAssetPinPick={setAssetPinPick}
        pickClass={nodeRows.pickClass}
        pickAsset={nodeRows.pickAsset}
      />
    </>
  );
}

/** A node's PropertyGrid sections, each shown while it has rows. */
function GraphNodeRowSections({ sections }: { sections: Readonly<Record<GraphNodeRowSection, PropertyRow[]>> }) {
  return (
    <>
      {GRAPH_NODE_ROW_SECTIONS.map(({ section, testId }) =>
        sections[section].length > 0
          ? <PropertyGrid key={section} rows={sections[section]} data-testid={testId} />
          : null)}
    </>
  );
}

/** The Class and asset pickers a pin Default row opens; `node` filters and creates for its type. */
function GraphPinPickers({
  node,
  catalogs,
  classPinPick,
  setClassPinPick,
  assetPinPick,
  setAssetPinPick,
  pickClass,
  pickAsset,
}: {
  node: SerializedGraph["nodes"][number];
  catalogs: InspectorCatalogs;
  classPinPick: ClassPinPick | null;
  setClassPinPick: Dispatch<SetStateAction<ClassPinPick | null>>;
  assetPinPick: AssetPinPick | null;
  setAssetPinPick: Dispatch<SetStateAction<AssetPinPick | null>>;
  pickClass: (pinId: string, classId: string) => void;
  pickAsset: (pinId: string, guid: string | null) => void;
}) {
  const { editorGraph, pickerAssets } = catalogs;
  const { assetRegistry } = useRegistryState();
  // Open Material tabs' unsaved domains filter the post-process picker.
  const pickerMaterialDocuments = useOpenDocumentsOfKinds(MATERIAL_DOCUMENT_KINDS);
  return (
    <>
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
          if (classPinPick && classId) pickClass(classPinPick.pinId, classId);
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
                { nodeType: node.type },
              )
            : []
        }
        allowedTypes={assetPinPick?.allowedTypes}
        createOptions={
          POST_PROCESS_MATERIAL_NODE_IDS.has(node.type)
            ? { materialDomain: "postProcess" }
            : assetPinPick
              ? dataGraphAssetCreateOptions(node.type, assetPinPick.pinId, node.data)
              : undefined
        }
        allowNone
        title={assetPinPick ? `Pick ${assetPinPick.assetType || "Asset"}` : "Pick Asset"}
        onPick={(guid) => {
          if (assetPinPick) pickAsset(assetPinPick.pinId, guid);
          setAssetPinPick(null);
        }}
        data-testid="inspector-asset-picker"
      />
    </>
  );
}

/** What several selected nodes' details read from the Inspector. */
export interface GraphNodesDetailsProps {
  graph: SerializedGraph;
  inspectGraph: SerializedGraph | null;
  hydratedInspectGraph: SerializedGraph | null;
  /** Two or more nodes, in selection order. */
  selectedNodes: readonly SerializedGraph["nodes"][number][];
  activeFunctionId: string | null;
  catalogs: InspectorCatalogs;
  persistGraph: (next: SerializedGraph) => void;
  classPinPick: ClassPinPick | null;
  setClassPinPick: Dispatch<SetStateAction<ClassPinPick | null>>;
  assetPinPick: AssetPinPick | null;
  setAssetPinPick: Dispatch<SetStateAction<AssetPinPick | null>>;
}

/**
 * Several selected nodes: only the rows every node has, a pin Default by pin
 * id and type and any other row by its section, key and kind, so an Add and
 * a Multiply share A and B. Values that differ show Mixed Values, and an edit
 * changes each node in one graph change (one Undo step). Lists, code and
 * other custom sections stay with a single node.
 */
export function GraphNodesDetails({
  graph,
  inspectGraph,
  hydratedInspectGraph,
  selectedNodes,
  activeFunctionId,
  catalogs,
  persistGraph,
  classPinPick,
  setClassPinPick,
  assetPinPick,
  setAssetPinPick,
}: GraphNodesDetailsProps) {
  const { assetRegistry, registryEpoch } = useRegistryState();
  const { entries: tags } = useTags();
  const clipDocuments = useOpenDocumentsOfKinds(TIMELINE_CLIP_DOCUMENT_KINDS);
  const proxyClips = useMemo(() => {
    void registryEpoch;
    if (!selectedNodes.some((node) => isTimelineProxyPickerNode(node.type))) return new Map<string, undefined>();
    const assets = assetRegistry?.list() ?? [];
    const scripts = timelineScriptAssets(assets, projectTimelineClips(assets, clipDocuments));
    return new Map(selectedNodes.map((node) => [
      node.id,
      isTimelineProxyPickerNode(node.type) ? timelineProxyNodeTarget(scripts, node.data).clip : undefined,
    ]));
  }, [assetRegistry, clipDocuments, registryEpoch, selectedNodes]);
  // While an edit runs, each node's patch applies to this copy; the edit then persists it once.
  const working = useRef<SerializedGraph | null>(null);
  const updateNode = (node: SerializedGraph["nodes"][number]) => (patch: Record<string, unknown>) => {
    const base = working.current ?? graph;
    const next = isDataGraphNode(node.type)
      ? patchDataGraphNode(base, node, patch, activeFunctionId)
      : patchInspectedGraphNode(base, node.id, patch, activeFunctionId);
    if (working.current) working.current = next;
    else persistGraph(next);
  };
  const batch = (apply: () => void) => {
    if (working.current) {
      apply();
      return;
    }
    working.current = graph;
    try {
      apply();
    } catch (error) {
      working.current = null;
      throw error;
    }
    const next = working.current;
    working.current = null;
    if (next !== graph) persistGraph(next);
  };
  const perNode = selectedNodes.map((node) => graphNodeInspectorRows(node, {
    graph,
    inspectGraph,
    hydratedInspectGraph,
    catalogs,
    tags,
    proxyClip: proxyClips.get(node.id),
    updateNodeData: updateNode(node),
    onPickClass: setClassPinPick,
    onPickAsset: setAssetPinPick,
  }));
  const sections = Object.fromEntries(GRAPH_NODE_ROW_SECTIONS.map(({ section }) => [
    section,
    mergePropertyRows(perNode.map((rows) => rows.sections[section]), { batch }),
  ])) as Record<GraphNodeRowSection, PropertyRow[]>;
  const pinKeys = new Map(perNode.flatMap((rows) => [...rows.pinDefaultKeys]));
  const pinDefaultRows = mergePropertyRows(perNode.map((rows) => rows.pinDefaults), {
    key: (row) => pinKeys.get(row) ?? row.id,
    batch,
  });

  return (
    <>
      <div className="flex flex-col gap-3 p-3" data-testid="inspector-multi-node">
        <div className="text-sm font-medium">{`${selectedNodes.length} Nodes`}</div>
        <GraphNodeRowSections sections={sections} />
        {pinDefaultRows.length > 0 ? (
          <div data-testid="inspector-pin-defaults" className="flex flex-col gap-2">
            <PropertyGrid title="Defaults" rows={pinDefaultRows} />
          </div>
        ) : null}
      </div>
      <GraphPinPickers
        node={selectedNodes[0]!}
        catalogs={catalogs}
        classPinPick={classPinPick}
        setClassPinPick={setClassPinPick}
        assetPinPick={assetPinPick}
        setAssetPinPick={setAssetPinPick}
        pickClass={(pinId, classId) => batch(() => perNode.forEach((rows) => rows.pickClass(pinId, classId)))}
        pickAsset={(pinId, guid) => batch(() => perNode.forEach((rows) => rows.pickAsset(pinId, guid)))}
      />
    </>
  );
}

/**
 * What a custom event's signature follows while its Output Delegate is wired:
 * `On Damaged (Enemy)` for a dispatcher's Bind or Unbind, else the title of
 * the node it feeds. Null while unwired.
 */
function customEventSignatureSource(graph: SerializedGraph, eventId: string): string | null {
  const wire = graph.edges.find(
    (edge) => edge.source === eventId && edge.sourceHandle === OUTPUT_DELEGATE_PIN_ID,
  );
  if (!wire) return null;
  const target = graph.nodes.find((node) => node.id === wire.target);
  if (!target) return null;
  if (isDispatcherNodeType(target.type) && typeof target.data.name === "string") {
    return typeof target.data.classId === "string" && target.data.classId
      ? `${target.data.name} (${target.data.classId})`
      : target.data.name;
  }
  return typeof target.data.title === "string" && target.data.title ? target.data.title : target.type;
}
