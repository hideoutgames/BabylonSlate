import type { GraphClassMember, SerializedGraph } from "@haptic/core";
import { normalizeTag, normalizeTagContainer } from "@haptic/core";

export const ANIM_GRAPH_SCHEMA_VERSION = 2 as const;

export const ANIM_EVENT_INITIALIZE_TYPE = "anim.event.initialize";
export const ANIM_EVENT_UPDATE_TYPE = "anim.event.update";
export const ANIM_RULE_ENTER_TYPE = "anim.rule.enterState";
export const ANIM_RULE_EXIT_TYPE = "anim.rule.exitState";
export const ANIM_RULE_ENTER_NODE_ID = "enter-state";
export const ANIM_RULE_EXIT_NODE_ID = "exit-state";
/** Rule-graph query that fires when the clip crosses an exit time. */
export const ANIM_EXIT_TIME_REACHED_TYPE = "anim.state.exitTimeReached";

export type AnimClipKind = "animation" | "sprite";
export type AnimVariableTypeId = "bool" | "int" | "float" | "string" | "tag" | "struct";

export interface AnimClipRef {
  id: string;
  kind: AnimClipKind;
  /** Animation (glTF clip) or Sprite Animation asset guid. */
  assetGuid: string;
  /** glTF AnimationGroup name or sprite clip name. */
  clipName: string;
  durationMs: number;
}

export interface AnimState {
  id: string;
  name: string;
  clipId: string | null;
  /** Speed multiplier; 1 is authored duration. */
  speed: number;
  loop: boolean;
  /** Canvas layout. Parse fills a fallback when a document omits it. */
  position: { x: number; y: number };
}

export interface AnimGraphVariable {
  id: string;
  name: string;
  typeId: AnimVariableTypeId;
  typeClassId?: string;
  defaultValue?: unknown;
}

