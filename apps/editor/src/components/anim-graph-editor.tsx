import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  ANIM_STATE_LAYOUT_GAP_X,
  animGraphMembersFromVariables,
  animPaletteNodes,
  createDefaultAnimGraph,
  createStateGraph,
  defaultAnimStatePosition,
  defaultAnimVariableValue,
  findReverseTransition,
  hydrateAnimGraphForEditor,
  animTransitionFromDrag,
  animTransitionOnSide,
  normalizeAnimConnection,
  transitionAtWire,
  parseAnimGraphDocument,
  patchPosePlayer,
  patchStateGraph,
  patchStateMachine,
  patchTransition,
  primaryPosePlayer,
  ANIM_POSE_BLEND_SPACE_PLAYER_TYPE,
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
  type AnimStateAlias,
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
import { ArrowLeftIcon, Trash2Icon } from "lucide-react";
import {
  GRAPH_DEFAULT_ZOOM,
  GraphEditor,
  animGraphEdgeTypes,
  animGraphNodeTypes,
} from "@haptic/graph-ui";
import { ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, type BreakpointLocation } from "@haptic/bridge";
import { parseDocumentId, type SerializedGraph } from "@haptic/core";
import type { IndexedAsset } from "@haptic/assets";
import type { Diagnostic } from "@haptic/scripting";
import {
  useActiveDocumentState,
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { animStateCanvas, useAnimGraphEditing, type AnimCanvas } from "../context/anim-graph-editing-context";
import { useAppSettings } from "../context/app-settings-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { useAnimStateMachineRunTrace } from "../context/graph-debug-context";
import { useOptionalAnimGraphPreview } from "../context/anim-graph-preview-context";
import { commitAnimGraphVariables } from "../lib/anim-graph-variables";
import { animGraphPlaysAsset, animSyncGroupRow } from "../lib/anim-pose-inspector";
import { GraphPanel } from "../panels/graph-panel";
import {
  ANIM_STATE_MACHINE_PANEL_ID,
  openAnimStateGraphPanel,
  type AnimStateGraphPanelParams,
} from "../shell/function-graph-panels";
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
const NO_SUBSCRIBE = () => () => {};

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
    parseAnimGraphDocument(payload, dimension) ?? createDefaultAnimGraph("Locomotion", { dimension }),
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

function addAnimState(doc: AnimGraphDocument, dimension: AnimGraphDimension): AnimGraphDocument {
  return patchStateMachine(doc, (machine) => ({
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
  stateId: string,
  patch: Partial<AnimState>,
): AnimGraphDocument {
  return patchStateMachine(doc, (machine) => ({
    ...machine,
    states: machine.states.map((state) =>
      state.id === stateId ? { ...state, ...patch } : state,
    ),
  }));
}

/** What a state plays, for its card: its single player's clip, the Blend Space its graph plays from, else "State Graph". */
function stateClipLabel(
  state: AnimState,
  catalog: readonly AnimClipCatalogEntry[],
): string {
  const player = singlePlayerOf(state.stateGraph);
  if (!player) {
    const primary = primaryPosePlayer(state.stateGraph);
    if (primary?.type === ANIM_POSE_BLEND_SPACE_PLAYER_TYPE) {
      const guid = typeof primary.data.assetGuid === "string" ? primary.data.assetGuid : "";
      return guid ? catalog.find((row) => row.guid === guid)?.name ?? "Missing Blend Space" : "No Blend Space";
    }
    return primary ? "State Graph" : "No Clip";
  }
  const assetGuid = typeof player.data.assetGuid === "string" ? player.data.assetGuid : "";
  if (!assetGuid) return "No Clip";
  return catalog.find((row) => row.guid === assetGuid)?.name ?? "Missing Clip";
}

function transitionLabel(machine: AnimStateMachine, transition: AnimTransition): string {
  const from =
    machine.states.find((state) => state.id === transition.fromStateId)?.name ??
    machine.aliases?.find((alias) => alias.id === transition.fromStateId)?.name ??
    transition.fromStateId;
  const to =
    machine.states.find((state) => state.id === transition.toStateId)?.name ??
    transition.toStateId;
  return `${from} To ${to}`;
}

/** Asset types a state clip, its label or its skeleton check (an Animation's Model) can name. */
const CLIP_CATALOG_TYPES: ReadonlySet<string> = new Set([
  "Animation",
  "BlendSpace",
  "Model",
  "SpriteBlendSpace",
  "SpriteAnimation",
]);

/** The open Animation Graph: its document (clips resolved), catalog, guid and the graph on show. */
// eslint-disable-next-line react-refresh/only-export-components -- the graph's windows share it
export function useAnimGraphDocument() {
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
  const machine = doc.stateMachine;
  return { doc, latestDoc, commit, assetRegistry, documentId, catalog, graphGuid, assetName, dimension, machine };
}

/** A state's or transition's breakpoint, named as the State Machine shows it. */
function stateMachineBreakpointLabel(
  doc: AnimGraphDocument,
  id: string,
  assetName: string,
): BreakpointEntry["label"] {
  const machine = doc.stateMachine;
  const state = machine.states.find((row) => row.id === id);
  const transition = state ? undefined : machine.transitions.find((row) => row.id === id);
  return {
    className: assetName,
    graphName: "State Machine",
    nodeTitle: state?.name ?? (transition ? transitionLabel(machine, transition) : id),
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

function AnimGraphVariablesList({ containerApi }: { containerApi: IDockviewPanelProps["containerApi"] | undefined }) {
  const { doc, commit, machine, dimension } = useAnimGraphDocument();
  const { selectedIds, setSelectedId, setCanvas } = useAnimGraphEditing();
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
        <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-1 px-1">
              <div className="text-sm font-medium">States</div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="anim-graph-add-state"
                onClick={() => commit(addAnimState(doc, dimension))}
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
                  // A state picked while another canvas has the Inspector selects it on the State Machine.
                  containerApi?.getPanel(ANIM_STATE_MACHINE_PANEL_ID)?.api.setActive();
                  setCanvas("stateMachine");
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
      </div>
    </PanelFrame>
  );
}

export function AnimGraphVariablesPanel(props: IDockviewPanelProps) {
  return <AnimGraphVariablesList containerApi={props.containerApi} />;
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

/** What a script canvas of the Animation Graph reads: data assets, pin type names and the graph's Variables. */
function useAnimScriptCanvas(doc: AnimGraphDocument) {
  const typeCatalog = useDataCatalog();
  const sheetDocuments = useOpenDocumentsOfKinds(DATA_TREE_KINDS);
  const dataAssets = useMemo(() => collectDataGraphAssets(typeCatalog.assets, sheetDocuments), [typeCatalog.assets, sheetDocuments]);
  const pinTypeNames = useMemo(() => Object.fromEntries([
    ...Object.entries(typeCatalog.schemas.structs),
    ...Object.entries(typeCatalog.schemas.enums),
  ].map(([guid, schema]) => [guid, schema.name])), [typeCatalog.schemas]);
  const members = useMemo(() => animGraphMembersFromVariables(doc.variables), [doc.variables]);
  const { settings: appSettings } = useAppSettings();
  const defaultZoom = appSettings.graphDefaultZoom ?? GRAPH_DEFAULT_ZOOM;
  return { typeCatalog, dataAssets, pinTypeNames, members, defaultZoom };
}

/** The graph's Variables as the validator reads a script's members. */
function animValidationMembers(members: ReturnType<typeof animGraphMembersFromVariables>) {
  return members.map((member) => ({
    id: member.id,
    name: member.name,
    kind: "variable" as const,
    classId: "AnimGraph",
    typeId: member.typeId ?? "bool",
    typeClassId: member.typeClassId,
  }));
}

/** The graph id a state graph's validation rows go under; the State Machine's own publishing leaves them. */
function animStateGraphDiagnosticsId(documentId: string, stateId: string): string {
  return `${documentId}:pose-state:${stateId}`;
}

function isAnimStateGraphDiagnosticsId(documentId: string, graphId: string): boolean {
  return graphId.startsWith(`${documentId}:pose-`);
}

/**
 * The State Machine (Graph): states, aliases and transitions. Double-tap a state, or **Open State Graph** in the
 * Inspector, to open its graph in its own tab beside this one; a transition's rule still opens here, with **Back To
 * State Machine**.
 */
export function AnimGraphGraphPanel(props: IDockviewPanelProps) {
  const claimCanvas = useAnimCanvas("stateMachine", props.api);
  const { doc, latestDoc, commit, documentId, catalog, graphGuid, assetName, dimension, machine } = useAnimGraphDocument();
  // While a Simulation debugs this graph, the State Machine shows the states the followed instance samples and its
  // transitions; otherwise, while the Preview window runs, the ones the Preview plays.
  const simulationTrace = useAnimStateMachineRunTrace(graphGuid, true);
  const preview = useOptionalAnimGraphPreview();
  const previewActive = useSyncExternalStore(
    preview?.subscribe ?? NO_SUBSCRIBE,
    () => preview?.getSnapshot().active ?? false,
  );
  const runTrace = simulationTrace ?? (previewActive ? preview?.runTrace : undefined);
  const {
    selectedId,
    selectedIds,
    setSelectedIds,
    selectedTransitionId,
    setSelectedTransitionId,
    focusedNodeId,
    openTransitionId,
    openTransitionRule,
    closeTransitionRule,
  } = useAnimGraphEditing();
  const { setSelectedNodeIds } = useGraphEditing();
  const { activeDocumentId } = useActiveDocumentState();
  const { typeCatalog, dataAssets, pinTypeNames, members: ruleMembers, defaultZoom } = useAnimScriptCanvas(doc);
  const ruleSurface = openTransitionId ? `rule:${openTransitionId}` : "machine";
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
    (id: string) => stateMachineBreakpointLabel(latestDocRef.current(), id, assetName),
    [assetName],
  );
  const { edit: editBreakpoint, dialog: breakpointSettingsDialog } = useBreakpointSettingsEditor(breakpointStore);
  // The canvas's node menu and keys act on the selected states' breakpoints; Edit opens the hit count.
  const breakpoints = useMemo(
    () => breakpointStore && graphGuid
      ? stateMachineBreakpointView(breakpointStore, graphGuid, breakpointLabel, () => latestDocRef.current(), (nodeId) =>
        editBreakpoint({
          location: { assetGuid: graphGuid, graphId: ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, nodeId },
          nodeTitle: breakpointLabel(nodeId).nodeTitle,
          pins: null,
        }))
      : undefined,
    [breakpointLabel, breakpointStore, editBreakpoint, graphGuid],
  );
  // A stop in the State Machine (from a breakpoint or the Breakpoints window) shows it, and a stop at a transition
  // selects it, so Details show it.
  const focusOnMachine = focusDiagnostic?.assetGuid === graphGuid && focusDiagnostic?.graphId === ANIM_STATE_MACHINE_DEBUG_GRAPH_ID;
  const focusTransition = focusOnMachine
    ? machine.transitions.find((row) => row.id === focusDiagnostic?.nodeId)
    : undefined;
  const focusTransitionId = focusTransition?.id;
  const panelApi = props.api;
  useEffect(() => {
    if (!focusOnMachine) return;
    closeTransitionRule();
    // Behind the Animation Object or a state's tab, the Graph comes forward.
    if (panelApi && !panelApi.isVisible) panelApi.setActive();
  }, [closeTransitionRule, focusOnMachine, panelApi]);
  useEffect(() => {
    if (focusTransitionId) setSelectedTransitionId(focusTransitionId);
  }, [focusTransitionId, setSelectedTransitionId]);
  const [rulePaletteOpen, setRulePaletteOpen] = useState(false);
  const rulePaletteCacheRef = useRef(new ScriptPaletteCache());
  // This canvas's own rows; the Animation Object panel and the state tabs show their scripts'.
  const graphDiagnostics = useMemo(
    () =>
      diagnostics
        .filter((row) => row.graphId.startsWith(`${documentId}:`) && !isAnimStateGraphDiagnosticsId(documentId, row.graphId))
        .map((row) => ({
          nodeId: row.nodeId,
          pinId: row.pinId,
          severity: row.severity,
          message: row.message,
        })),
    [diagnostics, documentId],
  );
  const openTransition = openTransitionId
    ? machine.transitions.find((transition) => transition.id === openTransitionId) ?? null
    : null;
  const machineTransitions = machine.transitions;
  const aliasIds = useMemo(() => new Set((machine.aliases ?? []).map((alias) => alias.id)), [machine.aliases]);
  const initialGraph = useMemo(() => {
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
  const ruleGraph = useMemo(() => {
    if (!openTransition) return null;
    const oneWay = !findReverseTransition(
      machineTransitions,
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
  }, [machineTransitions, openTransition, ruleMembers, typeCatalog.schemas, dataAssets]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key covers the input
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
            members: animValidationMembers(ruleMembers),
          })
        : [];
    // This canvas's rows (the graph and its open rule) and this asset's Play and Compile rows. The Animation Object
    // panel publishes its script's rows under the document's own graph id, and each state tab its graph's; both stay.
    const path = parseDocumentId(documentId)?.path;
    setDiagnostics([...animRows, ...ruleRows], {
      replaces: (d) =>
        !isAnimStateGraphDiagnosticsId(documentId, d.graphId) &&
        (d.graphId.startsWith(`${documentId}:`) ||
          ((d.assetGuid === documentId || d.assetGuid === path) && d.graphId !== documentId)),
    });
  }, [
    activeDocumentId,
    doc,
    documentId,
    catalog,
    dimension,
    openTransition,
    ruleGraph,
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
              {transitionLabel(machine, openTransition)}
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

  return (
    <PanelFrame className="flex-1">
      <div className="anim-graph-canvas flex h-full min-h-0 flex-col" data-testid="anim-graph-editor" onPointerDownCapture={claimCanvas}>
        <GraphEditor
          key="state-machine"
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
            // Nothing enters a State Alias: it only sends transitions.
            if (aliasIds.has(connection.target)) return null;
            const next = normalizeAnimConnection(connection);
            if (!next) return null;
            return { ...connection, ...next };
          }}
          connectDraggedToNode={(drag) => (aliasIds.has(drag.toNodeId) ? null : animTransitionFromDrag(drag))}
          edgeBreaksAtPin={animTransitionOnSide}
          onSelectionChange={(nodeIds) => {
            queueMicrotask(() => setSelectedIds(nodeIds));
          }}
          onEdgeSelectionChange={(edgeIds) => {
            queueMicrotask(() => setSelectedTransitionId(edgeIds[0] ?? null));
          }}
          onNodeDoubleClick={(stateId) => {
            // Double-tap a state to open its graph in its own tab.
            const state = machine.states.find((row) => row.id === stateId);
            if (state && props.containerApi) openAnimStateGraphPanel(props.containerApi, state.id, state.name);
          }}
          onEdgeDoubleClick={(edgeId, point) => {
            // Double-tap a wire to open its transition's rule; on a shared wire, the direction pointing nearer.
            const transition = transitionAtWire(machine, edgeId, point);
            if (transition) openTransitionRule(transition.id);
          }}
          onChange={(next) => {
            const keepSelection = selectedIds;
            queueMicrotask(() => {
              const current = latestDoc();
              const updated = serializedToStateMachine(next, current.stateMachine, dimension);
              const kept = keepSelection.filter((id) =>
                updated.states.some((row) => row.id === id),
              );
              if (kept.length !== keepSelection.length) setSelectedIds(kept);
              commit(patchStateMachine(current, () => updated));
            });
          }}
        />
      </div>
      {breakpointSettingsDialog}
    </PanelFrame>
  );
}

/**
 * One state's graph in its own tab beside the State Machine, as a Class's functions open beside its Event Graph: the
 * players, blends and selections whose pose (3D) or frame (2D) reaches the state's Output. A deleted state closes its
 * tab and a rename retitles it. Behind another tab its canvas would fit a view with no size, so the graph mounts the
 * first time the tab shows.
 */
export function AnimStateGraphPanel(props: IDockviewPanelProps<Partial<AnimStateGraphPanelParams>>) {
  const { api } = props;
  const stateId = props.params?.stateId ?? "";
  const claimCanvas = useAnimCanvas(animStateCanvas(stateId), api);
  const { doc, latestDoc, commit, documentId, dimension, machine } = useAnimGraphDocument();
  const state = machine.states.find((row) => row.id === stateId);
  const { setSelectedNodeIds } = useGraphEditing();
  const { activeDocumentId } = useActiveDocumentState();
  const { typeCatalog, dataAssets, pinTypeNames, members, defaultZoom } = useAnimScriptCanvas(doc);
  const { sessionViewport, onSessionViewportChange } = useGraphSessionViewport(documentId, `state:${stateId}`);
  const { setDiagnostics, diagnostics } = useValidation();
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
  // A deleted state closes its tab; a rename retitles it.
  const stateMissing = !state;
  const stateName = state?.name;
  useEffect(() => {
    if (stateMissing) {
      api.close();
      return;
    }
    if (stateName && api.title !== stateName) api.setTitle(stateName);
  }, [api, stateMissing, stateName]);
  const stateGraph = state?.stateGraph ?? null;
  const poseGraph = useMemo(() => {
    if (!stateGraph) return null;
    return hydrateSerializedGraphForEditor({ ...stateGraph, members }, defaultNodeRegistry(), { ...typeCatalog.schemas, dataAssets });
  }, [stateGraph, members, typeCatalog.schemas, dataAssets]);
  const posePaletteInput = {
    parentClass: "Object",
    animationGraphHost: "pose" as const,
    animPose: { dimension },
    graph: { nodes: [], edges: [], members },
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
  // This tab publishes its graph's rows under its own id and takes them away when it closes.
  const diagnosticsId = animStateGraphDiagnosticsId(documentId, stateId);
  useEffect(() => {
    if (activeDocumentId !== documentId || !poseGraph) return;
    const rows = validateSerializedGraph(poseGraph, {
      ...typeCatalog.schemas,
      dataAssets,
      assetGuid: documentId,
      graphId: diagnosticsId,
      members: animValidationMembers(members),
    });
    setDiagnostics(rows, { replaces: (d) => d.graphId === diagnosticsId });
  }, [activeDocumentId, dataAssets, diagnosticsId, documentId, members, poseGraph, setDiagnostics, typeCatalog.schemas]);
  useEffect(
    () => () => setDiagnostics([], { replaces: (d) => d.graphId === diagnosticsId }),
    [diagnosticsId, setDiagnostics],
  );
  // Its own rows, and the graph's checks of this state's nodes (a clip on another Skeleton, say).
  const graphDiagnostics = useMemo(
    () =>
      diagnostics
        .filter((row) => row.graphId === diagnosticsId || row.graphId === `${documentId}:anim`)
        .map((row) => ({ nodeId: row.nodeId, pinId: row.pinId, severity: row.severity, message: row.message })),
    [diagnostics, diagnosticsId, documentId],
  );
  return (
    <PanelFrame className="flex-1">
      <div className="flex h-full min-h-0 flex-col" data-testid="anim-pose-graph" data-state-id={stateId} onPointerDownCapture={claimCanvas}>
        {shown && poseGraph ? (
          <GraphEditor
            key={stateId}
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
            onChange={(next) => {
              const graph = applyDataGraphAssetPicks(poseGraph, { nodes: next.nodes, edges: next.edges }, dataAssets);
              queueMicrotask(() => {
                commit(patchStateGraph(latestDoc(), stateId, persistPoseGraph(graph)));
              });
            }}
          />
        ) : null}
      </div>
    </PanelFrame>
  );
}

/** A pose graph as stored: its nodes and wires, without the editor's member list. */
function persistPoseGraph(graph: SerializedGraph): SerializedGraph {
  return { nodes: graph.nodes, edges: graph.edges };
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

export function AnimGraphDetailsPanel(props: IDockviewPanelProps) {
  const { doc, commit, assetRegistry, catalog, graphGuid, assetName, dimension, machine } = useAnimGraphDocument();
  const breakpointStore = useBreakpointStore();
  const {
    canvas,
    selectedIds,
    selectedTransitionId,
    openTransitionId,
    openTransitionRule,
    setSelectedId,
  } = useAnimGraphEditing();
  const [clipPick, setClipPick] = useState(false);
  const [skeletonPick, setSkeletonPick] = useState(false);
  // Transition cards start open; collapsing one is remembered while the document is open.
  const [collapsedTransitionIds, setCollapsedTransitionIds] = useState<ReadonlySet<string>>(() => new Set());
  // The Animation Object script, a state's graph or an open rule shows its nodes' details.
  if (canvas !== "stateMachine" || openTransitionId) {
    return <InspectorPanel {...props} />;
  }
  const selectedStates = selectedIds.flatMap((id) => machine.states.find((state) => state.id === id) ?? []);
  // Several states show the rows they share; their names, entry and transitions stay per state.
  const multi = selectedStates.length > 1;
  const selected = selectedStates[0] ?? null;
  const selectedAlias = !selected && selectedIds.length === 1
    ? (machine.aliases ?? []).find((alias) => alias.id === selectedIds[0]) ?? null
    : null;
  const patchAlias = (aliasId: string, patch: Partial<AnimStateAlias>) =>
    commit(patchStateMachine(doc, (current) => ({
      ...current,
      aliases: (current.aliases ?? []).map((alias) => (alias.id === aliasId ? { ...alias, ...patch } : alias)),
    })));
  const aliasRows: PropertyRow[] = selectedAlias
    ? [
        { id: "aliasName", kind: "text", label: "Name", value: selectedAlias.name, onChange: (name) => patchAlias(selectedAlias.id, { name }) },
        {
          id: "aliasAnyState",
          kind: "boolean",
          label: "Any State",
          value: selectedAlias.anyState,
          description: "Its transitions leave from every state, never into the state already playing.",
          onChange: (anyState) => patchAlias(selectedAlias.id, { anyState }),
        },
      ]
    : [];
  const aliasStateRows: PropertyRow[] = selectedAlias
    ? machine.states.map((state) => ({
        id: `aliasState-${state.id}`,
        kind: "boolean" as const,
        label: state.name,
        value: selectedAlias.anyState || selectedAlias.stateIds.includes(state.id),
        disabled: selectedAlias.anyState,
        onChange: (covered: boolean) => patchAlias(selectedAlias.id, {
          stateIds: covered
            ? [...new Set([...selectedAlias.stateIds, state.id])]
            : selectedAlias.stateIds.filter((id) => id !== state.id),
        }),
      }))
    : [];
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
    .filter((asset) =>
      asset.header.type === (dimension === "2d" ? "SpriteAnimation" : "Animation") &&
      animGraphPlaysAsset(asset.header, { dimension, skeletonGuid: doc.skeletonGuid }))
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
  const outgoing = selected || selectedAlias
    ? machine.transitions.filter((row) => row.fromStateId === (selected ?? selectedAlias)!.id)
    : selectedTransition
      ? [selectedTransition]
      : [];
  /** Sets the clip of a state's single player; the catalog fills its name and length. */
  const applyClipAsset = (stateId: string, guid: string) => {
    const current = edit.read();
    const state = current.stateMachine.states.find((row) => row.id === stateId);
    const player = state ? singlePlayerOf(state.stateGraph) : null;
    if (!state || !player) return;
    const entry = catalog.find((row) => row.guid === guid);
    edit.write(patchStateGraph(current, stateId, patchPosePlayer(state.stateGraph, player.id, {
      assetGuid: guid,
      ...(entry?.type === "Animation" && entry.clipName ? { clipName: entry.clipName } : {}),
      ...(typeof entry?.durationMs === "number" ? { durationMs: entry.durationMs } : {}),
    })));
  };
  /** Patches the single player of a state, through `edit` so a batch changes every selected state. */
  const patchPlayer = (stateId: string, settings: Parameters<typeof patchPosePlayer>[2], mergeKey?: string) => {
    const current = edit.read();
    const state = current.stateMachine.states.find((row) => row.id === stateId);
    const player = state ? singlePlayerOf(state.stateGraph) : null;
    if (!state || !player) return;
    edit.write(patchStateGraph(current, stateId, patchPosePlayer(state.stateGraph, player.id, settings)), mergeKey);
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
        {
          ...animSyncGroupRow(player.data.syncGroup, (syncGroup) =>
            patchPlayer(state.id, { syncGroup: syncGroup ?? "" }, `anim-graph:state:${state.id}:sync`)),
          id: "syncGroup",
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
          onChange: (name) => commit(patchState(doc, selected.id, { name })),
        },
        {
          id: "entry",
          kind: "boolean",
          label: "Entry State",
          value: machine.entryStateId === selected.id,
          onChange: (value) => {
            if (value) {
              commit(patchStateMachine(doc, (row) => ({ ...row, entryStateId: selected.id })));
              return;
            }
            const other = machine.states.find((state) => state.id !== selected.id);
            if (other) commit(patchStateMachine(doc, (row) => ({ ...row, entryStateId: other.id })));
          },
        },
      ]
    : [];
  // A state's own Animation Events, each fired by name to the Animation Object.
  const stateEventRows: PropertyRow[] = selected && !multi
    ? ([["enter", "Enter Event"], ["exit", "Exit Event"], ["fullyBlended", "Fully Blended Event"]] as const).map(([key, label]) => ({
        id: `stateEvent-${key}`,
        kind: "text" as const,
        label,
        value: selected.events?.[key] ?? "",
        onChange: (name: string) => {
          const events = { ...selected.events, [key]: name };
          if (!name.trim()) delete events[key];
          commit(
            patchState(doc, selected.id, { events: Object.keys(events).length > 0 ? events : undefined }),
            `anim-graph:state:${selected.id}:event:${key}`,
          );
        },
      }))
    : [];
  const stateRows = selectedStates.map(sharedStateRows);
  const clipRows: PropertyRow[] = multi ? [] : stateRows[0]?.clip ?? [];
  const playbackRows: PropertyRow[] = multi ? [] : stateRows[0]?.playback ?? [];
  const sharedRows: PropertyRow[] = multi
    ? mergePropertyRows(stateRows.map((rows) => [...rows.clip, ...rows.playback]), { batch: edit.batch })
    : [];
  const transitionBlocks = multi ? [] : outgoing.map((transition) =>
    transitionPropertyRows(doc, machine, transition, commit, !selected && !selectedAlias),
  );

  return (
    <PanelFrame>
      {multi ? (
        <div data-testid="anim-graph-details">
          <PropertyGrid title={`${selectedStates.length} States`} rows={sharedRows} />
        </div>
      ) : selected || selectedTransition || selectedAlias ? (
        <div data-testid="anim-graph-details">
          {identityRows.length > 0 ? (
            <PropertyGrid title="State" rows={identityRows} />
          ) : null}
          {selectedAlias ? (
            <>
              <PropertyGrid title="State Alias" rows={aliasRows} data-testid="anim-graph-alias" />
              <PropertyGrid title="Leaves From" rows={aliasStateRows} data-testid="anim-graph-alias-states" />
            </>
          ) : null}
          {clipRows.length > 0 ? <PropertyGrid title="Clip" rows={clipRows} /> : null}
          {playbackRows.length > 0 ? (
            <PropertyGrid title="Playback" rows={playbackRows} />
          ) : null}
          {stateEventRows.length > 0 ? (
            <PropertyGrid title="Events" rows={stateEventRows} data-testid="anim-graph-state-events" />
          ) : null}
          {selected ? (
            <div className="flex flex-wrap gap-1 px-2 py-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="anim-graph-open-state-graph"
                onClick={() => {
                  if (props.containerApi) openAnimStateGraphPanel(props.containerApi, selected.id, selected.name);
                }}
              >
                Open State Graph
              </Button>
            </div>
          ) : null}
          {transitionBlocks.length > 0 ? (
            <ModuleStage
              id="anim-graph-transitions"
              title={selected || selectedAlias ? "Transitions" : "Transition"}
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
                        const flipped = next.stateMachine.transitions.find(
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
                            location={{ assetGuid: graphGuid, graphId: ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, nodeId: id }}
                            label={() => stateMachineBreakpointLabel(doc, id, assetName)}
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
