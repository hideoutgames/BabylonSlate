import type { SerializedGraph } from "@haptic/core";
import {
  animPoseGraphKey,
  type AnimClipLayer,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimGraphInputs,
  type AnimMachineEvalState,
  type AnimPlayerClock,
  type AnimPoseData,
  type AnimState,
  type AnimStateFacts,
  type AnimStateMachine,
  type AnimTransition,
} from "./graph";
import {
  ANIM_FRAME_FLIP_TYPE,
  ANIM_FRAME_SELECT_BY_BOOL_TYPE,
  ANIM_FRAME_SELECT_BY_INT_TYPE,
  ANIM_POSE_BLEND_BY_BOOL_TYPE,
  ANIM_POSE_BLEND_BY_INT_TYPE,
  ANIM_POSE_BLEND_TYPE,
  ANIM_POSE_SEQUENCE_EVALUATOR_TYPE,
  isPoseOutputType,
  isPosePlayerType,
  poseClipData,
  poseGraphIndex,
  poseInputPins,
  poseInputSource,
  poseNodeDefault,
  primaryPosePlayer,
  type PoseGraphIndex,
} from "./pose-graph";

type GraphNode = SerializedGraph["nodes"][number];

/** A state with no player keeps a one-second looping clock for its facts. */
const STATE_CLOCK_MS = 1000;
const NO_TRANSITIONS: readonly AnimTransition[] = [];
const NO_LAYERS: readonly AnimClipLayer[] = [];

interface MachineIndex {
  states: Map<string, AnimState>;
  /** Outgoing transitions per source state in priority order, then document order. */
  outgoing: Map<string, readonly AnimTransition[]>;
}

const machineIndexes = new WeakMap<AnimStateMachine, MachineIndex>();

function machineIndex(machine: AnimStateMachine): MachineIndex {
  let index = machineIndexes.get(machine);
  if (!index) {
    const grouped = new Map<string, Array<{ row: AnimTransition; index: number }>>();
    machine.transitions.forEach((row, position) => {
      const group = grouped.get(row.fromStateId);
      if (group) group.push({ row, index: position });
      else grouped.set(row.fromStateId, [{ row, index: position }]);
    });
    const outgoing = new Map<string, readonly AnimTransition[]>();
    for (const [stateId, entries] of grouped) {
      entries.sort((a, b) => a.row.priority - b.row.priority || a.index - b.index);
      outgoing.set(stateId, entries.map((entry) => entry.row));
    }
    index = { states: new Map(machine.states.map((state) => [state.id, state])), outgoing };
    machineIndexes.set(machine, index);
  }
  return index;
}

/** Per-evaluation scratch: the previous clocks, the ones this tick writes, and each graph's data. */
interface EvalContext {
  inputs: AnimGraphInputs;
  previousPlayers: Readonly<Record<string, AnimPlayerClock>>;
  players: Record<string, AnimPlayerClock>;
  previousSelectors: Readonly<Record<string, number[]>>;
  selectors: Record<string, number[]>;
}

interface Clock extends AnimPlayerClock {
  justLooped: boolean;
  justFinished: boolean;
}

function advanceClock(previous: AnimPlayerClock, dtMs: number, durationMs: number, loop: boolean): Clock {
  let timeMs = previous.timeMs + (Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0);
  if (loop) {
    let loops = 0;
    while (timeMs >= durationMs) {
      timeMs -= durationMs;
      loops += 1;
      if (loops > 100_000) {
        timeMs %= durationMs;
        break;
      }
    }
    return { timeMs, normalised: timeMs / durationMs, loopCount: previous.loopCount + loops, justLooped: loops > 0, justFinished: false };
  }
  const normalised = Math.min(1, timeMs / durationMs);
  return {
    timeMs: normalised * durationMs,
    normalised,
    loopCount: previous.loopCount,
    justLooped: false,
    justFinished: normalised >= 1 && previous.normalised < 1,
  };
}

function totalNormalisedTime(loop: boolean, loopCount: number, normalised: number): number {
  return loop ? loopCount + normalised : normalised;
}