export interface AnimTransition {
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

export interface AnimGraphDocument {
  schemaVersion: typeof ANIM_GRAPH_SCHEMA_VERSION;
  name: string;
  entryStateId: string;
  states: AnimState[];
  transitions: AnimTransition[];
  clips: AnimClipRef[];
  variables: AnimGraphVariable[];
  animationObject: SerializedGraph;
}

export interface AnimTransitionDecision {
  enter: boolean;
  exit: boolean;
}

export interface AnimGraphInputs {
  transitionRules?: Record<string, AnimTransitionDecision>;
  decideTransition?: (
    transition: AnimTransition,
    facts: AnimStateFacts,
  ) => AnimTransitionDecision | undefined;
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
  /** `totalNormalisedTime` before this tick advanced the clip (0 on entering a state). */
  previousTotalNormalisedTime: number;
}

export interface AnimClipLayer {
  stateId: string;
  clipAssetGuid: string;
  clipName: string;
  clipKind: AnimClipKind;
  normalisedTime: number;
  weight: number;
}

export interface AnimEvalState {
  stateId: string;
  normalisedTime: number;
  blendWeights: Record<string, number>;
  timeMs: number;
  facts: AnimStateFacts;
  layers: AnimClipLayer[];
  blendFromStateId: string | null;
  blendFromTimeMs: number;
  blendElapsedMs: number;
  /** Crossfade length of the transition that started the active blend. */
  blendSeconds: number;
  loopCount: number;
}

export interface AnimDiagnostic {
  code: string;
  message: string;
  nodeId?: string;
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

export const ANIM_STATE_LAYOUT_ORIGIN = { x: 80, y: 80 };
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

export function createDefaultAnimGraph(name = "Locomotion"): AnimGraphDocument {
  const idle: AnimState = {
    id: "idle",
    name: "Idle",
    clipId: "idle-clip",
    speed: 1,
    loop: true,
    position: defaultAnimStatePosition(0),
  };
  return {
    schemaVersion: ANIM_GRAPH_SCHEMA_VERSION,
    name,
    entryStateId: idle.id,
    states: [idle],
    transitions: [],
    clips: [
      {
        id: "idle-clip",
        kind: "animation",
        assetGuid: "",
        clipName: "Idle",
        durationMs: 1000,
      },
    ],
    variables: [],
    animationObject: createDefaultAnimationObjectGraph(),
  };
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

export function validateAnimGraph(
  doc: AnimGraphDocument,
  catalog: readonly AnimClipCatalogEntry[] = [],
): AnimDiagnostic[] {
  const diagnostics: AnimDiagnostic[] = [];
  const stateIds = new Set(doc.states.map((state) => state.id));
  const clipIds = new Set(doc.clips.map((clip) => clip.id));
  if (!stateIds.has(doc.entryStateId)) {
    diagnostics.push({
      code: "anim.missingEntry",
      message: `Entry state "${doc.entryStateId}" is not in the graph`,
      nodeId: doc.entryStateId,
      severity: "error",
    });
  }
  const stateNames = new Map<string, string>();
  for (const state of doc.states) {
    const name = state.name.trim();
    const key = name.toLowerCase();
    if (!name) {
      diagnostics.push({ code: "anim.emptyStateName", message: "State names cannot be empty", nodeId: state.id, severity: "error" });
    } else if (stateNames.has(key)) {
      diagnostics.push({ code: "anim.duplicateStateName", message: `State "${state.name}" duplicates "${stateNames.get(key)}". Choose a unique name.`, nodeId: state.id, severity: "error" });
    } else {
      stateNames.set(key, name);
    }
    if (state.clipId && !clipIds.has(state.clipId)) {
      diagnostics.push({
        code: "anim.missingClip",
        message: `State "${state.name}" references unknown clip "${state.clipId}"`,
        nodeId: state.id,
        severity: "error",
      });
    }
  }
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
  const stateNameById = new Map(doc.states.map((state) => [state.id, state.name]));
  const firstByPair = new Map<string, string>();
  for (const transition of doc.transitions) {
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
        severity: "warning",
      });
    }
    if (!stateIds.has(transition.fromStateId) || !stateIds.has(transition.toStateId)) {
      diagnostics.push({
        code: "anim.badTransition",
        message: `Transition "${transition.id}" points at a missing state`,
        nodeId: transition.id,
        severity: "error",
      });
    }
    const enter = transition.ruleGraph.nodes.filter(
      (node) => node.type === ANIM_RULE_ENTER_TYPE,
    );
    const exit = transition.ruleGraph.nodes.filter(
      (node) => node.type === ANIM_RULE_EXIT_TYPE,
    );
    if (enter.length === 0 || exit.length === 0) {
      diagnostics.push({
        code: "anim.missingRuleNode",
        message: `Transition "${transition.id}" needs Enter State and Exit State nodes`,
        nodeId: transition.id,
        severity: "error",
      });
    }
    if (enter.length > 1 || exit.length > 1) {
      diagnostics.push({
        code: "anim.duplicateRuleNode",
        message: `Transition "${transition.id}" has duplicate Enter State or Exit State nodes`,
        nodeId: transition.id,
        severity: "error",
      });
    }
  }
  const byGuid = new Map(catalog.map((entry) => [entry.guid, entry]));
  for (const clip of doc.clips) {
    if (clip.kind !== "animation" || !clip.assetGuid) continue;
    const entry = byGuid.get(clip.assetGuid);
    if (!entry || entry.type !== "Animation") continue;
    const animationSkeleton = entry.skeletonGuid;
    const model = entry.modelGuid ? byGuid.get(entry.modelGuid) : undefined;
    if (
      !animationSkeleton ||
      !model ||
      model.type !== "Model" ||
      !model.skeletonGuid ||
      model.skeletonGuid === animationSkeleton
    ) {
      continue;
    }
    diagnostics.push({
      code: "anim.skeletonMismatch",
      message: `Animation "${entry.name}" skeleton does not match Model "${model.name}"`,
      nodeId: clip.id,
      severity: "error",
    });
  }
  return diagnostics;
}

const NO_TRANSITIONS: readonly AnimTransition[] = [];

interface AnimGraphIndex {
  /** Later duplicate ids win, as with any `new Map(entries)`. */
  states: Map<string, AnimState>;
  clips: Map<string, AnimClipRef>;
  /** Outgoing transitions per source state in priority order, then document order. */
  outgoing: Map<string, readonly AnimTransition[]>;
  /** Clip of the first state with each id, which is what `clipForState` returns. */
  clipByStateId: Map<string, AnimClipRef | undefined>;
}

/**
 * Derived once per document object. Loaded documents are replaced rather than
 * mutated, so the result stays valid for the document's lifetime. Callers
 * treat the maps as read-only.
 */
const animGraphIndexes = new WeakMap<AnimGraphDocument, AnimGraphIndex>();

function animGraphIndex(doc: AnimGraphDocument): AnimGraphIndex {
  let index = animGraphIndexes.get(doc);
  if (!index) {
    index = buildAnimGraphIndex(doc);
    animGraphIndexes.set(doc, index);
  }
  return index;
}

