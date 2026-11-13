import type { GraphClassMember, SerializedGraph } from "@haptic/core";
import { normalizeTag, normalizeTagContainer } from "@haptic/core";
import {
  ANIM_FRAME_OUTPUT_TYPE,
  createStateGraph,
  isPoseClipNodeType,
  isPoseOutputType,
  type AnimPoseDimension,
} from "./pose-graph";

export const ANIM_EVENT_INITIALIZE_TYPE = "anim.event.initialize";
export const ANIM_EVENT_UPDATE_TYPE = "anim.event.update";
export const ANIM_RULE_ENTER_TYPE = "anim.rule.enterState";
export const ANIM_RULE_EXIT_TYPE = "anim.rule.exitState";
export const ANIM_RULE_ENTER_NODE_ID = "enter-state";
const ANIM_RULE_EXIT_NODE_ID = "exit-state";
/** Rule-graph query that fires when the clip crosses an exit time. */
export const ANIM_EXIT_TIME_REACHED_TYPE = "anim.state.exitTimeReached";

export type AnimClipKind = "animation" | "sprite";
export type AnimVariableTypeId = "bool" | "int" | "float" | "string" | "tag" | "struct";

/** A 3D graph plays Animations on its Skeleton and passes poses; a 2D graph plays Sprite Animations and passes frames. */
export type AnimGraphDimension = AnimPoseDimension;

export interface AnimState {
  id: string;
  name: string;
  /** Canvas layout. Parse fills a fallback when a document omits it. */
  position: { x: number; y: number };
  /** The state's pose (or frame) graph, ending in its protected Output Pose node. */
  stateGraph: SerializedGraph;
}

export interface AnimGraphVariable {
  id: string;
  name: string;
  typeId: AnimVariableTypeId;
  typeClassId?: string;
  defaultValue?: unknown;
}

export interface AnimTransition {
  /** Unique in the document: rule scripts are named by it. */
  id: string;
  fromStateId: string;
  toStateId: string;
  /** Crossfade in seconds. */
  blendSeconds: number;
  /** Lower numbers win when several transitions pass. */
  priority: number;
  ruleGraph: SerializedGraph;
  /** Canvas handle ids (`right-out` / `left-in`); missing ids draw on those default sides. */
  sourceHandle?: string;
  targetHandle?: string;
}

/** The graph's root: its states, the one it enters first, and the transitions between them. */
export interface AnimStateMachine {
  entryStateId: string;
  states: AnimState[];
  transitions: AnimTransition[];
}

export interface AnimGraphDocument {
  name: string;
  /**
   * 3D only: the Skeleton every Animation the graph plays must be on. Null plays Animations that have no Skeleton
   * (a rigid node animation such as a door). A 2D graph keeps it null.
   */
  skeletonGuid: string | null;
  variables: AnimGraphVariable[];
  stateMachine: AnimStateMachine;
  animationObject: SerializedGraph;
}

/** Where a graph sits in a document: the State Machine, a state's graph or a transition's rule. */
export type AnimGraphLocation =
  | { kind: "machine" }
  | { kind: "state"; stateId: string }
  | { kind: "rule"; transitionId: string };

/** The key a state graph's compiled data module and player clocks are filed under: the state's id. */
export function animPoseGraphKey(stateId: string): string {
  return stateId;
}

export interface AnimTransitionDecision {
  enter: boolean;
  exit: boolean;
}

/** A pose graph's computed data inputs: node id → pin name → value. */
export type AnimPoseData = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface AnimGraphInputs {
  transitionRules?: Record<string, AnimTransitionDecision>;
  decideTransition?: (
    transition: AnimTransition,
    facts: AnimStateFacts,
  ) => AnimTransitionDecision | undefined;
  /** The State Machine took `transition`, a self-transition included: at most one per evaluation. */
  transitionTaken?: (transition: AnimTransition) => void;
  /**
   * The wired data inputs of a state graph this tick (`animPoseGraphKey`), from its compiled module, given the facts
   * of its state (null when it is entered). Unlisted inputs use the values stored on their nodes.
   */
  poseData?: (graphKey: string, facts: AnimStateFacts | null) => AnimPoseData | undefined;
}