function factsFor(clock: Clock, durationMs: number, loop: boolean, previousTotal: number): AnimStateFacts {
  const durationSeconds = durationMs / 1000;
  const remainingRatio = Math.max(0, 1 - clock.normalised);
  return {
    elapsedSeconds: clock.timeMs / 1000,
    durationSeconds,
    normalisedTime: clock.normalised,
    remainingSeconds: remainingRatio * durationSeconds,
    remainingRatio,
    looping: loop,
    loopCount: clock.loopCount,
    justLooped: clock.justLooped,
    justFinished: clock.justFinished,
    totalNormalisedTime: totalNormalisedTime(loop, clock.loopCount, clock.normalised),
    previousTotalNormalisedTime: previousTotal,
  };
}

const ZERO_CLOCK: AnimPlayerClock = { timeMs: 0, loopCount: 0, normalised: 0 };

/** A node's data input this tick: the compiled value when the input is wired, else the value stored on the node. */
function dataValue<T>(data: AnimPoseData | undefined, node: GraphNode, pin: string, fallback: T): T {
  const computed = data?.[node.id]?.[pin];
  if (computed !== undefined) {
    if (typeof fallback === "number") return (typeof computed === "number" && Number.isFinite(computed) ? computed : fallback) as T;
    if (typeof fallback === "boolean") return Boolean(computed) as T;
    return computed as T;
  }
  return poseNodeDefault(node, pin, fallback);
}

/** A player's length in ms at its play rate, its play rate and loop flag. */
function playerTiming(node: GraphNode, data: AnimPoseData | undefined): { durationMs: number; playRate: number; loop: boolean } {
  const clip = poseClipData(node);
  const playRate = dataValue(data, node, "playRate", 1);
  return { durationMs: Math.max(1, clip.durationMs), playRate, loop: clip.loop };
}

/** Where a player starts: its Start Position (3D, 0 to 1) or Start Frame (2D, over its frame count). */
function playerStart(node: GraphNode, data: AnimPoseData | undefined, durationMs: number): AnimPlayerClock {
  let start: number;
  if (node.type.startsWith("anim.frame.")) {
    const frameCount = typeof node.data.frameCount === "number" && node.data.frameCount > 0 ? node.data.frameCount : 0;
    start = frameCount > 0 ? dataValue(data, node, "startFrame", 0) / frameCount : 0;
  } else {
    start = dataValue(data, node, "startPosition", 0);
  }
  const normalised = Math.min(1, Math.max(0, Number.isFinite(start) ? start : 0));
  return { timeMs: normalised * durationMs, loopCount: 0, normalised };
}

/**
 * Walks a pose graph from its output: advances every player and selector it reaches by `dtSeconds` (a fresh visit
 * starts them over) and returns its clip layers at weight 1. `stateId` tags the layers; `machine` plays a State
 * Machine node.
 */