function buildAnimGraphIndex(doc: AnimGraphDocument): AnimGraphIndex {
  const states = new Map(doc.states.map((state) => [state.id, state]));
  const clips = new Map(doc.clips.map((clip) => [clip.id, clip]));
  const firstClips = new Map<string, AnimClipRef>();
  for (const clip of doc.clips) if (!firstClips.has(clip.id)) firstClips.set(clip.id, clip);
  const clipByStateId = new Map<string, AnimClipRef | undefined>();
  for (const state of doc.states) {
    if (clipByStateId.has(state.id)) continue;
    clipByStateId.set(state.id, state.clipId ? firstClips.get(state.clipId) : undefined);
  }
  const grouped = new Map<string, Array<{ row: AnimTransition; index: number }>>();
  doc.transitions.forEach((row, index) => {
    const group = grouped.get(row.fromStateId);
    if (group) group.push({ row, index });
    else grouped.set(row.fromStateId, [{ row, index }]);
  });
  const outgoing = new Map<string, readonly AnimTransition[]>();
  for (const [stateId, entries] of grouped) {
    entries.sort((a, b) => {
      const priority = a.row.priority - b.row.priority;
      return priority !== 0 ? priority : a.index - b.index;
    });
    outgoing.set(stateId, entries.map((entry) => entry.row));
  }
  return { states, clips, outgoing, clipByStateId };
}

function clipDurationMs(
  state: AnimState,
  clips: Map<string, AnimClipRef>,
): number {
  const clip = state.clipId ? clips.get(state.clipId) : undefined;
  return Math.max(1, (clip?.durationMs ?? 1000) / Math.max(0.001, state.speed));
}

/** Seconds a state's clock advances in a tick: a state at Speed 0 or below holds its pose. */
function clockStepSeconds(state: AnimState, dtSeconds: number): number {
  return state.speed > 0 ? dtSeconds : 0;
}

function advanceClock(
  previousTimeMs: number,
  previousLoopCount: number,
  previousNormalised: number,
  dtSeconds: number,
  durationMs: number,
  loop: boolean,
): {
  timeMs: number;
  normalised: number;
  loopCount: number;
  justLooped: boolean;
  justFinished: boolean;
} {
  const dtMs = Number.isFinite(dtSeconds) ? Math.max(0, dtSeconds) * 1000 : 0;
  let timeMs = previousTimeMs + dtMs;
  if (loop) {
    let loopsGained = 0;
    while (timeMs >= durationMs) {
      timeMs -= durationMs;
      loopsGained += 1;
      if (loopsGained > 100_000) {
        timeMs = timeMs % durationMs;
        break;
      }
    }
    const normalised = timeMs / durationMs;
    return {
      timeMs,
      normalised,
      loopCount: previousLoopCount + loopsGained,
      justLooped: loopsGained > 0,
      justFinished: false,
    };
  }
  const rawNorm = timeMs / durationMs;
  const finished = rawNorm >= 1;
  const normalised = Math.min(1, rawNorm);
  return {
    timeMs: normalised * durationMs,
    normalised,
    loopCount: previousLoopCount,
    justLooped: false,
    justFinished: finished && previousNormalised < 1,
  };
}

function factsFor(
  state: AnimState,
  durationMs: number,
  clock: {
    timeMs: number;
    normalised: number;
    loopCount: number;
    justLooped: boolean;
    justFinished: boolean;
  },
  previousTotalNormalisedTime: number,
): AnimStateFacts {
  const durationSeconds = durationMs / 1000;
  const remainingRatio = state.loop
    ? Math.max(0, 1 - clock.normalised)
    : Math.max(0, 1 - clock.normalised);
  return {
    elapsedSeconds: clock.timeMs / 1000,
    durationSeconds,
    normalisedTime: clock.normalised,
    remainingSeconds: remainingRatio * durationSeconds,
    remainingRatio,
    looping: state.loop,
    loopCount: clock.loopCount,
    justLooped: clock.justLooped,
    justFinished: clock.justFinished,
    totalNormalisedTime: totalNormalisedTime(state.loop, clock.loopCount, clock.normalised),
    previousTotalNormalisedTime,
  };
}

