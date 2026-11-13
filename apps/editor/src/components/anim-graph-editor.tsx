import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  ANIM_STATE_LAYOUT_GAP_X,
  animGraphMembersFromVariables,
  animPaletteNodes,
  animTransitions,
  createDefaultAnimGraph,
  createStateGraph,
  defaultAnimStatePosition,
  defaultAnimVariableValue,
  findReverseTransition,
  findStateMachine,
  hydrateAnimGraphForEditor,
  isPoseStateMachineType,
  normalizeAnimConnection,
  parseAnimGraphDocument,
  patchPosePlayer,
  patchStateGraph,
  patchStateMachine,
  patchTransition,
  primaryPosePlayer,
  primaryStateMachine,
  resolveAnimGraphClips,
  serializedToStateMachine,
  setTransitionBidirectional,
  singlePlayerOf,
  stateMachineToSerialized,
  flipTransitionDirection,
  decorateTransitionRuleGraph,
  persistTransitionRuleGraph,
  validateAnimGraph,
  type AnimClipCatalogEntry,
  type AnimGraphDimension,
  type AnimGraphDocument,
  type AnimState,
  type AnimStateMachine,
  type AnimTransition,
  type AnimVariableTypeId,
} from "@haptic/anim-graph";
import {
  AssetPicker,
  ModuleCard,
  ModuleStage,
  PanelFrame,
  PinTypePicker,
  PropertyGrid,
  ToolbarStrip,
  assetRowIdentity,
  mergePropertyRows,
  type PropertyRow,
} from "@haptic/editor-kit";
import { Badge } from "@haptic/ui/components/badge";
import { Button } from "@haptic/ui/components/button";
import { Input } from "@haptic/ui/components/input";
import { ArrowLeftIcon, ChevronRightIcon, Trash2Icon } from "lucide-react";
import {
  GRAPH_DEFAULT_ZOOM,
  GraphEditor,
  animGraphEdgeTypes,
  animGraphNodeTypes,
} from "@haptic/graph-ui";
import { animStateMachineDebugGraphId, animStateMachineOfDebugGraphId, type BreakpointLocation } from "@haptic/bridge";
import { parseDocumentId, type SerializedGraph } from "@haptic/core";
import { normalizeAnimationPayload, type IndexedAsset } from "@haptic/assets";
import type { Diagnostic } from "@haptic/scripting";
import {
  useActiveDocumentState,
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useAnimGraphEditing, type AnimCanvas, type AnimEditorLocation } from "../context/anim-graph-editing-context";
import { useAppSettings } from "../context/app-settings-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { useAnimStateMachineRunTrace } from "../context/graph-debug-context";
import { commitAnimGraphVariables } from "../lib/anim-graph-variables";
import { GraphPanel } from "../panels/graph-panel";
import { InspectorPanel } from "../panels/inspector-panel";
import { useValidation } from "../context/validation-context";
import { useGraphSessionViewport } from "../lib/graph-session-viewport";
import {
  defaultNodeRegistry,
  hydrateSerializedGraphForEditor,
  ScriptPaletteCache,
  scriptPaletteInjectorKey,
  scriptPaletteNodes,
  validateSerializedGraph,
} from "../services/graph-validation";
import { animClipCatalogFromAssets } from "../lib/anim-clip-catalog";
import { useBreakpointStore } from "../context/breakpoints-context";
import { useBreakpointSettingsEditor } from "../lib/use-breakpoint-settings-editor";
import { stateMachineBreakpointView } from "../lib/state-machine-breakpoints";
import type { BreakpointEntry, BreakpointStore } from "../services/breakpoint-store";
import { IconActionButton } from "./icon-action-button";
import { variableDefaultPropertyRows } from "../lib/graph-inspector";
import { useDataCatalog } from "../lib/use-data-catalog";
import { useOpenDocumentsOfKinds } from "../lib/use-open-documents-of-kinds";
import { applyDataGraphAssetPicks, collectDataGraphAssets } from "../lib/data-graph";
import { documentBatch } from "../lib/document-batch";

const DATA_TREE_KINDS = ["data-tree"] as const;
const NO_TRANSITIONS: readonly AnimTransition[] = [];

const VARIABLE_TYPES = [
  "bool",
  "int",
  "float",
  "string",
  "tag",
  "tagContainer",
] as const;

function asAnimGraph(
  payload: Record<string, unknown>,
  catalog: Parameters<typeof resolveAnimGraphClips>[1] = [],
  dimension: AnimGraphDimension = "3d",
): AnimGraphDocument {
  return resolveAnimGraphClips(
    parseAnimGraphDocument(payload) ?? createDefaultAnimGraph("Locomotion", { dimension }),
    catalog,
  );
}

function nextAnimStatePosition(
  states: readonly Pick<AnimState, "position">[],
): { x: number; y: number } {
  if (states.length === 0) return defaultAnimStatePosition(0);
  const maxX = Math.max(...states.map((state) => state.position.x));
  const y = states[states.length - 1]?.position.y ?? defaultAnimStatePosition(0).y;
  return { x: maxX + ANIM_STATE_LAYOUT_GAP_X, y };
}

function uniqueStateId(machine: AnimStateMachine): string {
  const ids = new Set(machine.states.map((state) => state.id));
  let index = 1;
  while (ids.has(`state-${index}`)) index += 1;
  return `state-${index}`;
}