function visitPoseGraph(
  ctx: EvalContext,
  graphKey: string,
  graph: SerializedGraph,
  data: AnimPoseData | undefined,
  dtSeconds: number,
  fresh: boolean,
  stateId: string,
): AnimClipLayer[] {
  const index = poseGraphIndex(graph);
  if (!index.output) return [];
  const layers: AnimClipLayer[] = [];
  const visited = new Set<string>();
  const visit = (node: GraphNode | undefined, weight: number, flipX: boolean, flipY: boolean): void => {
    // A pose output feeds one input, so each node is reached once; a cycle stops here.
    if (!node || visited.has(node.id)) return;
    visited.add(node.id);
    const key = `${graphKey}#${node.id}`;
    const emit = (layer: Omit<AnimClipLayer, "weight" | "stateId">) => {
      if (weight <= 0) return;
      layers.push({ ...layer, stateId, weight, ...(flipX ? { flipX: true } : {}), ...(flipY ? { flipY: true } : {}) });
    };
    if (isPoseOutputType(node.type)) {
      visit(firstPoseInput(index, node), weight, flipX, flipY);
      return;
    }
    if (isPosePlayerType(node.type)) {
      const timing = playerTiming(node, data);
      const previous = fresh ? playerStart(node, data, timing.durationMs) : ctx.previousPlayers[key] ?? playerStart(node, data, timing.durationMs);
      // A Play Rate at or below 0 holds the frame.
      const clock = advanceClock(previous, timing.playRate > 0 ? dtSeconds * 1000 * timing.playRate : 0, timing.durationMs, timing.loop);
      ctx.players[key] = { timeMs: clock.timeMs, loopCount: clock.loopCount, normalised: clock.normalised };
      const clip = poseClipData(node);
      if (clip.assetGuid) {
        emit({ clipAssetGuid: clip.assetGuid, clipName: clip.clipName, clipKind: node.type.startsWith("anim.frame.") ? "sprite" : "animation", normalisedTime: clock.normalised });
      }
      return;
    }
    if (node.type === ANIM_POSE_SEQUENCE_EVALUATOR_TYPE) {
      const clip = poseClipData(node);
      const time = dataValue(data, node, "normalizedTime", 0);
      if (clip.assetGuid) {
        emit({ clipAssetGuid: clip.assetGuid, clipName: clip.clipName, clipKind: "animation", normalisedTime: Math.min(1, Math.max(0, time)) });
      }
      return;
    }
    if (node.type === ANIM_POSE_BLEND_TYPE) {
      const alpha = Math.min(1, Math.max(0, dataValue(data, node, "alpha", 0.5)));
      visit(poseInputSource(index, node.id, "a"), weight * (1 - alpha), flipX, flipY);
      visit(poseInputSource(index, node.id, "b"), weight * alpha, flipX, flipY);
      return;
    }
    if (node.type === ANIM_POSE_BLEND_BY_BOOL_TYPE || node.type === ANIM_POSE_BLEND_BY_INT_TYPE) {
      const pins = poseInputPins(node.type, node.data.count);
      const target = node.type === ANIM_POSE_BLEND_BY_BOOL_TYPE
        ? (dataValue(data, node, "active", true) ? 0 : 1)
        : clampIndex(dataValue(data, node, "activeIndex", 0), pins.length);
      const weights = blendSelector(ctx, key, node, pins.length, target, dtSeconds, fresh);
      pins.forEach((pin, position) => visit(poseInputSource(index, node.id, pin), weight * weights[position]!, flipX, flipY));
      return;
    }
    if (node.type === ANIM_FRAME_SELECT_BY_BOOL_TYPE || node.type === ANIM_FRAME_SELECT_BY_INT_TYPE) {
      // Frames cannot blend: the chosen input shows alone, and the others keep their time.
      const pins = poseInputPins(node.type, node.data.count);
      const target = node.type === ANIM_FRAME_SELECT_BY_BOOL_TYPE
        ? (dataValue(data, node, "active", true) ? 0 : 1)
        : clampIndex(dataValue(data, node, "activeIndex", 0), pins.length);
      pins.forEach((pin, position) => visit(poseInputSource(index, node.id, pin), position === target ? weight : 0, flipX, flipY));
      return;
    }
    if (node.type === ANIM_FRAME_FLIP_TYPE) {
      visit(
        poseInputSource(index, node.id, "frame"),
        weight,
        flipX !== dataValue(data, node, "flipX", false),
        flipY !== dataValue(data, node, "flipY", false),
      );
      return;
    }
    // Rest Pose and unknown nodes add no clip: the bones keep their rest pose.
  };
  visit(index.output, 1, false, false);
  return layers;
}

function firstPoseInput(index: PoseGraphIndex, node: GraphNode): GraphNode | undefined {
  for (const pin of poseInputPins(node.type, node.data.count)) {
    const source = poseInputSource(index, node.id, pin);
    if (source) return source;
  }
  return undefined;
}

function clampIndex(value: number, count: number): number {
  const index = Math.round(Number.isFinite(value) ? value : 0);
  return Math.min(count - 1, Math.max(0, index));
}

/**
 * Weights of a Blend Poses By Bool / Int's inputs, easing toward `target` over its blend time (`trueBlendSeconds`
 * and `falseBlendSeconds`, or `blendSeconds`). A fresh visit starts on the target.
 */