function totalNormalisedTime(
  loop: boolean,
  loopCount: number,
  normalised: number,
): number {
  return loop ? loopCount + normalised : normalised;
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

function layerFor(
  doc: AnimGraphDocument,
  stateId: string,
  normalisedTime: number,
  weight: number,
): AnimClipLayer {
  const clip = clipForState(doc, stateId);
  return {
    stateId,
    clipAssetGuid: clip?.assetGuid ?? "",
    clipName: clip?.clipName ?? "",
    clipKind: clip?.kind ?? "animation",
    normalisedTime,
    weight,
  };
}

/** A transition with no decision passes, like a rule graph with both sinks unwired. */
function transitionPasses(
  transition: AnimTransition,
  facts: AnimStateFacts,
  inputs: AnimGraphInputs,
): boolean {
  const decided = inputs.decideTransition?.(transition, facts);
  const rule = decided ?? inputs.transitionRules?.[transition.id];
  return !rule || (rule.enter === true && rule.exit === true);
}

export function evaluateAnimGraph(
  doc: AnimGraphDocument,
  previous: AnimEvalState | null,
  dtSeconds: number,
  inputs: AnimGraphInputs,
): AnimEvalState {
  const { states, clips, outgoing: outgoingByState } = animGraphIndex(doc);
  // A missing entry (reported by `validateAnimGraph`) starts on the first state
  // rather than throwing inside the tick; a graph with no states stays idle.
  const entryStateId = states.has(doc.entryStateId) ? doc.entryStateId : doc.states[0]?.id;
  let stateId = previous?.stateId ?? entryStateId;
  if (stateId === undefined || !states.has(stateId)) stateId = entryStateId;
  if (stateId === undefined) return idleAnimEvalState(doc.entryStateId);
  const current = states.get(stateId)!;
  const duration = clipDurationMs(current, clips);
  const clock = advanceClock(
    previous?.timeMs ?? 0,
    previous?.loopCount ?? 0,
    previous?.normalisedTime ?? 0,
    clockStepSeconds(current, dtSeconds),
    duration,
    current.loop,
  );

  const sameState = previous !== null && previous.stateId === stateId;
  const previousTotal = sameState
    ? totalNormalisedTime(current.loop, previous.loopCount, previous.normalisedTime)
    : 0;
  const currentFacts = factsFor(current, duration, clock, previousTotal);

  const outgoing = outgoingByState.get(stateId) ?? NO_TRANSITIONS;

  let nextId = stateId;
  let nextTimeMs = clock.timeMs;
  let nextNormalised = clock.normalised;
  let nextLoopCount = clock.loopCount;
  let justLooped = clock.justLooped;
  let justFinished = clock.justFinished;
  let blendFromStateId = previous?.blendFromStateId ?? null;
  let blendFromTimeMs = previous?.blendFromTimeMs ?? 0;
  let blendElapsedMs = previous?.blendElapsedMs ?? 0;
  let blendSeconds = previous?.blendSeconds ?? 0;
  let startedBlend: AnimTransition | null = null;

  for (const row of outgoing) {
    // A transition to a missing state (`anim.badTransition`) never fires.
    if (!states.has(row.toStateId)) continue;
    if (!transitionPasses(row, currentFacts, inputs)) continue;
    nextId = row.toStateId;
    nextTimeMs = 0;
    nextNormalised = 0;
    nextLoopCount = 0;
    justLooped = false;
    justFinished = false;
    startedBlend = row.blendSeconds > 0 ? row : null;
    break;
  }

  if (startedBlend) {
    blendFromStateId = stateId;
    blendFromTimeMs = clock.timeMs;
    blendElapsedMs = Math.max(0, dtSeconds) * 1000;
    blendSeconds = startedBlend.blendSeconds;
  } else if (blendFromStateId && nextId === stateId) {
    blendElapsedMs += Math.max(0, dtSeconds) * 1000;
  } else if (nextId !== stateId) {
    blendFromStateId = null;
    blendFromTimeMs = 0;
    blendElapsedMs = 0;
    blendSeconds = 0;
  }

  const nextState = states.get(nextId)!;
  const nextDuration = clipDurationMs(nextState, clips);
  const nextFacts = factsFor(nextState, nextDuration, {
    timeMs: nextTimeMs,
    normalised: nextNormalised,
    loopCount: nextLoopCount,
    justLooped,
    justFinished,
  }, nextId === stateId ? previousTotal : 0);

  const layers: AnimClipLayer[] = [];
  const blendWeights: Record<string, number> = {};
  const blendState = blendFromStateId ? states.get(blendFromStateId) : undefined;
  // Stored at blend start: re-finding the row by (from, to) would pick the
  // first duplicate rather than the transition priority selected.
  const blendDurationMs = Math.max(0, blendSeconds) * 1000;
  let toWeight = 1;
  if (blendState && blendFromStateId && blendDurationMs > 0 && blendFromStateId !== nextId) {
    const t = Math.min(1, blendElapsedMs / blendDurationMs);
    const fromWeight = 1 - t;
    toWeight = t;
    const fromDuration = clipDurationMs(blendState, clips);
    const fromClock = advanceClock(
      blendFromTimeMs,
      0,
      blendFromTimeMs / fromDuration,
      startedBlend ? 0 : clockStepSeconds(blendState, dtSeconds),
      fromDuration,
      blendState.loop,
    );
    if (t >= 1) {
      blendFromStateId = null;
      blendFromTimeMs = 0;
      blendElapsedMs = 0;
      blendSeconds = 0;
      toWeight = 1;
    } else {
      blendFromTimeMs = fromClock.timeMs;
      layers.push(
        layerFor(doc, blendFromStateId, fromClock.normalised, fromWeight),
      );
      blendWeights[blendFromStateId] = fromWeight;
    }
  } else if (!blendState || blendFromStateId === nextId) {
    blendFromStateId = null;
    blendFromTimeMs = 0;
    blendElapsedMs = 0;
    blendSeconds = 0;
  }

  layers.push(layerFor(doc, nextId, nextNormalised, toWeight));
  blendWeights[nextId] = (blendWeights[nextId] ?? 0) + toWeight;

  return {
    stateId: nextId,
    normalisedTime: nextNormalised,
    blendWeights,
    timeMs: nextTimeMs,
    facts: nextFacts,
    layers,
    blendFromStateId,
    blendFromTimeMs,
    blendElapsedMs,
    blendSeconds,
    loopCount: nextLoopCount,
  };
}

function idleAnimEvalState(stateId: string): AnimEvalState {
  return {
    stateId,
    normalisedTime: 0,
    blendWeights: {},
    timeMs: 0,
    facts: {
      elapsedSeconds: 0,
      durationSeconds: 0,
      normalisedTime: 0,
      remainingSeconds: 0,
      remainingRatio: 0,
      looping: false,
      loopCount: 0,
      justLooped: false,
      justFinished: false,
      totalNormalisedTime: 0,
      previousTotalNormalisedTime: 0,
    },
    layers: [],
    blendFromStateId: null,
    blendFromTimeMs: 0,
    blendElapsedMs: 0,
    blendSeconds: 0,
    loopCount: 0,
  };
}

export function clipForState(
  doc: AnimGraphDocument,
  stateId: string,
): AnimClipRef | undefined {
  return animGraphIndex(doc).clipByStateId.get(stateId);
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
  const seen = new Set<string>();
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
      seen.add(name.toLowerCase());
    }
  }
  return variables;
}