export interface AnimStateFacts {
  elapsedSeconds: number;
  durationSeconds: number;
  normalisedTime: number;
  remainingSeconds: number;
  remainingRatio: number;
  looping: boolean;
  loopCount: number;
  justLooped: boolean;
  justFinished: boolean;
  /**
   * Unwrapped clip position: completed loops plus `normalisedTime`. Equals
   * `normalisedTime` for non-looping states.
   */
  totalNormalisedTime: number;
  /** `totalNormalisedTime` before this tick advanced the clip (the start position on entering a state). */
  previousTotalNormalisedTime: number;
}

export interface AnimClipLayer {
  /** The state whose graph plays it. */
  stateId: string;
  clipAssetGuid: string;
  clipName: string;
  clipKind: AnimClipKind;
  normalisedTime: number;
  weight: number;
  /** 2D: Flip Frame mirrors the frame. */
  flipX?: boolean;
  flipY?: boolean;
}

/** The State Machine's evaluation: its active state, the state's clock and the blend in progress. */
export interface AnimMachineEvalState {
  stateId: string;
  normalisedTime: number;
  blendWeights: Record<string, number>;
  timeMs: number;
  facts: AnimStateFacts;
  blendFromStateId: string | null;
  blendElapsedMs: number;
  /** Crossfade length of the transition that started the active blend. */
  blendSeconds: number;
  loopCount: number;
}

/** A player's own clock. */
export interface AnimPlayerClock {
  timeMs: number;
  loopCount: number;
  normalised: number;
}

/** The whole graph's evaluation: the State Machine's, with its players, selectors and clip layers. */
export interface AnimEvalState extends AnimMachineEvalState {
  /** Player clocks by `graphKey#nodeId`. */
  players: Record<string, AnimPlayerClock>;
  /** Blend Poses By Bool / Int input weights by `graphKey#nodeId`. */
  selectors: Record<string, number[]>;
  layers: AnimClipLayer[];
}

export interface AnimDiagnostic {
  code: string;
  message: string;
  nodeId?: string;
  /** The graph the node is in; absent means the State Machine. */
  location?: AnimGraphLocation;
  severity: "error" | "warning";
}

export function animGraphScriptClassId(guid: string): string {
  return `AnimGraph:${guid}`;
}

export function animRuleScriptClassId(
  guid: string,
  transitionId: string,
): string {
  return `AnimRule:${guid}:${transitionId}`;
}

/** A pose graph's compiled data module (`animPoseGraphKey`). */
export function animPoseScriptClassId(guid: string, graphKey: string): string {
  return `AnimPose:${guid}:${graphKey}`;
}

const ANIM_STATE_LAYOUT_ORIGIN = { x: 80, y: 80 };
export const ANIM_STATE_LAYOUT_GAP_X = 280;

export function defaultAnimStatePosition(index: number): { x: number; y: number } {
  return {
    x: ANIM_STATE_LAYOUT_ORIGIN.x + index * ANIM_STATE_LAYOUT_GAP_X,
    y: ANIM_STATE_LAYOUT_ORIGIN.y,
  };
}

export function defaultAnimVariableValue(
  typeId: AnimVariableTypeId,
  typeClassId = "engine:TagContainer",
): unknown {
  switch (typeId) {
    case "bool":
      return false;
    case "int":
    case "tag":
      return 0;
    case "float":
      return 0;
    case "string":
      return "";
    case "struct":
      return typeClassId === "engine:TagContainer" ? { Tags: [] } : {};
  }
}

export function animGraphMembersFromVariables(
  variables: readonly AnimGraphVariable[],
): GraphClassMember[] {
  return variables.map((variable) => ({
    id: variable.id,
    kind: "variable",
    name: variable.name,
    typeId: variable.typeId,
    ...(variable.typeClassId ? { typeClassId: variable.typeClassId } : {}),
    defaultValue: variable.defaultValue,
  }));
}

export function createDefaultAnimationObjectGraph(): SerializedGraph {
  return {
    nodes: [
      {
        id: "event-initialize",
        type: ANIM_EVENT_INITIALIZE_TYPE,
        position: { x: 80, y: 80 },
        data: {
          title: "Event Initialize Animation",
          __protected: true,
        },
      },
      {
        id: "event-update",
        type: ANIM_EVENT_UPDATE_TYPE,
        position: { x: 80, y: 240 },
        data: {
          title: "Event Update Animation",
          __protected: true,
        },
      },
    ],
    edges: [],
  };
}