function blendSelector(
  ctx: EvalContext,
  key: string,
  node: GraphNode,
  count: number,
  target: number,
  dtSeconds: number,
  fresh: boolean,
): number[] {
  const previous = fresh ? undefined : ctx.previousSelectors[key];
  let weights = previous && previous.length === count ? [...previous] : Array.from({ length: count }, (_, i) => (i === target ? 1 : 0));
  const blendSeconds = node.type === ANIM_POSE_BLEND_BY_BOOL_TYPE
    ? Number(target === 0 ? node.data.trueBlendSeconds ?? 0.2 : node.data.falseBlendSeconds ?? 0.2)
    : Number(node.data.blendSeconds ?? 0.2);
  const step = blendSeconds > 0 && Number.isFinite(blendSeconds) ? Math.max(0, dtSeconds) / blendSeconds : 1;
  weights = weights.map((weight, i) => (i === target ? Math.min(1, weight + step) : Math.max(0, weight - step)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  weights = total > 0 ? weights.map((weight) => weight / total) : weights.map((_, i) => (i === target ? 1 : 0));
  ctx.selectors[key] = weights;
  return weights;
}

function scaleLayers(layers: readonly AnimClipLayer[], weight: number): AnimClipLayer[] {
  return weight <= 0 ? [] : layers.map((layer) => ({ ...layer, weight: layer.weight * weight }));
}

/** A state's clock and facts: its primary player's, else a one-second looping state clock. */
function stateTiming(state: AnimState, data: AnimPoseData | undefined): { durationMs: number; playRate: number; loop: boolean } {
  const player = primaryPosePlayer(state.stateGraph);
  return player ? playerTiming(player, data) : { durationMs: STATE_CLOCK_MS, playRate: 1, loop: true };
}

/** Where a state's clock starts on entry: at its primary player's start, else at 0. */
function stateStart(state: AnimState, data: AnimPoseData | undefined, durationMs: number): AnimPlayerClock {
  const player = primaryPosePlayer(state.stateGraph);
  return player ? playerStart(player, data, durationMs) : ZERO_CLOCK;
}

/** The State Machine's tick: run its active state's graph and transitions, and blend. */
function evaluateMachine(
  ctx: EvalContext,
  machine: AnimStateMachine,
  previous: AnimMachineEvalState | null,
  dtSeconds: number,
): { state: AnimMachineEvalState; layers: AnimClipLayer[] } {
  const { states, outgoing: outgoingByState } = machineIndex(machine);
  const entryStateId = states.has(machine.entryStateId) ? machine.entryStateId : machine.states[0]?.id;
  let stateId = previous?.stateId ?? entryStateId;
  if (stateId === undefined || !states.has(stateId)) stateId = entryStateId;
  if (stateId === undefined) return { state: idleMachineState(machine.entryStateId), layers: [] };
  const current = states.get(stateId)!;
  // A jump leaves the target with a negative time, which enters it fresh.
  const sameState = previous !== null && previous.stateId === stateId && previous.timeMs >= 0;
  const entered = !sameState;
  const currentKey = animPoseGraphKey(stateId);
  // Data inputs see the state's facts from before this tick's advance.
  const currentData = ctx.inputs.poseData?.(currentKey, previous && sameState ? previous.facts : null);
  const timing = stateTiming(current, currentData);
  const start = sameState
    ? { timeMs: previous.timeMs, loopCount: previous.loopCount, normalised: previous.normalisedTime }
    : stateStart(current, currentData, timing.durationMs);
  const previousTotal = sameState
    ? totalNormalisedTime(previous.facts.looping, previous.loopCount, previous.normalisedTime)
    : start.normalised;
  const clock = advanceClock(
    start,
    timing.playRate > 0 ? dtSeconds * 1000 * timing.playRate : 0,
    timing.durationMs,
    timing.loop,
  );
  const currentFacts = factsFor(clock, timing.durationMs / Math.max(0.001, timing.playRate), timing.loop, previousTotal);
  const currentLayers = visitPoseGraph(ctx, currentKey, current.stateGraph, currentData, dtSeconds, entered, stateId);

  let nextId = stateId;
  let nextClock: Clock = clock;
  let nextFacts = currentFacts;
  let nextLayers = currentLayers;
  let startedBlend: AnimTransition | null = null;
  for (const row of outgoingByState.get(stateId) ?? NO_TRANSITIONS) {
    // A transition to a missing state (`anim.badTransition`) never fires.
    if (!states.has(row.toStateId)) continue;
    const decided = ctx.inputs.decideTransition?.(row, currentFacts) ?? ctx.inputs.transitionRules?.[row.id];
    if (decided && !(decided.enter === true && decided.exit === true)) continue;
    nextId = row.toStateId;
    startedBlend = row.blendSeconds > 0 ? row : null;
    ctx.inputs.transitionTaken?.(row);
    const next = states.get(nextId)!;
    const nextKey = animPoseGraphKey(nextId);
    const nextData = ctx.inputs.poseData?.(nextKey, null);
    const nextTiming = stateTiming(next, nextData);
    const nextStart = stateStart(next, nextData, nextTiming.durationMs);
    nextClock = { ...nextStart, justLooped: false, justFinished: false };
    nextFacts = factsFor(nextClock, nextTiming.durationMs / Math.max(0.001, nextTiming.playRate), nextTiming.loop, nextStart.normalised);
    // A self-transition restarts the state, and its blend crossfades from the frame it left.
    nextLayers = visitPoseGraph(ctx, nextKey, next.stateGraph, nextData, 0, true, nextId);
    break;
  }

  let blendFromStateId = previous?.blendFromStateId ?? null;
  let blendElapsedMs = previous?.blendElapsedMs ?? 0;
  let blendSeconds = previous?.blendSeconds ?? 0;
  let fromLayers: readonly AnimClipLayer[] = NO_LAYERS;
  if (startedBlend) {
    blendFromStateId = stateId;
    blendElapsedMs = Math.max(0, dtSeconds) * 1000;
    blendSeconds = startedBlend.blendSeconds;
    fromLayers = currentLayers;
  } else if (nextId !== stateId) {
    blendFromStateId = null;
    blendElapsedMs = 0;
    blendSeconds = 0;
  } else if (blendFromStateId && blendFromStateId !== nextId && states.has(blendFromStateId)) {
    blendElapsedMs += Math.max(0, dtSeconds) * 1000;
    const from = states.get(blendFromStateId)!;
    const fromKey = animPoseGraphKey(blendFromStateId);
    fromLayers = visitPoseGraph(ctx, fromKey, from.stateGraph, ctx.inputs.poseData?.(fromKey, null), dtSeconds, false, blendFromStateId);
  } else {
    blendFromStateId = null;
    blendElapsedMs = 0;
    blendSeconds = 0;
  }

  const blendWeights: Record<string, number> = {};
  let toWeight = 1;
  const layers: AnimClipLayer[] = [];
  const blendDurationMs = Math.max(0, blendSeconds) * 1000;
  if (blendFromStateId && blendDurationMs > 0) {
    const t = Math.min(1, blendElapsedMs / blendDurationMs);
    if (t >= 1) {
      blendFromStateId = null;
      blendElapsedMs = 0;
      blendSeconds = 0;
    } else {
      toWeight = t;
      layers.push(...scaleLayers(fromLayers, 1 - t));
      blendWeights[blendFromStateId] = 1 - t;
    }
  } else if (blendFromStateId) {
    blendFromStateId = null;
    blendElapsedMs = 0;
    blendSeconds = 0;
  }
  layers.push(...scaleLayers(nextLayers, toWeight));
  blendWeights[nextId] = (blendWeights[nextId] ?? 0) + toWeight;

  const state: AnimMachineEvalState = {
    stateId: nextId,
    normalisedTime: nextClock.normalised,
    blendWeights,
    timeMs: nextClock.timeMs,
    facts: nextFacts,
    blendFromStateId,
    blendElapsedMs,
    blendSeconds,
    loopCount: nextClock.loopCount,
  };
  return { state, layers };
}

function idleFacts(): AnimStateFacts {
  return {
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
  };
}

function idleMachineState(stateId: string): AnimMachineEvalState {
  return {
    stateId,
    normalisedTime: 0,
    blendWeights: {},
    timeMs: 0,
    facts: idleFacts(),
    blendFromStateId: null,
    blendElapsedMs: 0,
    blendSeconds: 0,
    loopCount: 0,
  };
}

/**
 * Pure `(graph, previous, dt, inputs) → AnimEvalState`: runs the State Machine with its active state's graph and
 * returns the weighted clip layers render blends.
 */
export function evaluateAnimGraph(
  doc: AnimGraphDocument,
  previous: AnimEvalState | null,
  dtSeconds: number,
  inputs: AnimGraphInputs,
): AnimEvalState {
  const ctx: EvalContext = {
    inputs,
    previousPlayers: previous?.players ?? {},
    players: {},
    previousSelectors: previous?.selectors ?? {},
    selectors: {},
  };
  const { state, layers } = evaluateMachine(ctx, doc.stateMachine, previous, dtSeconds);
  return { ...state, players: ctx.players, selectors: ctx.selectors, layers };
}

/** An evaluation that starts the State Machine over in `stateId`. */
export function animEvalWithJump(
  doc: AnimGraphDocument,
  previous: AnimEvalState | null,
  stateId: string,
): AnimEvalState | null {
  if (!doc.stateMachine.states.some((state) => state.id === stateId)) return previous;
  // A negative time is unknown to the next evaluation, so it enters the state fresh with no blend.
  const base = previous ?? { ...idleMachineState(stateId), players: {}, selectors: {}, layers: [] };
  return { ...base, ...idleMachineState(stateId), timeMs: -1 };
}