function uniqueStateName(machine: AnimStateMachine, base = "State"): string {
  const names = new Set(machine.states.map((state) => state.name.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  let index = 2;
  while (names.has(`${base} ${index}`.toLowerCase())) index += 1;
  return `${base} ${index}`;
}

function uniqueVariableId(doc: AnimGraphDocument): string {
  const ids = new Set(doc.variables.map((variable) => variable.id));
  let index = 1;
  while (ids.has(`var-${index}`)) index += 1;
  return `var-${index}`;
}

function uniqueVariableName(doc: AnimGraphDocument, base = "Variable"): string {
  const names = new Set(doc.variables.map((variable) => variable.name));
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function addAnimState(doc: AnimGraphDocument, machineId: string, dimension: AnimGraphDimension): AnimGraphDocument {
  return patchStateMachine(doc, machineId, (machine) => ({
    ...machine,
    states: [
      ...machine.states,
      {
        id: uniqueStateId(machine),
        name: uniqueStateName(machine),
        position: nextAnimStatePosition(machine.states),
        stateGraph: createStateGraph(dimension),
      },
    ],
  }));
}

function patchState(
  doc: AnimGraphDocument,
  machineId: string,
  stateId: string,
  patch: Partial<AnimState>,
): AnimGraphDocument {
  return patchStateMachine(doc, machineId, (machine) => ({
    ...machine,
    states: machine.states.map((state) =>
      state.id === stateId ? { ...state, ...patch } : state,
    ),
  }));
}

/** What a state plays, for its card: its single player's clip, else "State Graph". */
function stateClipLabel(
  state: AnimState,
  catalog: readonly AnimClipCatalogEntry[],
): string {
  const player = singlePlayerOf(state.stateGraph);
  if (!player) return primaryPosePlayer(state.stateGraph) ? "State Graph" : "No Clip";
  const assetGuid = typeof player.data.assetGuid === "string" ? player.data.assetGuid : "";
  if (!assetGuid) return "No Clip";
  return catalog.find((row) => row.guid === assetGuid)?.name ?? "Missing Clip";
}

function transitionLabel(machine: AnimStateMachine, transition: AnimTransition): string {
  const from =
    machine.states.find((state) => state.id === transition.fromStateId)?.name ??
    transition.fromStateId;
  const to =
    machine.states.find((state) => state.id === transition.toStateId)?.name ??
    transition.toStateId;
  return `${from} To ${to}`;
}

/** Asset types a state clip, its label or its skeleton check (an Animation's Model) can name. */
const CLIP_CATALOG_TYPES: ReadonlySet<string> = new Set([
  "Animation",
  "Model",
  "SpriteAnimation",
]);

function useAnimGraphDocument() {
  const { documentId } = useDocumentWorkspace();
  const { applyAssetDocumentChange, getOpenDocuments } = useDocumentActions();
  const { assetRegistry, registryEpoch } = useRegistryState();
  const entry = useOpenDocument(documentId);
  const catalog = useMemo(() => {
    void registryEpoch; // Registry contents change without replacing its instance.
    return animClipCatalogFromAssets(
      (assetRegistry?.list() ?? []).filter((asset) =>
        CLIP_CATALOG_TYPES.has(asset.header.type),
      ),
    );
  }, [assetRegistry, registryEpoch]);
  // A 3D graph plays Animations on its Skeleton; a 2D graph plays Sprite Animations.
  const dimension: AnimGraphDimension = entry?.ref.kind === "anim-graph-2d" ? "2d" : "3d";
  const doc = useMemo(
    () =>
      asAnimGraph((entry?.content ?? {}) as Record<string, unknown>, catalog, dimension),
    [entry?.content, catalog, dimension],
  );
  /**
   * The stored document now. GraphEditor reports edits while it renders, so
   * the graph commits a microtask later; it builds on this, not on `doc`.
   */
  const latestDoc = () => {
    const content = getOpenDocuments().find((open) => open.id === documentId)?.content;
    return content ? asAnimGraph(content as Record<string, unknown>, catalog, dimension) : doc;
  };
  /** `mergeKey` groups one scrub's edits into one undo entry. */
  const commit = (next: AnimGraphDocument, mergeKey?: string) => {
    void applyAssetDocumentChange(
      documentId,
      next as unknown as Record<string, unknown>,
      mergeKey,
    );
  };
  // The graph's guid names it to the running game; a Simulation's live State Machine is reported under it.
  const documentPath = entry?.ref.path;
  const graphHeader = useMemo(() => {
    void registryEpoch;
    return documentPath ? assetRegistry?.getByPath(documentPath)?.header : undefined;
  }, [assetRegistry, registryEpoch, documentPath]);
  const graphGuid = graphHeader?.guid;
  const assetName = graphHeader?.name ?? doc.name;
  // The graph on show: the editor opens on the primary State Machine, and a location whose graph is gone falls back.
  const editing = useAnimGraphEditing();
  const location = resolveAnimEditorLocation(doc, editing.location);
  const machine = location.kind === "anim" ? undefined : findStateMachine(doc, location.machineId);
  const state = location.kind === "state" ? machine?.states.find((row) => row.id === location.stateId) : undefined;
  return { doc, latestDoc, commit, assetRegistry, documentId, catalog, graphGuid, assetName, dimension, location, machine, state };
}

/** The location shown: the one asked for while its graph exists, else the primary State Machine, else the Anim Graph. */
function resolveAnimEditorLocation(doc: AnimGraphDocument, location: AnimEditorLocation | null): AnimEditorLocation {
  if (location?.kind === "anim") return location;
  const machine = location ? findStateMachine(doc, location.machineId) : undefined;
  if (location?.kind === "machine" && machine) return location;
  if (location?.kind === "state" && machine?.states.some((row) => row.id === location.stateId)) return location;
  if (location?.kind === "state" && machine) return { kind: "machine", machineId: machine.id };
  const primary = primaryStateMachine(doc);
  return primary ? { kind: "machine", machineId: primary.id } : { kind: "anim" };
}

/** A state's or transition's breakpoint, named as its State Machine shows it. */
function stateMachineBreakpointLabel(
  doc: AnimGraphDocument,
  machineId: string,
  id: string,
  assetName: string,
): BreakpointEntry["label"] {
  const machine = findStateMachine(doc, machineId);
  const state = machine?.states.find((row) => row.id === id);
  const transition = state ? undefined : machine?.transitions.find((row) => row.id === id);
  return {
    className: assetName,
    graphName: machine?.name ?? "State Machine",
    nodeTitle: state?.name ?? (transition && machine ? transitionLabel(machine, transition) : id),
  };
}

/**
 * Adds or removes the breakpoint of one direction of a transition, and edits its hit count once set; the
 * Breakpoints window disables it.
 */
function TransitionBreakpointButton({
  store,
  location,
  label,
  reverse,
}: {
  store: BreakpointStore;
  location: BreakpointLocation;
  label: () => BreakpointEntry["label"];
  reverse: boolean;
}) {
  const set = useSyncExternalStore(store.subscribe, () => store.get(location) !== undefined);
  const { edit, dialog } = useBreakpointSettingsEditor(store);
  const which = reverse ? " Reverse" : "";
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid={`anim-graph-breakpoint-${location.nodeId}`}
        aria-pressed={set}
        onClick={() => (set ? store.remove(location) : store.toggle(location, label()))}
      >
        {`${set ? "Remove" : "Add"}${which} Breakpoint`}
      </Button>
      {set ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={`anim-graph-edit-breakpoint-${location.nodeId}`}
          onClick={() => edit({ location, nodeTitle: label().nodeTitle, pins: null })}
        >
          {`Edit${which} Breakpoint…`}
        </Button>
      ) : null}
      {dialog}
    </>
  );
}

function AnimGraphVariablesList() {
  const { doc, commit, machine, dimension, location } = useAnimGraphDocument();
  const { selectedIds, setSelectedId, navigate } = useAnimGraphEditing();
  return (
    <PanelFrame>
      <div className="flex flex-col gap-3 p-2">
        <div className="flex flex-col gap-1" data-testid="anim-graph-parameters">
          <div className="flex items-center justify-between gap-1 px-1">
            <div className="text-sm font-medium">Variables</div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="anim-graph-add-variable"
              onClick={() => {
                const typeId: AnimVariableTypeId = "bool";
                commit(
                  commitAnimGraphVariables(doc, [
                    ...doc.variables,
                    {
                      id: uniqueVariableId(doc),
                      name: uniqueVariableName(doc),
                      typeId,
                      defaultValue: defaultAnimVariableValue(typeId),
                    },
                  ]),
                );
              }}
            >
              Add Variable
            </Button>
          </div>
          {doc.variables.map((variable) => (
            <div
              key={variable.id}
              className="flex flex-col gap-1 px-1"
              data-testid={`anim-graph-variable-${variable.id}`}
            >
              <div className="flex min-h-[var(--chrome-row,28px)] items-center gap-1">
                <Input
                  className="h-7 min-h-7 min-w-0 flex-1"
                  value={variable.name}
                  aria-label="Variable Name"
                  data-testid={`anim-graph-variable-name-${variable.id}`}
                  onChange={(event) =>
                    commit(
                      commitAnimGraphVariables(
                        doc,
                        doc.variables.map((row) =>
                          row.id === variable.id
                            ? { ...row, name: event.target.value }
                            : row,
                        ),
                      ),
                    )
                  }
                />
                <PinTypePicker
                  value={variable.typeId === "struct" && variable.typeClassId === "engine:TagContainer" ? "tagContainer" : variable.typeId}
                  types={VARIABLE_TYPES}
                  data-testid={`anim-graph-variable-type-${variable.id}`}
                  onChange={(value) => {
                    const typeId: AnimVariableTypeId = value === "tagContainer" ? "struct" : value as AnimVariableTypeId;
                    const typeClassId = value === "tagContainer" ? "engine:TagContainer" : undefined;
                    commit(
                      commitAnimGraphVariables(
                        doc,
                        doc.variables.map((row) =>
                          row.id === variable.id
                            ? {
                                ...row,
                                typeId,
                                typeClassId,
                                defaultValue: defaultAnimVariableValue(typeId, typeClassId),
                              }
                            : row,
                        ),
                      ),
                    );
                  }}
                />
                <IconActionButton
                  label="Remove Variable"
                  variant="ghost"
                  data-testid={`anim-graph-variable-remove-${variable.id}`}
                  onClick={() =>
                    commit(
                      commitAnimGraphVariables(
                        doc,
                        doc.variables.filter((row) => row.id !== variable.id),
                      ),
                    )
                  }
                >
                  <Trash2Icon />
                </IconActionButton>
              </div>
              {variable.typeId === "tag" || (variable.typeId === "struct" && variable.typeClassId === "engine:TagContainer") ? (
                <PropertyGrid
                  rows={variableDefaultPropertyRows(variable.typeId, variable.defaultValue, (defaultValue) => {
                    commit(commitAnimGraphVariables(doc, doc.variables.map((row) =>
                      row.id === variable.id ? { ...row, defaultValue } : row)));
                  }, { typeClassId: variable.typeClassId, pinId: variable.id })}
                  data-testid={`anim-graph-variable-default-${variable.id}`}
                />
              ) : null}
            </div>
          ))}
        </div>
        {machine ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-1 px-1">
              <div className="text-sm font-medium">States</div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="anim-graph-add-state"
                onClick={() => commit(addAnimState(doc, machine.id, dimension))}
              >
                Add State
              </Button>
            </div>
            {machine.states.map((state) => (
              <Button
                key={state.id}
                type="button"
                variant={selectedIds.includes(state.id) ? "secondary" : "ghost"}
                size="sm"
                className="w-full justify-between gap-2"
                aria-pressed={selectedIds.includes(state.id)}
                data-testid={`anim-graph-state-${state.id}`}
                onClick={() => {
                  // A state picked while its State Machine is not on show opens it first.
                  if (location.kind !== "machine") navigate({ kind: "machine", machineId: machine.id });
                  setSelectedId(state.id);
                }}
              >
                <span className="min-w-0 truncate">{state.name}</span>
                {machine.entryStateId === state.id ? (
                  <Badge variant="outline" className="shrink-0">
                    Entry
                  </Badge>
                ) : null}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </PanelFrame>
  );
}

export function AnimGraphVariablesPanel(_props: IDockviewPanelProps) {
  void _props;
  return <AnimGraphVariablesList />;
}

/**
 * Makes a canvas panel the one the Inspector follows when DockView brings it forward or the user presses in it. The
 * two canvases share the node selection, so changing canvas clears it.
 */
function useAnimCanvas(canvas: AnimCanvas, api: IDockviewPanelProps["api"] | undefined): () => void {
  const { canvas: active, setCanvas } = useAnimGraphEditing();
  const { setSelectedNodeIds } = useGraphEditing();
  const claim = useCallback(() => {
    if (active === canvas) return;
    setSelectedNodeIds([]);
    setCanvas(canvas);
  }, [active, canvas, setCanvas, setSelectedNodeIds]);
  useEffect(() => {
    if (!api) return;
    if (api.isActive) claim();
    const subscription = api.onDidActiveChange((event) => {
      if (event.isActive) claim();
    });
    return () => subscription.dispose();
  }, [api, claim]);
  return claim;
}

/**
 * The Animation Object script: the Class-style graph each Animation Graph component runs, beside the Graph. Behind
 * another tab its canvas would fit a view with no size, so the graph mounts the first time the window shows; a node of
 * the script chosen elsewhere (Compiler Results, a breakpoint) brings the window forward, where the graph frames it.
 */
export function AnimObjectGraphPanel(props: IDockviewPanelProps) {
  const { api } = props;
  const claim = useAnimCanvas("animationObject", api);
  const { doc } = useAnimGraphDocument();
  const { focusDiagnostic } = useValidation();
  const [shown, setShown] = useState(() => api.isVisible);
  useEffect(() => {
    if (shown) return;
    if (api.isVisible) {
      setShown(true);
      return;
    }
    const subscription = api.onDidVisibilityChange((event) => {
      if (event.isVisible) setShown(true);
    });
    return () => subscription.dispose();
  }, [api, shown]);
  const focusNodeId = focusDiagnostic?.nodeId;
  const holdsFocus = !!focusNodeId && doc.animationObject.nodes.some((node) => node.id === focusNodeId);
  useEffect(() => {
    if (holdsFocus && !api.isVisible) api.setActive();
  }, [api, holdsFocus, focusDiagnostic]);
  return (
    <div className="flex h-full min-h-0 flex-col" onPointerDownCapture={claim} data-testid="anim-object-graph">
      {shown ? <GraphPanel {...props} /> : null}
    </div>
  );
}

export function AnimGraphGraphPanel(props: IDockviewPanelProps) {
  const claimCanvas = useAnimCanvas("stateMachine", props.api);
  const { doc, latestDoc, commit, documentId, catalog, graphGuid, assetName, dimension, location, machine, state } = useAnimGraphDocument();
  // While a Simulation debugs this graph, the State Machine shows the states the followed instance samples and its transitions.
  const machineId = location.kind === "machine" ? location.machineId : undefined;
  const runTrace = useAnimStateMachineRunTrace(graphGuid, machineId);
  const {
    selectedId,
    selectedIds,
    setSelectedIds,
    selectedTransitionId,
    setSelectedTransitionId,
    focusedNodeId,
    openTransitionId,
    closeTransitionRule,
    navigate,
  } = useAnimGraphEditing();
  const { setSelectedNodeIds } = useGraphEditing();
  const { activeDocumentId } = useActiveDocumentState();
  const typeCatalog = useDataCatalog();
  const sheetDocuments = useOpenDocumentsOfKinds(DATA_TREE_KINDS);
  const dataAssets = useMemo(() => collectDataGraphAssets(typeCatalog.assets, sheetDocuments), [typeCatalog.assets, sheetDocuments]);
  const pinTypeNames = useMemo(() => Object.fromEntries([
    ...Object.entries(typeCatalog.schemas.structs),
    ...Object.entries(typeCatalog.schemas.enums),
  ].map(([guid, schema]) => [guid, schema.name])), [typeCatalog.schemas]);
  const poseKey = location.kind === "state" ? `state:${location.machineId}/${location.stateId}` : location.kind === "anim" ? "anim" : `machine:${location.machineId}`;
  const ruleSurface = openTransitionId ? `rule:${openTransitionId}` : poseKey;
  const { sessionViewport, onSessionViewportChange } = useGraphSessionViewport(
    documentId,
    ruleSurface,
  );
  const { setDiagnostics, diagnostics, focusDiagnostic } = useValidation();
  // Breakpoints use the session's terms: the graph's guid and the State Machine's debug graph id.
  const breakpointStore = useBreakpointStore();
  const latestDocRef = useRef(latestDoc);
  latestDocRef.current = latestDoc;
  const breakpointLabel = useCallback(
    (id: string) => stateMachineBreakpointLabel(latestDocRef.current(), machineId ?? "", id, assetName),
    [assetName, machineId],
  );
  const { edit: editBreakpoint, dialog: breakpointSettingsDialog } = useBreakpointSettingsEditor(breakpointStore);
  // The canvas's node menu and keys act on the selected states' breakpoints; Edit opens the hit count.
  const breakpoints = useMemo(
    () => breakpointStore && graphGuid && machineId
      ? stateMachineBreakpointView(breakpointStore, graphGuid, machineId, breakpointLabel, () => latestDocRef.current(), (nodeId) =>
        editBreakpoint({
          location: { assetGuid: graphGuid, graphId: animStateMachineDebugGraphId(machineId), nodeId },
          nodeTitle: breakpointLabel(nodeId).nodeTitle,
          pins: null,
        }))
      : undefined,
    [breakpointLabel, breakpointStore, editBreakpoint, graphGuid, machineId],
  );
  // A stop in a State Machine (from a breakpoint or the Breakpoints window) opens that State Machine, and a stop at
  // a transition selects it, so Details show it.
  const focusMachineId = focusDiagnostic?.assetGuid === graphGuid ? animStateMachineOfDebugGraphId(focusDiagnostic?.graphId) : null;
  const focusTransition = focusMachineId
    ? findStateMachine(doc, focusMachineId)?.transitions.find((row) => row.id === focusDiagnostic?.nodeId)
    : undefined;
  const focusTransitionId = focusTransition?.id;
  const panelApi = props.api;
  useEffect(() => {
    if (!focusMachineId || !findStateMachine(latestDocRef.current(), focusMachineId)) return;
    navigate({ kind: "machine", machineId: focusMachineId });
    // Behind the Animation Object tab, the Graph comes forward.
    if (panelApi && !panelApi.isVisible) panelApi.setActive();
  }, [focusMachineId, navigate, panelApi]);
  useEffect(() => {
    if (focusTransitionId) setSelectedTransitionId(focusTransitionId);
  }, [focusTransitionId, setSelectedTransitionId]);
  const { settings: appSettings } = useAppSettings();
  const defaultZoom = appSettings.graphDefaultZoom ?? GRAPH_DEFAULT_ZOOM;
  const [rulePaletteOpen, setRulePaletteOpen] = useState(false);
  const rulePaletteCacheRef = useRef(new ScriptPaletteCache());
  // This canvas's own rows; the Animation Object panel shows its script's.
  const graphDiagnostics = useMemo(
    () =>
      diagnostics.filter((row) => row.graphId.startsWith(`${documentId}:`)).map((row) => ({
        nodeId: row.nodeId,
        pinId: row.pinId,
        severity: row.severity,
        message: row.message,
      })),
    [diagnostics, documentId],
  );
  const openEntry = openTransitionId
    ? animTransitions(doc).find(({ transition }) => transition.id === openTransitionId) ?? null
    : null;
  const openTransition = openEntry?.transition ?? null;
  const machineTransitions = machine?.transitions ?? NO_TRANSITIONS;
  const initialGraph = useMemo(() => {
    if (!machine) return { nodes: [], edges: [] };
    const graph = hydrateAnimGraphForEditor(stateMachineToSerialized(machine));
    const clipLabels = new Map(
      machine.states.map((row) => [row.id, stateClipLabel(row, catalog)]),
    );
    return {
      ...graph,
      nodes: graph.nodes.map((node) => ({
        ...node,
        data: { ...node.data, clipLabel: clipLabels.get(node.id) },
      })),
    };
  }, [machine, catalog]);
  // The wire of the transition the Inspector shows: a Both Ways pair is one wire under its first row's id.
  const selectedEdgeId = useMemo(() => {
    if (!selectedTransitionId) return undefined;
    const drawn = new Set(initialGraph.edges.map((edge) => edge.id));
    if (drawn.has(selectedTransitionId)) return selectedTransitionId;
    const row = machineTransitions.find((transition) => transition.id === selectedTransitionId);
    const reverse = row && findReverseTransition(machineTransitions, row.fromStateId, row.toStateId);
    return reverse && drawn.has(reverse.id) ? reverse.id : undefined;
  }, [machineTransitions, initialGraph.edges, selectedTransitionId]);
  const ruleMembers = useMemo(
    () => animGraphMembersFromVariables(doc.variables),
    [doc.variables],
  );
  const ruleGraph = useMemo(() => {
    if (!openTransition || !openEntry) return null;
    const oneWay = !findReverseTransition(
      openEntry.machine.transitions,
      openTransition.fromStateId,
      openTransition.toStateId,
    );
    return hydrateSerializedGraphForEditor(
      {
        ...decorateTransitionRuleGraph(openTransition.ruleGraph, oneWay),
        members: ruleMembers,
      },
      defaultNodeRegistry(),
      { ...typeCatalog.schemas, dataAssets },
    );
  }, [openEntry, openTransition, ruleMembers, typeCatalog.schemas, dataAssets]);
  // The pose graph on show: the Anim Graph or a state's graph. State Machine nodes show their machine's name.
  const poseSource = location.kind === "anim" ? doc.animGraph : location.kind === "state" ? state?.stateGraph ?? null : null;
  const poseGraph = useMemo(() => {
    if (!poseSource) return null;
    const named = {
      ...poseSource,
      nodes: poseSource.nodes.map((node) => {
        if (!isPoseStateMachineType(node.type)) return node;
        const name = typeof node.data.machineId === "string" ? findStateMachine(doc, node.data.machineId)?.name : undefined;
        return name ? { ...node, data: { ...node.data, title: name } } : node;
      }),
      members: ruleMembers,
    };
    return hydrateSerializedGraphForEditor(named, defaultNodeRegistry(), { ...typeCatalog.schemas, dataAssets });
  }, [poseSource, doc, ruleMembers, typeCatalog.schemas, dataAssets]);
  const posePaletteInput = {
    parentClass: "Object",
    animationGraphHost: "pose" as const,
    animPose: { dimension, level: location.kind === "state" ? "state" as const : "anim" as const },
    graph: { nodes: [], edges: [], members: ruleMembers },
    structures: typeCatalog.types.structures,
    dataDefinitions: typeCatalog.types.dataDefinitions,
    enums: typeCatalog.types.enums,
  };
  const posePaletteInputRef = useRef(posePaletteInput);
  posePaletteInputRef.current = posePaletteInput;
  const posePaletteKey = scriptPaletteInjectorKey(posePaletteInput);
  const [posePaletteOpen, setPosePaletteOpen] = useState(false);
  const posePaletteCacheRef = useRef(new ScriptPaletteCache());
  const posePalette = useMemo(
    () =>
      scriptPaletteNodes(defaultNodeRegistry(), posePaletteInputRef.current, {
        injectors: posePaletteOpen,
        cache: posePaletteCacheRef.current,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key covers the input
    [posePaletteKey, posePaletteOpen],
  );
  const rulePaletteInput = {
    parentClass: "Object",
    animationGraphHost: "rule" as const,
    graph: { nodes: [], edges: [], members: ruleMembers },
    structures: typeCatalog.types.structures,
    dataDefinitions: typeCatalog.types.dataDefinitions,
    enums: typeCatalog.types.enums,
  };
  const rulePaletteInputRef = useRef(rulePaletteInput);
  rulePaletteInputRef.current = rulePaletteInput;
  const rulePaletteKey = scriptPaletteInjectorKey(rulePaletteInput);
  const rulePalette = useMemo(
    () =>
      scriptPaletteNodes(defaultNodeRegistry(), rulePaletteInputRef.current, {
        injectors: rulePaletteOpen,
        cache: rulePaletteCacheRef.current,
      }),
    [rulePaletteKey, rulePaletteOpen],
  );

  useEffect(() => {
    if (activeDocumentId !== documentId) return;
    const animRows: Diagnostic[] = validateAnimGraph(doc, catalog, { dimension }).map((row) => ({
      severity: row.severity,
      code: row.code,
      message: row.message,
      assetGuid: documentId,
      graphId: `${documentId}:anim`,
      nodeId: row.nodeId,
    }));
    const ruleRows =
      openTransition && ruleGraph
        ? validateSerializedGraph(ruleGraph, {
            ...typeCatalog.schemas,
            dataAssets,
            assetGuid: documentId,
            graphId: `${documentId}:${openTransition.id}`,
            members: ruleMembers.map((member) => ({
              id: member.id,
              name: member.name,
              kind: "variable" as const,
              classId: "AnimGraph",
              typeId: member.typeId ?? "bool",
              typeClassId: member.typeClassId,
            })),
          })
        : [];
    const poseRows = !openTransition && poseGraph
      ? validateSerializedGraph(poseGraph, {
          ...typeCatalog.schemas,
          dataAssets,
          assetGuid: documentId,
          graphId: `${documentId}:pose-${poseKey}`,
          members: ruleMembers.map((member) => ({
            id: member.id,
            name: member.name,
            kind: "variable" as const,
            classId: "AnimGraph",
            typeId: member.typeId ?? "bool",
            typeClassId: member.typeClassId,
          })),
        })
      : [];
    // This canvas's rows (its graphs and open rule) and this asset's Play and Compile rows. The Animation Object
    // panel publishes its script's rows under the document's own graph id, which stay.
    const path = parseDocumentId(documentId)?.path;
    setDiagnostics([...animRows, ...ruleRows, ...poseRows], {
      replaces: (d) =>
        d.graphId.startsWith(`${documentId}:`) ||
        ((d.assetGuid === documentId || d.assetGuid === path) && d.graphId !== documentId),
    });
  }, [
    activeDocumentId,
    doc,
    documentId,
    catalog,
    dimension,
    openTransition,
    ruleGraph,
    poseGraph,
    poseKey,
    ruleMembers,
    typeCatalog.schemas,
    dataAssets,
    setDiagnostics,
  ]);

  if (openTransition && ruleGraph) {
    return (
      <PanelFrame className="flex-1">
        <div className="flex h-full min-h-0 flex-col" data-testid="anim-rule-graph" onPointerDownCapture={claimCanvas}>
          <ToolbarStrip>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="anim-rule-back"
              onClick={() => {
                setSelectedNodeIds([]);
                closeTransitionRule();
              }}
            >
              <ArrowLeftIcon data-icon="inline-start" aria-hidden />
              Back To State Machine
            </Button>
            <span
              className="min-w-0 truncate px-1 text-sm font-medium"
              data-testid="anim-rule-title"
            >
              {openEntry ? transitionLabel(openEntry.machine, openTransition) : openTransition.id}
            </span>
          </ToolbarStrip>
          <GraphEditor
            key={openTransition.id}
            initialGraph={ruleGraph}
            commitPositionsOnDragEnd
            paletteNodes={rulePalette}
            pinTypeNames={pinTypeNames}
            onPaletteOpenChange={setRulePaletteOpen}
            diagnostics={graphDiagnostics}
            defaultZoom={defaultZoom}
            sessionViewport={sessionViewport}
            onSessionViewportChange={onSessionViewportChange}
            onSelectionChange={setSelectedNodeIds}
            onChange={(next) => {
              const nextRule = applyDataGraphAssetPicks(ruleGraph, { nodes: next.nodes, edges: next.edges }, dataAssets);
              const transitionId = openTransition.id;
              queueMicrotask(() => {
                commit(
                  patchTransition(latestDoc(), transitionId, {
                    ruleGraph: persistTransitionRuleGraph(nextRule),
                  }),
                );
              });
            }}
          />
        </div>
      </PanelFrame>
    );
  }

  const crumbs = (
    <AnimGraphBreadcrumbs
      doc={doc}
      location={location}
      onNavigate={(next) => {
        setSelectedNodeIds([]);
        navigate(next);
      }}
    />
  );

  if (location.kind !== "machine" || !machine) {
    const stateLocation = location.kind === "state" ? location : null;
    return (
      <PanelFrame className="flex-1">
        <div className="flex h-full min-h-0 flex-col" data-testid="anim-pose-graph" data-pose-level={stateLocation ? "state" : "anim"} onPointerDownCapture={claimCanvas}>
          {crumbs}
          {poseGraph ? (
            <GraphEditor
              key={poseKey}
              initialGraph={poseGraph}
              commitPositionsOnDragEnd
              paletteNodes={posePalette}
              pinTypeNames={pinTypeNames}
              onPaletteOpenChange={setPosePaletteOpen}
              diagnostics={graphDiagnostics}
              defaultZoom={defaultZoom}
              sessionViewport={sessionViewport}
              onSessionViewportChange={onSessionViewportChange}
              onSelectionChange={setSelectedNodeIds}
              onNodeDoubleClick={(nodeId) => {
                // Double-tap a State Machine node to open it.
                const node = poseGraph.nodes.find((row) => row.id === nodeId);
                const machineId = node && isPoseStateMachineType(node.type) ? node.data.machineId : undefined;
                if (typeof machineId === "string" && findStateMachine(latestDoc(), machineId)) {
                  setSelectedNodeIds([]);
                  navigate({ kind: "machine", machineId });
                }
              }}
              onChange={(next) => {
                const graph = applyDataGraphAssetPicks(poseGraph, { nodes: next.nodes, edges: next.edges }, dataAssets);
                queueMicrotask(() => {
                  const current = latestDoc();
                  commit(stateLocation
                    ? patchStateGraph(current, stateLocation.machineId, stateLocation.stateId, persistPoseGraph(graph))
                    : withAnimGraphMachines(current, persistPoseGraph(graph), dimension));
                });
              }}
            />
          ) : null}
        </div>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame className="flex-1">
      <div className="anim-graph-canvas flex h-full min-h-0 flex-col" data-testid="anim-graph-editor" onPointerDownCapture={claimCanvas}>
        {crumbs}
        <GraphEditor
          key={machine.id}
          initialGraph={initialGraph}
          runTrace={runTrace}
          breakpoints={breakpoints}
          commitPositionsOnDragEnd
          paletteNodes={animPaletteNodes()}
          nodeTypes={animGraphNodeTypes}
          edgeTypes={animGraphEdgeTypes}
          defaultZoom={defaultZoom}
          sessionViewport={sessionViewport}
          onSessionViewportChange={onSessionViewportChange}
          defaultEdgeOptions={{
            type: "animTransition",
          }}
          diagnostics={graphDiagnostics}
          selectedNodeId={selectedId ?? undefined}
          selectedEdgeId={selectedEdgeId}
          focusedNodeId={focusTransition?.fromStateId ?? focusDiagnostic?.nodeId ?? focusedNodeId ?? undefined}
          connectEndMode="zone-add-node"
          connectionMode="loose"
          uniqueDirectedPairOnConnect
          normalizeConnection={(connection) => {
            const next = normalizeAnimConnection(connection);
            if (!next) return null;
            return { ...connection, ...next };
          }}
          onSelectionChange={(nodeIds) => {
            queueMicrotask(() => setSelectedIds(nodeIds));
          }}
          onEdgeSelectionChange={(edgeIds) => {
            queueMicrotask(() => setSelectedTransitionId(edgeIds[0] ?? null));
          }}
          onNodeDoubleClick={(stateId) => {
            // Double-tap a state to open its state graph.
            if (!machine.states.some((row) => row.id === stateId)) return;
            setSelectedNodeIds([]);
            navigate({ kind: "state", machineId: machine.id, stateId });
          }}
          onChange={(next) => {
            const keepSelection = selectedIds;
            const machineId = machine.id;
            queueMicrotask(() => {
              const current = latestDoc();
              const previous = findStateMachine(current, machineId);
              if (!previous) return;
              const updated = serializedToStateMachine(next, previous, dimension);
              const kept = keepSelection.filter((id) =>
                updated.states.some((row) => row.id === id),
              );
              if (kept.length !== keepSelection.length) setSelectedIds(kept);
              commit(patchStateMachine(current, machineId, () => updated));
            });
          }}
        />
      </div>
      {breakpointSettingsDialog}
    </PanelFrame>
  );
}

/** A pose graph as stored: its nodes and wires, without the editor's member list. */
function persistPoseGraph(graph: SerializedGraph): SerializedGraph {
  return { nodes: graph.nodes, edges: graph.edges };
}

function uniqueMachineId(doc: AnimGraphDocument): string {
  const ids = new Set(doc.stateMachines.map((machine) => machine.id));
  let index = 1;
  while (ids.has(`machine-${index}`)) index += 1;
  return `machine-${index}`;
}

function uniqueMachineName(doc: AnimGraphDocument): string {
  const names = new Set(doc.stateMachines.map((machine) => machine.name.trim().toLowerCase()));
  let index = 1;
  while (names.has(`state machine ${index}`)) index += 1;
  return `State Machine ${index}`;
}

/**
 * The Anim Graph after an edit: a State Machine node new to it (added or pasted without a machine) gets a new State
 * Machine with an Idle state, and a State Machine whose node was deleted goes with it.
 */
function withAnimGraphMachines(doc: AnimGraphDocument, animGraph: SerializedGraph, dimension: AnimGraphDimension): AnimGraphDocument {
  let next: AnimGraphDocument = { ...doc, animGraph };
  const claimed = new Set<string>();
  const nodes = animGraph.nodes.map((node) => {
    if (!isPoseStateMachineType(node.type)) return node;
    const machineId = typeof node.data.machineId === "string" ? node.data.machineId : "";
    if (machineId && findStateMachine(next, machineId) && !claimed.has(machineId)) {
      claimed.add(machineId);
      return node;
    }
    const id = uniqueMachineId(next);
    claimed.add(id);
    next = {
      ...next,
      stateMachines: [...next.stateMachines, {
        id,
        name: uniqueMachineName(next),
        entryStateId: "idle",
        states: [{ id: "idle", name: "Idle", position: defaultAnimStatePosition(0), stateGraph: createStateGraph(dimension) }],
        transitions: [],
      }],
    };
    return { ...node, data: { ...node.data, machineId: id } };
  });
  return {
    ...next,
    animGraph: { ...animGraph, nodes },
    stateMachines: next.stateMachines.filter((machine) => claimed.has(machine.id)),
  };
}

/** Anim Graph › Locomotion › Walk / Run, with Back stepping out one level. */
function AnimGraphBreadcrumbs({
  doc,
  location,
  onNavigate,
}: {
  doc: AnimGraphDocument;
  location: AnimEditorLocation;
  onNavigate: (location: AnimEditorLocation) => void;
}) {
  const machine = location.kind === "anim" ? undefined : findStateMachine(doc, location.machineId);
  const state = location.kind === "state" ? machine?.states.find((row) => row.id === location.stateId) : undefined;
  const crumbs: Array<{ id: string; label: string; to: AnimEditorLocation }> = [
    { id: "anim", label: "Anim Graph", to: { kind: "anim" } },
    ...(machine ? [{ id: "machine", label: machine.name, to: { kind: "machine" as const, machineId: machine.id } }] : []),
    ...(machine && state ? [{ id: "state", label: state.name, to: { kind: "state" as const, machineId: machine.id, stateId: state.id } }] : []),
  ];
  const back = crumbs.length > 1 ? crumbs[crumbs.length - 2]!.to : null;
  return (
    <ToolbarStrip data-testid="anim-graph-breadcrumbs">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!back}
        data-testid="anim-graph-back"
        onClick={() => back && onNavigate(back)}
      >
        <ArrowLeftIcon data-icon="inline-start" aria-hidden />
        Back
      </Button>
      <nav aria-label="Graph" className="flex min-w-0 items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => (
          <span key={crumb.id} className="flex min-w-0 items-center gap-1">
            {index > 0 ? <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : null}
            {index === crumbs.length - 1 ? (
              <span className="truncate font-medium" aria-current="page" data-testid={`anim-graph-crumb-${crumb.id}`}>{crumb.label}</span>
            ) : (
              <button
                type="button"
                className="truncate text-muted-foreground hover:text-foreground"
                data-testid={`anim-graph-crumb-${crumb.id}`}
                onClick={() => onNavigate(crumb.to)}
              >
                {crumb.label}
              </button>
            )}
          </span>
        ))}
      </nav>
    </ToolbarStrip>
  );
}

function transitionPropertyRows(
  doc: AnimGraphDocument,
  machine: AnimStateMachine,
  transition: AnimTransition,
  commit: (next: AnimGraphDocument, mergeKey?: string) => void,
  titleFromSource: boolean,
): {
  title: string;
  /** What the card shows while collapsed. */
  summary: string;
  rows: PropertyRow[];
  openRuleId: string;
  reverseRuleId: string | null;
} {
  const target =
    machine.states.find((state) => state.id === transition.toStateId)?.name ??
    transition.toStateId;
  const reverse = findReverseTransition(
    machine.transitions,
    transition.fromStateId,
    transition.toStateId,
  );
  return {
    title: titleFromSource
      ? transitionLabel(machine, transition)
      : `To ${target}`,
    summary: `${transition.blendSeconds} s · ${reverse ? "Both Ways" : "One Way"}`,
    rows: [
      {
        id: `${transition.id}-blendSeconds`,
        kind: "number",
        label: "Blend Time",
        unit: "s",
        value: transition.blendSeconds,
        min: 0,
        onChange: (blendSeconds) =>
          commit(
            patchTransition(doc, transition.id, { blendSeconds }),
            `anim-graph:transition:${transition.id}:blendSeconds`,
          ),
      },
      {
        id: `${transition.id}-priority`,
        kind: "number",
        label: "Priority",
        value: transition.priority,
        onChange: (priority) =>
          commit(
            patchTransition(doc, transition.id, { priority }),
            `anim-graph:transition:${transition.id}:priority`,
          ),
      },
      {
        id: `${transition.id}-direction`,
        kind: "enum",
        label: "Direction",
        value: reverse ? "bothWays" : "oneWay",
        options: [
          { value: "oneWay", label: "One Way" },
          { value: "bothWays", label: "Both Ways" },
        ],
        onChange: (value) =>
          commit(
            setTransitionBidirectional(doc, transition.id, value === "bothWays"),
          ),
      },
    ],
    openRuleId: transition.id,
    reverseRuleId: reverse?.id ?? null,
  };
}

export function AnimGraphDetailsPanel(_props: IDockviewPanelProps) {
  const { doc, commit, assetRegistry, catalog, graphGuid, assetName, dimension, location, machine: shownMachine } = useAnimGraphDocument();
  const breakpointStore = useBreakpointStore();
  const {
    canvas,
    selectedIds,
    selectedTransitionId,
    openTransitionId,
    openTransitionRule,
    setSelectedId,
    navigate,
  } = useAnimGraphEditing();
  const [clipPick, setClipPick] = useState(false);
  const [skeletonPick, setSkeletonPick] = useState(false);
  // Transition cards start open; collapsing one is remembered while the document is open.
  const [collapsedTransitionIds, setCollapsedTransitionIds] = useState<ReadonlySet<string>>(() => new Set());
  // The Animation Object script, a rule or a pose graph shows its nodes' details.
  if (canvas === "animationObject" || openTransitionId || location.kind !== "machine" || !shownMachine) {
    return <InspectorPanel {..._props} />;
  }
  const machine = shownMachine;
  const machineId = machine.id;
  const selectedStates = selectedIds.flatMap((id) => machine.states.find((state) => state.id === id) ?? []);
  // Several states show the rows they share; their names, entry and transitions stay per state.
  const multi = selectedStates.length > 1;
  const selected = selectedStates[0] ?? null;
  const edit = documentBatch(doc, commit);
  const selectedTransition =
    machine.transitions.find((row) => row.id === selectedTransitionId) ?? null;
  const pickerEntry = (asset: IndexedAsset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    path: asset.path,
  });
  const registryAssets = assetRegistry?.list() ?? [];
  // A 3D graph's pickers offer only Animations on its Skeleton; a 2D graph's only Sprite Animations.
  const clipAssets = registryAssets
    .filter((asset) => dimension === "2d"
      ? asset.header.type === "SpriteAnimation"
      : asset.header.type === "Animation" &&
        normalizeAnimationPayload(asset.header.payload ?? {}).skeletonGuid === doc.skeletonGuid)
    .map(pickerEntry);
  const skeletonAssets = registryAssets.filter((asset) => asset.header.type === "Skeleton").map(pickerEntry);
  const skeletonAsset = doc.skeletonGuid
    ? registryAssets.find((asset) => asset.header.guid === doc.skeletonGuid)
    : undefined;
  const graphRows: PropertyRow[] = dimension === "3d"
    ? [{
        id: "skeleton",
        kind: "asset",
        label: "Skeleton",
        value: doc.skeletonGuid,
        placeholder: "None",
        assetTypes: ["Skeleton"],
        onPick: () => setSkeletonPick(true),
        onChange: (guid) => commit({ ...doc, skeletonGuid: guid || null }),
        ...assetRowIdentity(skeletonAsset ? { name: skeletonAsset.header.name, type: "Skeleton" } : undefined),
      }]
    : [];
  const machineRows: PropertyRow[] = [{
    id: "machineName",
    kind: "text",
    label: "Name",
    value: machine.name,
    onChange: (name) => commit(patchStateMachine(doc, machineId, (row) => ({ ...row, name }))),
  }];
  const outgoing = selected
    ? machine.transitions.filter((row) => row.fromStateId === selected.id)
    : selectedTransition
      ? [selectedTransition]
      : [];
  /** Sets the clip of a state's single player; the catalog fills its name and length. */
  const applyClipAsset = (stateId: string, guid: string) => {
    const current = edit.read();
    const state = findStateMachine(current, machineId)?.states.find((row) => row.id === stateId);
    const player = state ? singlePlayerOf(state.stateGraph) : null;
    if (!state || !player) return;
    const entry = catalog.find((row) => row.guid === guid);
    edit.write(patchStateGraph(current, machineId, stateId, patchPosePlayer(state.stateGraph, player.id, {
      assetGuid: guid,
      ...(entry?.type === "Animation" && entry.clipName ? { clipName: entry.clipName } : {}),
      ...(typeof entry?.durationMs === "number" ? { durationMs: entry.durationMs } : {}),
    })));
  };
  /** Patches the single player of a state, through `edit` so a batch changes every selected state. */
  const patchPlayer = (stateId: string, settings: Parameters<typeof patchPosePlayer>[2], mergeKey?: string) => {
    const current = edit.read();
    const state = findStateMachine(current, machineId)?.states.find((row) => row.id === stateId);
    const player = state ? singlePlayerOf(state.stateGraph) : null;
    if (!state || !player) return;
    edit.write(patchStateGraph(current, machineId, stateId, patchPosePlayer(state.stateGraph, player.id, settings)), mergeKey);
  };
  /**
   * One state's Clip and Playback rows: while its graph is one player into the output they edit that player;
   * otherwise the state's graph does.
   */
  const sharedStateRows = (state: AnimState): { clip: PropertyRow[]; playback: PropertyRow[] } => {
    const player = singlePlayerOf(state.stateGraph);
    if (!player) return { clip: [], playback: [] };
    const assetGuid = typeof player.data.assetGuid === "string" ? player.data.assetGuid : "";
    const playRate = typeof player.data["default:playRate"] === "number" ? player.data["default:playRate"] : 1;
    const assetType = dimension === "2d" ? "SpriteAnimation" : "Animation";
    return {
      clip: [
        {
          id: "clipAsset",
          kind: "asset",
          label: dimension === "2d" ? "Sprite Animation" : "Animation",
          value: assetGuid || null,
          placeholder: "None",
          ...(multi ? { assetTypes: [assetType] } : {}),
          onPick: () => setClipPick(true),
          onChange: (value) => applyClipAsset(state.id, value ?? ""),
          ...assetRowIdentity(
            assetGuid
              ? (() => {
                  const asset = assetRegistry?.getByGuid(assetGuid);
                  return asset
                    ? { name: asset.header.name, type: asset.header.type }
                    : { name: assetGuid, type: assetType };
                })()
              : undefined,
          ),
        },
      ],
      playback: [
        {
          id: "speed",
          kind: "number",
          label: "Speed",
          value: playRate,
          min: 0,
          onChange: (speed) => patchPlayer(state.id, { playRate: speed }, `anim-graph:state:${state.id}:speed`),
        },
        {
          id: "loop",
          kind: "boolean",
          label: "Loop",
          value: player.data.loop !== false,
          onChange: (loop) => patchPlayer(state.id, { loop }),
        },
      ],
    };
  };
  const identityRows: PropertyRow[] = selected && !multi
    ? [
        {
          id: "name",
          kind: "text",
          label: "Name",
          value: selected.name,
          onChange: (name) => commit(patchState(doc, machineId, selected.id, { name })),
        },
        {
          id: "entry",
          kind: "boolean",
          label: "Entry State",
          value: machine.entryStateId === selected.id,
          onChange: (value) => {
            if (value) {
              commit(patchStateMachine(doc, machineId, (row) => ({ ...row, entryStateId: selected.id })));
              return;
            }
            const other = machine.states.find((state) => state.id !== selected.id);
            if (other) commit(patchStateMachine(doc, machineId, (row) => ({ ...row, entryStateId: other.id })));
          },
        },
      ]
    : [];
  const stateRows = selectedStates.map(sharedStateRows);
  const clipRows: PropertyRow[] = multi ? [] : stateRows[0]?.clip ?? [];
  const playbackRows: PropertyRow[] = multi ? [] : stateRows[0]?.playback ?? [];
  const sharedRows: PropertyRow[] = multi
    ? mergePropertyRows(stateRows.map((rows) => [...rows.clip, ...rows.playback]), { batch: edit.batch })
    : [];
  const transitionBlocks = multi ? [] : outgoing.map((transition) =>
    transitionPropertyRows(doc, machine, transition, commit, !selected),
  );

  return (
    <PanelFrame>
      {multi ? (
        <div data-testid="anim-graph-details">
          <PropertyGrid title={`${selectedStates.length} States`} rows={sharedRows} />
        </div>
      ) : selected || selectedTransition ? (
        <div data-testid="anim-graph-details">
          {identityRows.length > 0 ? (
            <PropertyGrid title="State" rows={identityRows} />
          ) : null}
          {clipRows.length > 0 ? <PropertyGrid title="Clip" rows={clipRows} /> : null}
          {playbackRows.length > 0 ? (
            <PropertyGrid title="Playback" rows={playbackRows} />
          ) : null}
          {selected ? (
            <div className="flex flex-wrap gap-1 px-2 py-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="anim-graph-open-state-graph"
                onClick={() => navigate({ kind: "state", machineId, stateId: selected.id })}
              >
                Open State Graph
              </Button>
            </div>
          ) : null}
          {transitionBlocks.length > 0 ? (
            <ModuleStage
              id="anim-graph-transitions"
              title={selected ? "Transitions" : "Transition"}
              accentRole="flow"
            >
              {transitionBlocks.map((block) => (
                <ModuleCard
                  key={block.openRuleId}
                  id={block.openRuleId}
                  title={block.title}
                  summary={block.summary}
                  open={!collapsedTransitionIds.has(block.openRuleId)}
                  onOpenChange={(open) =>
                    setCollapsedTransitionIds((current) => {
                      const next = new Set(current);
                      if (open) next.delete(block.openRuleId);
                      else next.add(block.openRuleId);
                      return next;
                    })
                  }
                  data-testid={`anim-graph-transition-${block.openRuleId}`}
                >
                  <PropertyGrid rows={block.rows} />
                  <div className="flex flex-wrap gap-1 px-2 py-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={`anim-graph-open-rule-${block.openRuleId}`}
                      onClick={() => openTransitionRule(block.openRuleId)}
                    >
                      Open Rule
                    </Button>
                    {block.reverseRuleId ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid={`anim-graph-open-rule-${block.reverseRuleId}`}
                        onClick={() => openTransitionRule(block.reverseRuleId!)}
                      >
                        Open Reverse Rule
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={`anim-graph-flip-direction-${block.openRuleId}`}
                      disabled={Boolean(block.reverseRuleId)}
                      onClick={() => {
                        const next = flipTransitionDirection(doc, block.openRuleId);
                        const flipped = findStateMachine(next, machineId)?.transitions.find(
                          (row) => row.id === block.openRuleId,
                        );
                        commit(next);
                        if (flipped) setSelectedId(flipped.fromStateId);
                      }}
                    >
                      Flip Direction
                    </Button>
                    {breakpointStore && graphGuid
                      ? [block.openRuleId, block.reverseRuleId].map((id, index) => id ? (
                          <TransitionBreakpointButton
                            key={id}
                            store={breakpointStore}
                            location={{ assetGuid: graphGuid, graphId: animStateMachineDebugGraphId(machineId), nodeId: id }}
                            label={() => stateMachineBreakpointLabel(doc, machineId, id, assetName)}
                            reverse={index === 1}
                          />
                        ) : null)
                      : null}
                  </div>
                </ModuleCard>
              ))}
            </ModuleStage>
          ) : null}
        </div>
      ) : (
        <div data-testid="anim-graph-details">
          {graphRows.length > 0 ? <PropertyGrid title="Graph" rows={graphRows} /> : null}
          <PropertyGrid title="State Machine" rows={machineRows} />
          <p
            className="px-3 py-2 text-sm text-muted-foreground"
            data-testid="anim-graph-details-empty"
          >
            Select a State or Transition
          </p>
        </div>
      )}
      <AssetPicker
        open={skeletonPick}
        onOpenChange={setSkeletonPick}
        assets={skeletonAssets}
        allowedTypes={["Skeleton"]}
        title="Pick Skeleton"
        allowNone
        onPick={(guid) => {
          commit({ ...doc, skeletonGuid: guid || null });
          setSkeletonPick(false);
        }}
        data-testid="anim-graph-skeleton-picker"
      />
      <AssetPicker
        open={clipPick}
        onOpenChange={setClipPick}
        assets={clipAssets}
        allowedTypes={dimension === "2d" ? ["SpriteAnimation"] : ["Animation"]}
        title={
          dimension === "2d" ? "Pick Sprite Animation" : "Pick Animation"
        }
        allowNone
        onPick={(guid) => {
          // Several states take the pick through their shared Clip Asset row.
          const shared = sharedRows.find((row) => row.id === "clipAsset");
          if (multi) {
            if (shared?.kind === "asset") shared.onChange(guid ?? null);
          } else if (selected) {
            applyClipAsset(selected.id, guid ?? "");
          }
          setClipPick(false);
        }}
        data-testid="anim-graph-clip-picker"
      />
    </PanelFrame>
  );
}