function parseRuleGraph(value: unknown): SerializedGraph {
  if (isSerializedGraph(value) && value.nodes.length > 0) {
    return {
      nodes: value.nodes.map((node) => ({ ...node, data: { ...node.data } })),
      edges: value.edges.map((edge) => ({ ...edge })),
    };
  }
  return createDefaultTransitionRuleGraph();
}

function parseAnimationObject(value: unknown): SerializedGraph {
  if (isSerializedGraph(value) && value.nodes.length > 0) {
    return {
      nodes: value.nodes.map((node) => ({ ...node, data: { ...node.data } })),
      edges: value.edges.map((edge) => ({ ...edge })),
    };
  }
  return createDefaultAnimationObjectGraph();
}

/** Recover an `AnimGraphDocument` from a document-chunk JSON payload. */
export function parseAnimGraphDocument(
  value: unknown,
): AnimGraphDocument | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.states)) return null;
  const states: AnimState[] = [];
  for (const row of source.states) {
    if (!row || typeof row !== "object") continue;
    const state = row as Record<string, unknown>;
    if (typeof state.id !== "string" || state.id === "") continue;
    states.push({
      id: state.id,
      name: typeof state.name === "string" && state.name !== "" ? state.name : state.id,
      clipId: typeof state.clipId === "string" ? state.clipId : null,
      speed: asFiniteNumber(state.speed, 1),
      loop: state.loop !== false,
      position: parsePosition(state.position) ?? defaultAnimStatePosition(states.length),
    });
  }
  if (states.length === 0) return null;
  const clips: AnimClipRef[] = [];
  if (Array.isArray(source.clips)) {
    for (const row of source.clips) {
      if (!row || typeof row !== "object") continue;
      const clip = row as Record<string, unknown>;
      if (typeof clip.id !== "string" || clip.id === "") continue;
      clips.push({
        id: clip.id,
        kind: clip.kind === "sprite" ? "sprite" : "animation",
        assetGuid: typeof clip.assetGuid === "string" ? clip.assetGuid : "",
        clipName: typeof clip.clipName === "string" ? clip.clipName : clip.id,
        durationMs: Math.max(1, asFiniteNumber(clip.durationMs, 1000)),
      });
    }
  }
  const transitions: AnimTransition[] = [];
  if (Array.isArray(source.transitions)) {
    for (const row of source.transitions) {
      if (!row || typeof row !== "object") continue;
      const transition = row as Record<string, unknown>;
      if (typeof transition.id !== "string") continue;
      if (typeof transition.fromStateId !== "string") continue;
      if (typeof transition.toStateId !== "string") continue;
      transitions.push({
        id: transition.id,
        fromStateId: transition.fromStateId,
        toStateId: transition.toStateId,
        blendSeconds: asFiniteNumber(transition.blendSeconds, 0.1),
        priority: asFiniteNumber(transition.priority, 0),
        ruleGraph: parseRuleGraph(transition.ruleGraph),
        sourceHandle:
          typeof transition.sourceHandle === "string"
            ? transition.sourceHandle
            : undefined,
        targetHandle:
          typeof transition.targetHandle === "string"
            ? transition.targetHandle
            : undefined,
      });
    }
  }
  const variables = parseVariables(source);
  const entryStateId =
    typeof source.entryStateId === "string" &&
    states.some((state) => state.id === source.entryStateId)
      ? source.entryStateId
      : states[0]!.id;
  return {
    schemaVersion: ANIM_GRAPH_SCHEMA_VERSION,
    name:
      typeof source.name === "string" && source.name !== ""
        ? source.name
        : "Locomotion",
    entryStateId,
    states,
    transitions,
    clips,
    variables,
    animationObject: parseAnimationObject(source.animationObject),
  };
}