export function createDefaultTransitionRuleGraph(): SerializedGraph {
  return {
    nodes: [
      {
        id: ANIM_RULE_ENTER_NODE_ID,
        type: ANIM_RULE_ENTER_TYPE,
        position: { x: 360, y: 40 },
        data: {
          title: "Enter State",
          __protected: true,
        },
      },
      {
        id: ANIM_RULE_EXIT_NODE_ID,
        type: ANIM_RULE_EXIT_TYPE,
        position: { x: 360, y: 180 },
        data: {
          title: "Exit State",
          __protected: true,
        },
      },
    ],
    edges: [],
  };
}

/** A new graph: a State Machine whose Idle state plays one (unset) clip. */
export function createDefaultAnimGraph(
  name = "Locomotion",
  options: { dimension?: AnimGraphDimension; skeletonGuid?: string | null } = {},
): AnimGraphDocument {
  const dimension = options.dimension ?? "3d";
  return {
    name,
    skeletonGuid: dimension === "3d" ? options.skeletonGuid ?? null : null,
    variables: [],
    stateMachine: {
      entryStateId: "idle",
      states: [{ id: "idle", name: "Idle", position: defaultAnimStatePosition(0), stateGraph: createStateGraph(dimension) }],
      transitions: [],
    },
    animationObject: createDefaultAnimationObjectGraph(),
  };
}

/** A graph's dimension, read from its state graphs' outputs (3D unless one says frame). */
export function animGraphDimension(doc: Pick<AnimGraphDocument, "stateMachine">): AnimGraphDimension {
  return doc.stateMachine.states.some((state) => state.stateGraph.nodes.some((node) => node.type === ANIM_FRAME_OUTPUT_TYPE))
    ? "2d"
    : "3d";
}

export function decorateTransitionRuleGraph(
  graph: SerializedGraph,
  oneWay: boolean,
): SerializedGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.type !== ANIM_RULE_EXIT_TYPE) {
        if (node.data.__disabled !== true) return node;
        const data = { ...node.data };
        delete data.__disabled;
        return { ...node, data };
      }
      if (oneWay) {
        return {
          ...node,
          data: { ...node.data, __disabled: true },
        };
      }
      if (node.data.__disabled !== true) return node;
      const data = { ...node.data };
      delete data.__disabled;
      return { ...node, data };
    }),
  };
}

/** Drop canvas-only `__disabled` so rule documents stay undecorated. */
export function persistTransitionRuleGraph(
  graph: SerializedGraph,
): SerializedGraph {
  const stripped = decorateTransitionRuleGraph(graph, false);
  return { nodes: stripped.nodes, edges: stripped.edges };
}

/** Every state graph in the document with its key and location. */
export function animPoseGraphs(doc: AnimGraphDocument): Array<{
  key: string;
  graph: SerializedGraph;
  location: { kind: "state"; stateId: string };
}> {
  return doc.stateMachine.states.map((state) => ({
    key: animPoseGraphKey(state.id),
    graph: state.stateGraph,
    location: { kind: "state", stateId: state.id },
  }));
}

/** Replace the State Machine. */
export function patchStateMachine(
  doc: AnimGraphDocument,
  patch: (machine: AnimStateMachine) => AnimStateMachine,
): AnimGraphDocument {
  return { ...doc, stateMachine: patch(doc.stateMachine) };
}

/** Replace one state's graph. */
export function patchStateGraph(
  doc: AnimGraphDocument,
  stateId: string,
  graph: SerializedGraph,
): AnimGraphDocument {
  return patchStateMachine(doc, (machine) => ({
    ...machine,
    states: machine.states.map((state) => (state.id === stateId ? { ...state, stateGraph: graph } : state)),
  }));
}

/** Asset index used to bind animation clips to Play. */
export interface AnimClipCatalogEntry {
  guid: string;
  type: string;
  name: string;
  clipName?: string;
  dependencyGuids?: string[];
  /** Sprite Animation or Animation clip duration. */
  durationMs?: number;
  /** Sprite Animation frame count, for a player's Start Frame. */
  frameCount?: number;
  skeletonGuid?: string | null;
  modelGuid?: string;
}

function locationName(doc: AnimGraphDocument, location: AnimGraphLocation): string {
  if (location.kind === "machine") return "The State Machine";
  if (location.kind === "rule") return "A transition rule";
  const state = doc.stateMachine.states.find((entry) => entry.id === location.stateId);
  return `State "${state?.name ?? location.stateId}"`;
}

