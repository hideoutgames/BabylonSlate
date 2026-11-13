import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import {
  ANIM_STATE_LAYOUT_GAP_X,
  animGraphMembersFromVariables,
  animGraphToSerialized,
  animPaletteNodes,
  createDefaultAnimGraph,
  defaultAnimStatePosition,
  defaultAnimVariableValue,
  findReverseTransition,
  hydrateAnimGraphForEditor,
  normalizeAnimConnection,
  parseAnimGraphDocument,
  patchTransition,
  resolveAnimGraphClips,
  serializedToAnimGraph,
  setTransitionBidirectional,
  flipTransitionDirection,
  decorateTransitionRuleGraph,
  persistTransitionRuleGraph,
  validateAnimGraph,
  type AnimClipCatalogEntry,
  type AnimClipKind,
  type AnimClipRef,
  type AnimGraphDimension,
  type AnimGraphDocument,
  type AnimState,
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
import { parseDocumentId } from "@haptic/core";
import { normalizeAnimationPayload, type IndexedAsset } from "@haptic/assets";
import type { Diagnostic } from "@haptic/scripting";
import {
  useActiveDocumentState,
  useDocumentActions,
  useOpenDocument,
  useRegistryState,
} from "../context/document-context";
import { useDocumentWorkspace } from "../context/document-workspace-context";
import { useAnimGraphEditing } from "../context/anim-graph-editing-context";
import { useAppSettings } from "../context/app-settings-context";
import { useGraphEditing } from "../context/graph-editing-context";
import { useAnimStateMachineRunTrace } from "../context/graph-debug-context";
import { commitAnimGraphVariables } from "../lib/anim-graph-variables";
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
): AnimGraphDocument {
  return resolveAnimGraphClips(
    parseAnimGraphDocument(payload) ?? createDefaultAnimGraph(),
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

function uniqueStateId(doc: AnimGraphDocument): string {
  const ids = new Set(doc.states.map((state) => state.id));
  let index = 1;
  while (ids.has(`state-${index}`)) index += 1;
  return `state-${index}`;
}

function uniqueStateName(doc: AnimGraphDocument, base = "State"): string {
  const names = new Set(doc.states.map((state) => state.name.trim().toLowerCase()));
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

function addAnimState(doc: AnimGraphDocument): AnimGraphDocument {
  const id = uniqueStateId(doc);
  return {
    ...doc,
    states: [
      ...doc.states,
      {
        id,
        name: uniqueStateName(doc),
        clipId: null,
        speed: 1,
        loop: true,
        position: nextAnimStatePosition(doc.states),
      },
    ],
  };
}

function patchState(
  doc: AnimGraphDocument,
  stateId: string,
  patch: Partial<AnimState>,
): AnimGraphDocument {
  return {
    ...doc,
    states: doc.states.map((state) =>
      state.id === stateId ? { ...state, ...patch } : state,
    ),
  };
}

function clipIdForState(stateId: string): string {
  return `clip-${stateId}`;
}

function upsertStateClip(
  doc: AnimGraphDocument,
  stateId: string,
  patch: Partial<Pick<AnimClipRef, "kind" | "assetGuid" | "clipName" | "durationMs">>,
): AnimGraphDocument {
  const state = doc.states.find((row) => row.id === stateId);
  if (!state) return doc;
  const clipId = state.clipId ?? clipIdForState(stateId);
  const existing = doc.clips.find((clip) => clip.id === clipId);
  const clip: AnimClipRef = {
    id: clipId,
    kind: patch.kind ?? existing?.kind ?? "animation",
    assetGuid: patch.assetGuid ?? existing?.assetGuid ?? "",
    clipName: patch.clipName ?? existing?.clipName ?? state.name,
    durationMs: patch.durationMs ?? existing?.durationMs ?? 1000,
  };
  const clips = existing
    ? doc.clips.map((row) => (row.id === clipId ? clip : row))
    : [...doc.clips, clip];
  return {
    ...doc,
    clips,
    states: doc.states.map((row) =>
      row.id === stateId ? { ...row, clipId } : row,
    ),
  };
}

function stateClipLabel(
  doc: AnimGraphDocument,
  state: AnimState,
  catalog: readonly AnimClipCatalogEntry[],
): string {
  const clip = doc.clips.find((row) => row.id === state.clipId);
  if (!clip?.assetGuid) return "No Clip";
  const entry = catalog.find((row) => row.guid === clip.assetGuid);
  if (!entry) return "Missing Clip";
  return entry.name;
}

function transitionLabel(doc: AnimGraphDocument, transition: AnimTransition): string {
  const from =
    doc.states.find((state) => state.id === transition.fromStateId)?.name ??
    transition.fromStateId;
  const to =
    doc.states.find((state) => state.id === transition.toStateId)?.name ??
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
  const doc = useMemo(
    () =>
      asAnimGraph((entry?.content ?? {}) as Record<string, unknown>, catalog),
    [entry?.content, catalog],
  );
  /**
   * The stored document now. GraphEditor reports edits while it renders, so
   * the graph commits a microtask later; it builds on this, not on `doc`.
   */
  const latestDoc = () => {
    const content = getOpenDocuments().find((open) => open.id === documentId)?.content;
    return content ? asAnimGraph(content as Record<string, unknown>, catalog) : doc;
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
  // A 3D graph plays Animations on its Skeleton; a 2D graph plays Sprite Animations.
  const dimension: AnimGraphDimension = entry?.ref.kind === "anim-graph-2d" ? "2d" : "3d";
  return { doc, latestDoc, commit, assetRegistry, documentId, catalog, graphGuid, assetName, dimension };
}

/** A state's or transition's breakpoint, named as the State Machine shows it. */
function stateMachineBreakpointLabel(
  doc: AnimGraphDocument,
  id: string,
  assetName: string,
): BreakpointEntry["label"] {
  const state = doc.states.find((row) => row.id === id);
  const transition = state ? undefined : doc.transitions.find((row) => row.id === id);
  return {
    className: assetName,
    graphName: "State Machine",
    nodeTitle: state?.name ?? (transition ? transitionLabel(doc, transition) : id),
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

function AnimGraphVariablesList({
  showStates,
}: {
  showStates: boolean;
}) {
  const { doc, commit } = useAnimGraphDocument();
  const { selectedIds, setSelectedId } = useAnimGraphEditing();
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
        {showStates ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-1 px-1">
              <div className="text-sm font-medium">States</div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="anim-graph-add-state"
                onClick={() => commit(addAnimState(doc))}
              >
                Add State
              </Button>
            </div>
            {doc.states.map((state) => (
              <Button
                key={state.id}
                type="button"
                variant={selectedIds.includes(state.id) ? "secondary" : "ghost"}
                size="sm"
                className="w-full justify-between gap-2"
                aria-pressed={selectedIds.includes(state.id)}
                data-testid={`anim-graph-state-${state.id}`}
                onClick={() => setSelectedId(state.id)}
              >
                <span className="min-w-0 truncate">{state.name}</span>
                {doc.entryStateId === state.id ? (
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
  return <AnimGraphVariablesList showStates />;
}

export function AnimObjectVariablesPanel(_props: IDockviewPanelProps) {
  void _props;
  return <AnimGraphVariablesList showStates={false} />;
}

export function AnimGraphGraphPanel(_props: IDockviewPanelProps) {
  void _props;
  const { doc, latestDoc, commit, documentId, catalog, graphGuid, assetName, dimension } = useAnimGraphDocument();
  // While a Simulation debugs this graph, the State Machine shows the states the followed instance samples and its transitions.
  const runTrace = useAnimStateMachineRunTrace(graphGuid);
  const {
    selectedId,
    selectedIds,
    setSelectedIds,
    selectedTransitionId,
    setSelectedTransitionId,
    focusedNodeId,
    openTransitionId,
    closeTransitionRule,
  } = useAnimGraphEditing();
  const { setSelectedNodeIds } = useGraphEditing();
  const { activeDocumentId, animEditorMode } = useActiveDocumentState();
  const typeCatalog = useDataCatalog();
  const sheetDocuments = useOpenDocumentsOfKinds(DATA_TREE_KINDS);
  const dataAssets = useMemo(() => collectDataGraphAssets(typeCatalog.assets, sheetDocuments), [typeCatalog.assets, sheetDocuments]);
  const pinTypeNames = useMemo(() => Object.fromEntries([
    ...Object.entries(typeCatalog.schemas.structs),
    ...Object.entries(typeCatalog.schemas.enums),
  ].map(([guid, schema]) => [guid, schema.name])), [typeCatalog.schemas]);
  const ruleSurface = openTransitionId
    ? `rule:${openTransitionId}`
    : animEditorMode;
  const { sessionViewport, onSessionViewportChange } = useGraphSessionViewport(
    documentId,
    ruleSurface,
  );
  const { setDiagnostics, diagnostics, focusDiagnostic } = useValidation();
  // Breakpoints use the session's terms: the graph's guid and the State Machine's graph id.
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
  // A stop at a transition (from a breakpoint or the Breakpoints window) selects it, so Details show it.
  const focusTransition =
    focusDiagnostic?.graphId === ANIM_STATE_MACHINE_DEBUG_GRAPH_ID && focusDiagnostic.assetGuid === graphGuid
      ? doc.transitions.find((row) => row.id === focusDiagnostic.nodeId)
      : undefined;
  const focusTransitionId = focusTransition?.id;
  useEffect(() => {
    if (focusTransitionId) setSelectedTransitionId(focusTransitionId);
  }, [focusTransitionId, setSelectedTransitionId]);
  const { settings: appSettings } = useAppSettings();
  const defaultZoom = appSettings.graphDefaultZoom ?? GRAPH_DEFAULT_ZOOM;
  const [rulePaletteOpen, setRulePaletteOpen] = useState(false);
  const rulePaletteCacheRef = useRef(new ScriptPaletteCache());
  const graphDiagnostics = useMemo(
    () =>
      diagnostics.map((row) => ({
        nodeId: row.nodeId,
        pinId: row.pinId,
        severity: row.severity,
        message: row.message,
      })),
    [diagnostics],
  );
  const openTransition =
    openTransitionId
      ? (doc.transitions.find((row) => row.id === openTransitionId) ?? null)
      : null;
  const initialGraph = useMemo(() => {
    const graph = hydrateAnimGraphForEditor(animGraphToSerialized(doc));
    const clipLabels = new Map(
      doc.states.map((state) => [state.id, stateClipLabel(doc, state, catalog)]),
    );
    return {
      ...graph,
      nodes: graph.nodes.map((node) => ({
        ...node,
        data: { ...node.data, clipLabel: clipLabels.get(node.id) },
      })),
    };
  }, [doc, catalog]);
  // The wire of the transition the Inspector shows: a Both Ways pair is one wire under its first row's id.
  const selectedEdgeId = useMemo(() => {
    if (!selectedTransitionId) return undefined;
    const drawn = new Set(initialGraph.edges.map((edge) => edge.id));
    if (drawn.has(selectedTransitionId)) return selectedTransitionId;
    const row = doc.transitions.find((transition) => transition.id === selectedTransitionId);
    const reverse = row && findReverseTransition(doc.transitions, row.fromStateId, row.toStateId);
    return reverse && drawn.has(reverse.id) ? reverse.id : undefined;
  }, [doc.transitions, initialGraph.edges, selectedTransitionId]);
  const ruleMembers = useMemo(
    () => animGraphMembersFromVariables(doc.variables),
    [doc.variables],
  );
  const ruleGraph = useMemo(() => {
    if (!openTransition) return null;
    const oneWay = !findReverseTransition(
      doc.transitions,
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
  }, [doc.transitions, openTransition, ruleMembers, typeCatalog.schemas, dataAssets]);
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
    if (animEditorMode !== "stateMachine") return;
    const animRows: Diagnostic[] = validateAnimGraph(doc, catalog, { dimension }).map((row) => ({
      severity: row.severity,
      code: row.code,
      message: row.message,
      assetGuid: documentId,
      graphId: documentId,
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
    // This graph's rows (its State Machine, open rule, and Animation Object): Play and Compile rows for other assets stay.
    const path = parseDocumentId(documentId)?.path;
    setDiagnostics([...animRows, ...ruleRows], {
      replaces: (d) =>
        d.assetGuid === documentId || d.assetGuid === path ||
        d.graphId === documentId || d.graphId.startsWith(`${documentId}:`),
    });
  }, [
    activeDocumentId,
    animEditorMode,
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
        <div className="flex h-full min-h-0 flex-col" data-testid="anim-rule-graph">
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
              {transitionLabel(doc, openTransition)}
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
      <div className="anim-graph-canvas flex h-full min-h-0 flex-col" data-testid="anim-graph-editor">
        <GraphEditor
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
          onChange={(next) => {
            const keepSelection = selectedIds;
            queueMicrotask(() => {
              const updated = serializedToAnimGraph(next, latestDoc());
              const kept = keepSelection.filter((id) =>
                updated.states.some((state) => state.id === id),
              );
              if (kept.length !== keepSelection.length) setSelectedIds(kept);
              commit(updated);
            });
          }}
        />
      </div>
      {breakpointSettingsDialog}
    </PanelFrame>
  );
}

function transitionPropertyRows(
  doc: AnimGraphDocument,
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
    doc.states.find((state) => state.id === transition.toStateId)?.name ??
    transition.toStateId;
  const reverse = findReverseTransition(
    doc.transitions,
    transition.fromStateId,
    transition.toStateId,
  );
  return {
    title: titleFromSource
      ? transitionLabel(doc, transition)
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
  const { doc, commit, assetRegistry, catalog, graphGuid, assetName, dimension } = useAnimGraphDocument();
  const breakpointStore = useBreakpointStore();
  const {
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
  if (openTransitionId) {
    return <InspectorPanel {..._props} />;
  }
  const selectedStates = selectedIds.flatMap((id) => doc.states.find((state) => state.id === id) ?? []);
  // Several states show the rows they share; their names, entry and transitions stay per state.
  const multi = selectedStates.length > 1;
  const selected = selectedStates[0] ?? null;
  const edit = documentBatch(doc, commit);
  const selectedTransition =
    doc.transitions.find((row) => row.id === selectedTransitionId) ?? null;
  const clip = selected?.clipId
    ? doc.clips.find((row) => row.id === selected.clipId)
    : undefined;
  void clip;
  const clipKind: AnimClipKind = dimension === "2d" ? "sprite" : "animation";
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
  const outgoing = selected
    ? doc.transitions.filter((row) => row.fromStateId === selected.id)
    : selectedTransition
      ? [selectedTransition]
      : [];
  /** Sets a state's clip asset; an Animation brings its clip name, a Sprite Animation none. */
  const applyClipAsset = (stateId: string, guid: string) => {
    const current = edit.read();
    const state = current.states.find((row) => row.id === stateId);
    if (!state) return;
    const stateClip = state.clipId
      ? current.clips.find((row) => row.id === state.clipId)
      : undefined;
    const entry = catalog.find((row) => row.guid === guid);
    const nextName =
      (stateClip?.kind ?? "animation") === "animation" && entry?.type === "Animation"
        ? (entry.clipName ?? "")
        : "";
    edit.write(
      upsertStateClip(current, stateId, {
        kind: clipKind,
        assetGuid: guid,
        clipName: nextName,
        ...(typeof entry?.durationMs === "number"
          ? { durationMs: entry.durationMs }
          : {}),
      }),
    );
  };
  /** One state's Clip and Playback rows; they read and write through `edit`, so a batch changes every selected state at once. */
  const sharedStateRows = (state: AnimState): { clip: PropertyRow[]; playback: PropertyRow[] } => {
    const stateClip = state.clipId
      ? doc.clips.find((row) => row.id === state.clipId)
      : undefined;
    const kind = clipKind;
    return {
      clip: [
        {
          id: "clipAsset",
          kind: "asset",
          label: dimension === "2d" ? "Sprite Animation" : "Animation",
          value: stateClip?.assetGuid || null,
          placeholder: "None",
          // Several states share one Clip Asset only when they pick the same kind of clip.
          ...(multi ? { assetTypes: [kind === "sprite" ? "SpriteAnimation" : "Animation"] } : {}),
          onPick: () => setClipPick(true),
          onChange: (value) => applyClipAsset(state.id, value ?? ""),
          ...assetRowIdentity(
            stateClip?.assetGuid
              ? (() => {
                  const asset = assetRegistry?.getByGuid(stateClip.assetGuid);
                  return asset
                    ? { name: asset.header.name, type: asset.header.type }
                    : {
                        name: stateClip.assetGuid,
                        type:
                          kind === "sprite" ? "SpriteAnimation" : "Animation",
                      };
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
          value: state.speed,
          min: 0.001,
          onChange: (speed) =>
            edit.write(
              patchState(edit.read(), state.id, { speed }),
              `anim-graph:state:${state.id}:speed`,
            ),
        },
        {
          id: "loop",
          kind: "boolean",
          label: "Loop",
          value: state.loop,
          onChange: (loop) => edit.write(patchState(edit.read(), state.id, { loop })),
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
          value: doc.entryStateId === selected.id,
          onChange: (value) => {
            if (value) {
              commit({ ...doc, entryStateId: selected.id });
              return;
            }
            const other = doc.states.find((state) => state.id !== selected.id);
            if (other) commit({ ...doc, entryStateId: other.id });
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
    transitionPropertyRows(doc, transition, commit, !selected),
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
                        const flipped = next.transitions.find(
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
        allowedTypes={clipKind === "sprite" ? ["SpriteAnimation"] : ["Animation"]}
        title={
          clipKind === "sprite" ? "Pick Sprite Animation" : "Pick Animation"
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