/** Asset index used to bind animation clips to Play. */
export interface AnimClipCatalogEntry {
  guid: string;
  type: string;
  name: string;
  clipName?: string;
  clipNames?: string[];
  dependencyGuids?: string[];
  /** Sprite Animation or Animation clip duration. */
  durationMs?: number;
  skeletonGuid?: string | null;
  modelGuid?: string;
}

function resolveOneClip(
  clip: AnimClipRef,
  catalog: readonly AnimClipCatalogEntry[],
): AnimClipRef {
  const byGuid = new Map(catalog.map((entry) => [entry.guid, entry]));
  const entry = byGuid.get(clip.assetGuid);
  if (clip.kind === "sprite") {
    if (!entry || entry.type !== "SpriteAnimation") return clip;
    if (
      typeof entry.durationMs !== "number" ||
      !Number.isFinite(entry.durationMs) ||
      entry.durationMs <= 0 ||
      entry.durationMs === clip.durationMs
    ) {
      return clip;
    }
    return { ...clip, durationMs: entry.durationMs };
  }
  if (clip.kind !== "animation") return clip;
  if (!entry) return clip;
  if (entry.type === "Model") {
    // Only an empty name is filled. A name the Model lacks stays as authored
    // (and plays nothing) rather than silently playing the first group.
    if (clip.clipName !== "") return clip;
    const nextName = entry.clipNames?.[0] ?? clip.clipName;
    return nextName === clip.clipName ? clip : { ...clip, clipName: nextName };
  }
  if (entry.type !== "Animation") return clip;
  const nextName = entry.clipName || clip.clipName;
  const nextDuration =
    typeof entry.durationMs === "number" &&
    Number.isFinite(entry.durationMs) &&
    entry.durationMs > 0
      ? entry.durationMs
      : clip.durationMs;
  if (nextName === clip.clipName && nextDuration === clip.durationMs) return clip;
  return { ...clip, clipName: nextName, durationMs: nextDuration };
}

/** Fill Animation clip names and durations from catalog assets. Keep Animation guids. */
export function resolveAnimGraphClips(
  doc: AnimGraphDocument,
  catalog: readonly AnimClipCatalogEntry[],
): AnimGraphDocument {
  if (catalog.length === 0) return doc;
  let changed = false;
  const clips = doc.clips.map((clip) => {
    const next = resolveOneClip(clip, catalog);
    if (next !== clip) changed = true;
    return next;
  });
  return changed ? { ...doc, clips } : doc;
}