export function validateAnimGraph(
  doc: AnimGraphDocument,
  catalog: readonly AnimClipCatalogEntry[] = [],
  options: { dimension?: AnimGraphDimension } = {},
): AnimDiagnostic[] {
  const diagnostics: AnimDiagnostic[] = [];
  const seenVariables = new Map<string, string>();
  for (const variable of doc.variables) {
    const key = variable.name.trim().toLowerCase();
    const previous = seenVariables.get(key);
    if (previous) {
      diagnostics.push({
        code: "anim.duplicateVariable",
        message: `Variable "${variable.name}" duplicates "${previous}"`,
        nodeId: variable.id,
        severity: "error",
      });
    } else {
      seenVariables.set(key, variable.name);
    }
  }

  diagnostics.push(...validateStateMachine(doc.stateMachine));

  // Pose graphs: their output, and the clips their players name.
  const byGuid = new Map(catalog.map((entry) => [entry.guid, entry]));
  for (const { graph, location } of animPoseGraphs(doc)) {
    const outputs = graph.nodes.filter((node) => isPoseOutputType(node.type));
    if (outputs.length !== 1) {
      diagnostics.push({
        code: "anim.missingOutput",
        message: `${locationName(doc, location)} needs exactly one ${animGraphDimension(doc) === "2d" ? "Output Frame" : "Output Pose"} node`,
        nodeId: location.stateId,
        location: { kind: "machine" },
        severity: "error",
      });
    }
    for (const node of graph.nodes) {
      if (!isPoseClipNodeType(node.type)) continue;
      const assetGuid = typeof node.data.assetGuid === "string" ? node.data.assetGuid : "";
      if (!assetGuid) continue;
      diagnostics.push(...clipDiagnostics(doc, byGuid, node.id, node.type, assetGuid, location, options.dimension));
    }
  }
  return diagnostics;
}

function validateStateMachine(machine: AnimStateMachine): AnimDiagnostic[] {
  const diagnostics: AnimDiagnostic[] = [];
  const location: AnimGraphLocation = { kind: "machine" };
  const transitionIds = new Set<string>();
  const stateIds = new Set(machine.states.map((state) => state.id));
  if (!stateIds.has(machine.entryStateId)) {
    diagnostics.push({
      code: "anim.missingEntry",
      message: `Entry state "${machine.entryStateId}" is not in the State Machine`,
      nodeId: machine.entryStateId,
      location,
      severity: "error",
    });
  }
  const stateNames = new Map<string, string>();
  for (const state of machine.states) {
    const name = state.name.trim();
    const key = name.toLowerCase();
    if (!name) {
      diagnostics.push({ code: "anim.emptyStateName", message: "State names cannot be empty", nodeId: state.id, location, severity: "error" });
    } else if (stateNames.has(key)) {
      diagnostics.push({ code: "anim.duplicateStateName", message: `State "${state.name}" duplicates "${stateNames.get(key)}". Choose a unique name.`, nodeId: state.id, location, severity: "error" });
    } else {
      stateNames.set(key, name);
    }
  }
  const stateNameById = new Map(machine.states.map((state) => [state.id, state.name]));
  const firstByPair = new Map<string, string>();
  for (const transition of machine.transitions) {
    if (transitionIds.has(transition.id)) {
      diagnostics.push({ code: "anim.duplicateTransitionId", message: `Transition id "${transition.id}" is used twice`, nodeId: transition.fromStateId, location, severity: "error" });
    }
    transitionIds.add(transition.id);
    const pair = `${transition.fromStateId}\u0000${transition.toStateId}`;
    const first = firstByPair.get(pair);
    if (first === undefined) {
      firstByPair.set(pair, transition.id);
    } else {
      const from = stateNameById.get(transition.fromStateId) ?? transition.fromStateId;
      const to = stateNameById.get(transition.toStateId) ?? transition.toStateId;
      // The hidden duplicate has no canvas edge, so point at its source state.
      diagnostics.push({
        code: "anim.duplicateTransition",
        message: `Transition "${transition.id}" duplicates "${first}" from "${from}" to "${to}". The canvas shows one; priority decides which runs.`,
        nodeId: transition.fromStateId,
        location,
        severity: "warning",
      });
    }
    if (!stateIds.has(transition.fromStateId) || !stateIds.has(transition.toStateId)) {
      diagnostics.push({ code: "anim.badTransition", message: `Transition "${transition.id}" points at a missing state`, nodeId: transition.id, location, severity: "error" });
    }
    const enter = transition.ruleGraph.nodes.filter((node) => node.type === ANIM_RULE_ENTER_TYPE);
    const exit = transition.ruleGraph.nodes.filter((node) => node.type === ANIM_RULE_EXIT_TYPE);
    if (enter.length === 0 || exit.length === 0) {
      diagnostics.push({ code: "anim.missingRuleNode", message: `Transition "${transition.id}" needs Enter State and Exit State nodes`, nodeId: transition.id, location, severity: "error" });
    }
    if (enter.length > 1 || exit.length > 1) {
      diagnostics.push({ code: "anim.duplicateRuleNode", message: `Transition "${transition.id}" has duplicate Enter State or Exit State nodes`, nodeId: transition.id, location, severity: "error" });
    }
  }
  return diagnostics;
}

/**
 * A 3D graph plays Animations on its own Skeleton (null matches Animations with no Skeleton) and a 2D graph Sprite
 * Animations; an Animation must also be on its Model's Skeleton.
 */
function clipDiagnostics(
  doc: AnimGraphDocument,
  byGuid: ReadonlyMap<string, AnimClipCatalogEntry>,
  nodeId: string,
  nodeType: string,
  assetGuid: string,
  location: AnimGraphLocation,
  dimension: AnimGraphDimension | undefined,
): AnimDiagnostic[] {
  const diagnostics: AnimDiagnostic[] = [];
  const entry = byGuid.get(assetGuid);
  const name = entry?.name ?? assetGuid;
  const sprite = nodeType.startsWith("anim.frame.");
  if (entry && (sprite ? entry.type !== "SpriteAnimation" : entry.type !== "Animation")) {
    diagnostics.push({
      code: "anim.clipKind",
      message: sprite
        ? `"${name}" is not a Sprite Animation; a 2D Animation Graph plays Sprite Animations only`
        : `"${name}" is not an Animation; a 3D Animation Graph plays Animations only`,
      nodeId,
      location,
      severity: "error",
    });
    return diagnostics;
  }
  if (!entry || entry.type !== "Animation") return diagnostics;
  if (dimension === "3d" && (entry.skeletonGuid ?? null) !== doc.skeletonGuid) {
    diagnostics.push({ code: "anim.clipSkeleton", message: `Animation "${name}" is not on the graph's Skeleton`, nodeId, location, severity: "error" });
  }
  const model = entry.modelGuid ? byGuid.get(entry.modelGuid) : undefined;
  if (entry.skeletonGuid && model?.type === "Model" && model.skeletonGuid && model.skeletonGuid !== entry.skeletonGuid) {
    diagnostics.push({
      code: "anim.skeletonMismatch",
      message: `Animation "${entry.name}" skeleton does not match Model "${model.name}"`,
      nodeId,
      location,
      severity: "error",
    });
  }
  return diagnostics;
}

/**
 * Unity-style exit time: true on the tick the clip crosses `exitTime`.
 *
 * - Looping, `exitTime <= 1`: fires each loop as the clip passes
 *   `exitTime`, `exitTime + 1`, …; `1` fires at every loop completion and `0`
 *   on entering the state and at every wrap.
 * - Looping, `exitTime > 1`: fires once, when the unwrapped time passes it.
 * - Non-looping: `normalisedTime >= exitTime` (clamped at 1), so it stays true
 *   once reached.
 */
export function animExitTimeReached(
  facts: AnimStateFacts,
  exitTime: number,
): boolean {
  const threshold = Number.isFinite(exitTime) ? Math.max(0, exitTime) : 0;
  if (!facts.looping) return facts.normalisedTime >= threshold;
  const from = facts.previousTotalNormalisedTime;
  const to = facts.totalNormalisedTime;
  if (threshold === 0 && from === 0) return true;
  if (threshold > 1) return from < threshold && threshold <= to;
  return Math.floor(to - threshold) > Math.floor(from - threshold);
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parsePosition(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const x = asFiniteNumber(row.x, Number.NaN);
  const y = asFiniteNumber(row.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function isSerializedGraph(value: unknown): value is SerializedGraph {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return Array.isArray(row.nodes) && Array.isArray(row.edges);
}

function copyGraph(graph: SerializedGraph): SerializedGraph {
  return {
    nodes: graph.nodes.map((node) => ({ ...node, data: { ...node.data } })),
    edges: graph.edges.map((edge) => ({ ...edge })),
  };
}

function parseVariableType(value: unknown, typeClassId?: unknown): AnimVariableTypeId {
  if (value === "struct" && typeClassId === "engine:TagContainer") return "struct";
  if (value === "int" || value === "float" || value === "string" || value === "bool" || value === "tag") {
    return value;
  }
  return "bool";
}

function parseVariables(
  source: Record<string, unknown>,
): AnimGraphVariable[] {
  const variables: AnimGraphVariable[] = [];
  if (Array.isArray(source.variables)) {
    for (const row of source.variables) {
      if (!row || typeof row !== "object") continue;
      const variable = row as Record<string, unknown>;
      const name =
        typeof variable.name === "string" && variable.name.trim() !== ""
          ? variable.name.trim()
          : "";
      if (name === "") continue;
      const id =
        typeof variable.id === "string" && variable.id !== ""
          ? variable.id
          : `var-${name}`;
      const typeId = parseVariableType(variable.typeId, variable.typeClassId);
      variables.push({
        id,
        name,
        typeId,
        ...(typeId === "struct" ? { typeClassId: "engine:TagContainer" } : {}),
        defaultValue:
          typeId === "tag" ? normalizeTag(variable.defaultValue) :
          typeId === "struct" ? normalizeTagContainer(variable.defaultValue) :
          variable.defaultValue !== undefined
            ? variable.defaultValue
            : defaultAnimVariableValue(typeId),
      });
    }
  }
  return variables;
}

function parseRuleGraph(value: unknown): SerializedGraph {
  return isSerializedGraph(value) && value.nodes.length > 0 ? copyGraph(value) : createDefaultTransitionRuleGraph();
}

function parseAnimationObject(value: unknown): SerializedGraph {
  return isSerializedGraph(value) && value.nodes.length > 0 ? copyGraph(value) : createDefaultAnimationObjectGraph();
}

/** A pose graph as stored, or a new one with its output when the document lost it. */
function parsePoseGraph(value: unknown, fallback: () => SerializedGraph): SerializedGraph {
  return isSerializedGraph(value) && value.nodes.length > 0 ? copyGraph(value) : fallback();
}

/** A State Machine card's nominal size, for the sides two states face each other on. */
const ANIM_STATE_CARD = { width: 200, height: 90 };

/**
 * The sides a transition stored without them uses: where its two states face each other, so a pair stored both
 * ways without sides mirrors and shares one wire.
 */
export function facingTransitionSides(
  from: Pick<AnimState, "position"> | undefined,
  to: Pick<AnimState, "position"> | undefined,
): { sourceHandle: string; targetHandle: string } {
  const dx = (to?.position.x ?? 1) - (from?.position.x ?? 0);
  const dy = (to?.position.y ?? 0) - (from?.position.y ?? 0);
  if (Math.abs(dx) / ANIM_STATE_CARD.width >= Math.abs(dy) / ANIM_STATE_CARD.height) {
    return dx >= 0 ? { sourceHandle: "right-out", targetHandle: "left-in" } : { sourceHandle: "left-out", targetHandle: "right-in" };
  }
  return dy >= 0 ? { sourceHandle: "bottom-out", targetHandle: "top-in" } : { sourceHandle: "top-out", targetHandle: "bottom-in" };
}

function parseTransitions(value: unknown, states: readonly AnimState[]): AnimTransition[] {
  const transitions: AnimTransition[] = [];
  if (!Array.isArray(value)) return transitions;
  const byId = new Map(states.map((state) => [state.id, state]));
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const transition = row as Record<string, unknown>;
    if (typeof transition.id !== "string") continue;
    if (typeof transition.fromStateId !== "string") continue;
    if (typeof transition.toStateId !== "string") continue;
    const facing = facingTransitionSides(byId.get(transition.fromStateId), byId.get(transition.toStateId));
    transitions.push({
      id: transition.id,
      fromStateId: transition.fromStateId,
      toStateId: transition.toStateId,
      blendSeconds: asFiniteNumber(transition.blendSeconds, 0.1),
      priority: asFiniteNumber(transition.priority, 0),
      ruleGraph: parseRuleGraph(transition.ruleGraph),
      sourceHandle: typeof transition.sourceHandle === "string" ? transition.sourceHandle : facing.sourceHandle,
      targetHandle: typeof transition.targetHandle === "string" ? transition.targetHandle : facing.targetHandle,
    });
  }
  return transitions;
}

/** The dimension stored state graphs say: 2D when any ends in Output Frame. */
function storedDimension(states: unknown): AnimGraphDimension {
  if (!Array.isArray(states)) return "3d";
  return states.some((row) => {
    const graph = row && typeof row === "object" ? (row as Record<string, unknown>).stateGraph : undefined;
    return isSerializedGraph(graph) && graph.nodes.some((node) => node?.type === ANIM_FRAME_OUTPUT_TYPE);
  }) ? "2d" : "3d";
}

function parseStateMachine(value: unknown, dimension: AnimGraphDimension): AnimStateMachine {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const states: AnimState[] = [];
  if (Array.isArray(source.states)) {
    for (const row of source.states) {
      if (!row || typeof row !== "object") continue;
      const state = row as Record<string, unknown>;
      if (typeof state.id !== "string" || state.id === "") continue;
      states.push({
        id: state.id,
        name: typeof state.name === "string" && state.name !== "" ? state.name : state.id,
        position: parsePosition(state.position) ?? defaultAnimStatePosition(states.length),
        stateGraph: parsePoseGraph(state.stateGraph, () => createStateGraph(dimension)),
      });
    }
  }
  const entryStateId =
    typeof source.entryStateId === "string" && states.some((state) => state.id === source.entryStateId)
      ? source.entryStateId
      : states[0]?.id ?? "";
  return {
    entryStateId,
    states,
    transitions: parseTransitions(source.transitions, states),
  };
}

/**
 * A stored Animation Graph, or null when `value` has no State Machine. `dimension` (the asset type's) fills a state
 * graph a state lost; without it, the stored state graphs say.
 */
export function parseAnimGraphDocument(
  value: unknown,
  dimension?: AnimGraphDimension,
): AnimGraphDocument | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const machine = source.stateMachine;
  if (!machine || typeof machine !== "object") return null;
  return {
    name: typeof source.name === "string" && source.name !== "" ? source.name : "Locomotion",
    skeletonGuid: typeof source.skeletonGuid === "string" && source.skeletonGuid.trim() !== "" ? source.skeletonGuid.trim() : null,
    variables: parseVariables(source),
    stateMachine: parseStateMachine(machine, dimension ?? storedDimension((machine as Record<string, unknown>).states)),
    animationObject: parseAnimationObject(source.animationObject),
  };
}

function resolvePoseGraphClips(
  graph: SerializedGraph,
  byGuid: ReadonlyMap<string, AnimClipCatalogEntry>,
): SerializedGraph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (!isPoseClipNodeType(node.type)) return node;
    const entry = typeof node.data.assetGuid === "string" ? byGuid.get(node.data.assetGuid) : undefined;
    if (!entry) return node;
    const sprite = node.type.startsWith("anim.frame.");
    // Clips are Animation or Sprite Animation assets; any other guid resolves to nothing and plays nothing.
    if (sprite ? entry.type !== "SpriteAnimation" : entry.type !== "Animation") return node;
    const clipName = sprite ? "" : entry.clipName ?? "";
    const durationMs = typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) && entry.durationMs > 0
      ? entry.durationMs
      : undefined;
    const frameCount = sprite && typeof entry.frameCount === "number" && entry.frameCount > 0 ? entry.frameCount : undefined;
    if (node.data.clipName === clipName && node.data.durationMs === durationMs && node.data.frameCount === frameCount) return node;
    changed = true;
    const data: Record<string, unknown> = { ...node.data, clipName };
    if (durationMs !== undefined) data.durationMs = durationMs; else delete data.durationMs;
    if (frameCount !== undefined) data.frameCount = frameCount; else delete data.frameCount;
    return { ...node, data };
  });
  return changed ? { ...graph, nodes } : graph;
}

/** Fill each player's clip name, length and frame count from the catalog. Keep Animation guids. */
export function resolveAnimGraphClips(
  doc: AnimGraphDocument,
  catalog: readonly AnimClipCatalogEntry[],
): AnimGraphDocument {
  if (catalog.length === 0) return doc;
  const byGuid = new Map(catalog.map((entry) => [entry.guid, entry]));
  let changed = false;
  const states = doc.stateMachine.states.map((state) => {
    const stateGraph = resolvePoseGraphClips(state.stateGraph, byGuid);
    if (stateGraph === state.stateGraph) return state;
    changed = true;
    return { ...state, stateGraph };
  });
  return changed ? { ...doc, stateMachine: { ...doc.stateMachine, states } } : doc;
}
