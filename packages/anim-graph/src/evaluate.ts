import type { SerializedGraph } from "@haptic/core";
import {
  animBoneAxisVector,
  animBranchFilterKey,
  parseAnimBoneModifyMode,
  parseAnimBoneSpace,
  normalizeAnimSpringBoneSettings,
  parseAnimTargetSpace,
  rotatorToQuat,
  type AnimSpringBoneSettings,
  type AnimBoneChannel,
  type AnimBoneModifier,
  type AnimLayerBlend,
  type AnimLayerMaskRef,
} from "@haptic/core";
import {
  animAliasStates,
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
  type AnimSyncGroupClock,
  type AnimTransition,
} from "./graph";
import {
  blendSpaceAxisDelta,
  blendSpaceAxisValue,
  blendSpaceTriangles,
  blendSpaceWeights,
  nearestBlendSpaceSample,
  type BlendSpaceLayout,
  type BlendSpaceTriangle,
} from "./blend-space";
import {
  ANIM_FRAME_FLIP_TYPE,
  ANIM_FRAME_SELECT_BY_BOOL_TYPE,
  ANIM_FRAME_SELECT_BY_INT_TYPE,
  ANIM_FRAME_SPRITE_BLEND_SPACE_PLAYER_TYPE,
  ANIM_POSE_BLEND_BY_BOOL_TYPE,
  ANIM_POSE_BLEND_BY_INT_TYPE,
  ANIM_POSE_BLEND_TYPE,
  ANIM_POSE_APPLY_ADDITIVE_TYPE,
  ANIM_CONTROL_TRANSFORM_BONE_TYPE,
  ANIM_CONTROL_LOOK_AT_TYPE,
  ANIM_CONTROL_TWO_BONE_IK_TYPE,
  ANIM_CONTROL_SPRING_BONES_TYPE,
  ANIM_POSE_LAYERED_BLEND_TYPE,
  ANIM_POSE_SAVE_CACHED_TYPE,
  ANIM_POSE_SEQUENCE_EVALUATOR_TYPE,
  ANIM_POSE_USE_CACHED_TYPE,
  ANIM_FRAME_SLOT_TYPE,
  isSlotNodeType,
  slotNodeName,
  blendSpaceNodeData,
  cachedPoseName,
  isBlendSpacePlayerType,
  isPoseOutputType,
  isPosePlayerType,
  layeredBlendFilters,
  parseResolvedClipAdditive,
  poseClipData,
  poseGraphIndex,
  poseInputPins,
  poseInputSource,
  poseNodeDefault,
  poseSyncGroup,
  primaryPosePlayer,
  poseClipEvents,
  type BlendSpaceNodeAxis,
  type BlendSpaceNodeSample,
  type PoseGraphIndex,
} from "./pose-graph";
import {
  animRootMotionDelta,
  parseAnimClipRootMotion,
  sumAnimRootMotion,
  type AnimClipRootMotion,
  type AnimRootMotionDelta,
} from "./root-motion";
import { advanceAnimSlots, slotClock, type AnimSlotPlayback, type AnimSlotState } from "./slots";
import {
  animClipEventSpan,
  animClipSweep,
  animSweepCrossings,
  type AnimClipEvent,
  type AnimClipSweep,
  type AnimEventAction,
  type AnimFiredEvent,
  type AnimFiredEventPhase,
  type AnimOpenWindow,
} from "./events";

type GraphNode = SerializedGraph["nodes"][number];

/** A state with no player keeps a one-second looping clock for its facts. */
const STATE_CLOCK_MS = 1000;
/** Cached poses used inside cached poses are followed this deep when summing their weights. */
const MAX_CACHED_POSE_DEPTH = 16;
/** A Blend Space sample below this weight adds no layer. */
const BLEND_SPACE_MIN_WEIGHT = 1e-4;
const NO_TRANSITIONS: readonly AnimTransition[] = [];

/** A clip event a visit crossed, at the source's weight in its graph; the State Machine scales it with its state. */
interface PendingEvent {
  name: string;
  phase: AnimFiredEventPhase;
  clipAssetGuid: string;
  stateId: string;
  action: AnimEventAction | null;
  weight: number;
  triggerWeight: number;
  /** The player or Blend Space sample it plays on. */
  source: string;
  /** A window's key, shared by its begin and end. */
  window?: string;
}

/** A source started over this tick: any window still open on it ends first. */
interface PendingRestart {
  restart: string;
}

/**
 * A Use Cached Pose, at its weight: the cached pose's events fire once a tick, at the first use, at the uses' summed
 * weight (`resolveCachedPoseEvents`).
 */
interface PendingCachedUse {
  cached: string;
  weight: number;
}

type Pending = PendingEvent | PendingRestart | PendingCachedUse;

/**
 * What one visit of a pose graph produced: its layers, the events it crossed, the sources it played and the bone
 * changes it made, each weighted.
 */
interface PoseVisit {
  layers: AnimClipLayer[];
  pending: Pending[];
  sources: Array<{ key: string; weight: number }>;
  modifiers: AnimBoneModifier[];
  /** The root motion its clips made this tick, each by its weight. */
  motion: RootMotionPart[];
}

type RootMotionPart = AnimRootMotionDelta & { weight: number };

const EMPTY_VISIT: PoseVisit = { layers: [], pending: [], sources: [], modifiers: [], motion: [] };

function scaleVisit(visit: PoseVisit, weight: number): PoseVisit {
  if (weight === 1) return visit;
  return {
    layers: scaleLayers(visit.layers, weight),
    pending: visit.pending.map((item) => ("restart" in item ? item : { ...item, weight: item.weight * weight })),
    sources: visit.sources.map((source) => ({ ...source, weight: source.weight * weight })),
    modifiers: weight > 0 ? visit.modifiers.map((modifier) => ({ ...modifier, alpha: modifier.alpha * weight })) : [],
    motion: visit.motion.map((part) => ({ ...part, weight: part.weight * weight })),
  };
}

/** A state's own event (Enter, Exit, Fully Blended), which always fires. */
function stateEvent(name: string | undefined, stateId: string): PendingEvent[] {
  return name
    ? [{ name, phase: "event", clipAssetGuid: "", stateId, action: null, weight: 1, triggerWeight: 0, source: "" }]
    : [];
}

/**
 * The events a source crossed in `sweep`, in the order it crossed them: single events and each window's begin and
 * end. `durationMs` is one pass of the clip the events are on.
 */
function sweepEvents(
  pending: Pending[],
  events: readonly AnimClipEvent[],
  sweep: AnimClipSweep,
  durationMs: number,
  info: { clipAssetGuid: string; stateId: string; weight: number; source: string },
): void {
  if (events.length === 0) return;
  const crossed: Array<{ position: number; order: number; event: PendingEvent }> = [];
  events.forEach((event, index) => {
    const span = animClipEventSpan(event, durationMs);
    const base = {
      name: event.name,
      clipAssetGuid: info.clipAssetGuid,
      stateId: info.stateId,
      weight: info.weight,
      triggerWeight: event.triggerWeight,
      source: info.source,
    };
    if (span.end === null) {
      for (const position of animSweepCrossings(sweep, span.begin)) {
        crossed.push({ position, order: index * 2, event: { ...base, phase: "event", action: event.action } });
      }
      return;
    }
    const window = `${info.source}#${index}`;
    for (const position of animSweepCrossings(sweep, span.begin)) {
      crossed.push({ position, order: index * 2, event: { ...base, phase: "begin", action: event.action, window } });
    }
    for (const position of animSweepCrossings(sweep, span.end)) {
      // An end at the begin's own position (a window as long as the pass) closes after it opens.
      crossed.push({ position, order: index * 2 + 1, event: { ...base, phase: "end", action: null, window } });
    }
  });
  crossed.sort((a, b) => a.position - b.position || a.order - b.order);
  for (const entry of crossed) pending.push(entry.event);
}

/**
 * Fires a tick's events in order: a single event or a window's begin at or above its Trigger Weight, a window's end
 * once it began; then the end of every open window whose source no longer plays.
 */
function fireEvents(
  pending: readonly Pending[],
  sources: ReadonlyMap<string, number>,
  previousOpen: Readonly<Record<string, AnimOpenWindow>> | undefined,
): { fired: AnimFiredEvent[]; open: Map<string, AnimOpenWindow> } {
  const open = new Map(Object.entries(previousOpen ?? {}));
  const fired: AnimFiredEvent[] = [];
  const end = (key: string, window: AnimOpenWindow) => {
    open.delete(key);
    fired.push({ name: window.name, phase: "end", clipAssetGuid: window.clipAssetGuid, stateId: window.stateId, action: null });
  };
  for (const item of pending) {
    // Use markers are resolved before firing.
    if ("cached" in item) continue;
    if ("restart" in item) {
      // A Blend Space's samples play under its key.
      for (const [key, window] of [...open]) {
        if (window.source === item.restart || window.source.startsWith(`${item.restart}@`)) end(key, window);
      }
      continue;
    }
    const playing = item.weight > 0 && item.weight + 1e-9 >= item.triggerWeight;
    if (item.phase === "event") {
      if (playing) fired.push({ name: item.name, phase: "event", clipAssetGuid: item.clipAssetGuid, stateId: item.stateId, action: item.action });
    } else if (item.phase === "begin") {
      if (playing && item.window && !open.has(item.window)) {
        open.set(item.window, { name: item.name, clipAssetGuid: item.clipAssetGuid, stateId: item.stateId, source: item.source });
        fired.push({ name: item.name, phase: "begin", clipAssetGuid: item.clipAssetGuid, stateId: item.stateId, action: item.action });
      }
    } else if (item.window) {
      const window = open.get(item.window);
      if (window) end(item.window, window);
    }
  }
  for (const [key, window] of [...open]) {
    if (!((sources.get(window.source) ?? 0) > 0)) end(key, window);
  }
  return { fired, open };
}

interface MachineIndex {
  states: Map<string, AnimState>;
  /** Outgoing transitions per source state in priority order, then document order. */
  outgoing: Map<string, readonly AnimTransition[]>;
  /** Each Save Cached Pose by name, the first in state order where names repeat (`anim.duplicateCachedPose`). */
  cachedPoses: Map<string, { stateId: string; graph: SerializedGraph; node: GraphNode }>;
}

const machineIndexes = new WeakMap<AnimStateMachine, MachineIndex>();

function machineIndex(machine: AnimStateMachine): MachineIndex {
  let index = machineIndexes.get(machine);
  if (!index) {
    const grouped = new Map<string, Array<{ row: AnimTransition; index: number }>>();
    const add = (stateId: string, row: AnimTransition, position: number) => {
      const group = grouped.get(stateId);
      if (group) group.push({ row, index: position });
      else grouped.set(stateId, [{ row, index: position }]);
    };
    const aliases = new Map((machine.aliases ?? []).map((alias) => [alias.id, alias]));
    machine.transitions.forEach((row, position) => {
      const alias = aliases.get(row.fromStateId);
      if (!alias) {
        add(row.fromStateId, row, position);
        return;
      }
      // A State Alias's transition leaves from each state it covers, but never re-enters the one playing.
      for (const stateId of animAliasStates(machine, alias)) {
        if (stateId !== row.toStateId) add(stateId, row, position);
      }
    });
    const outgoing = new Map<string, readonly AnimTransition[]>();
    for (const [stateId, entries] of grouped) {
      entries.sort((a, b) => a.row.priority - b.row.priority || a.index - b.index);
      outgoing.set(stateId, entries.map((entry) => entry.row));
    }
    const cachedPoses: MachineIndex["cachedPoses"] = new Map();
    for (const state of machine.states) {
      for (const node of state.stateGraph.nodes) {
        const name = node.type === ANIM_POSE_SAVE_CACHED_TYPE ? cachedPoseName(node) : "";
        if (name && !cachedPoses.has(name)) cachedPoses.set(name, { stateId: state.id, graph: state.stateGraph, node });
      }
    }
    index = { states: new Map(machine.states.map((state) => [state.id, state])), outgoing, cachedPoses };
    machineIndexes.set(machine, index);
  }
  return index;
}

/** Per-evaluation scratch: the previous clocks, the ones this tick writes, and each graph's data. */
interface EvalContext {
  inputs: AnimGraphInputs;
  machine: AnimStateMachine;
  /** The tick's time step, which cached poses advance by whichever state first uses them. */
  dtSeconds: number;
  /** The Layered Blend Per Bone nodes reached this tick, which layers' and bone changes' masks index. */
  layerBlends: AnimLayerBlend[];
  /** Each cached pose evaluated this tick by name; a null visit is one still being evaluated (a cycle reads nothing). */
  cachedPoses: Map<string, PoseVisit | null>;
  /** The slot animations playing this tick, advanced once before the State Machine runs. */
  slots: Readonly<Record<string, AnimSlotState>>;
  previousPlayers: Readonly<Record<string, AnimPlayerClock>>;
  players: Record<string, AnimPlayerClock>;
  previousSelectors: Readonly<Record<string, number[]>>;
  selectors: Record<string, number[]>;
  /** Each Blend Space Player's weights this tick, worked out once for its state clock and its layers. */
  blendSpaces: Map<string, BlendSpaceTick>;
  dtMs: number;
  previousLookAtTargets: Readonly<Record<string, number[]>>;
  lookAtTargets: Record<string, number[]>;
  previousSyncGroups: Readonly<Record<string, AnimSyncGroupClock>>;
  /** This tick's Sync Groups: the shared phase and the heaviest member, which sets next tick's pace. */
  syncGroups: Map<string, { phase: number; leaderWeight: number; leaderCycleMs: number }>;
}

/**
 * A Sync Group member's cycle position this tick: the group's, advanced once from last tick by its leader's cycle.
 * The heaviest member (the first at a tie, which is the state being blended into) leads next tick. Null for a group
 * that had no members last tick: its first member keeps its own time and starts the group.
 */
function syncGroupPhase(ctx: EvalContext, group: string, cycleMs: number, weight: number): number | null {
  let entry = ctx.syncGroups.get(group);
  if (!entry) {
    const previous = ctx.previousSyncGroups[group];
    if (!previous) return null;
    const phase = (((previous.phase + ctx.dtMs / Math.max(1, previous.cycleMs)) % 1) + 1) % 1;
    entry = { phase, leaderWeight: -1, leaderCycleMs: previous.cycleMs };
    ctx.syncGroups.set(group, entry);
  }
  if (weight > entry.leaderWeight) {
    entry.leaderWeight = weight;
    entry.leaderCycleMs = cycleMs;
  }
  return entry.phase;
}

/** A member's clock moved to its Sync Group's phase, or kept (and starting the group) when the group is new. */
function syncedClock(ctx: EvalContext, node: GraphNode, clock: Clock, cycleMs: number, weight: number): Clock {
  const group = poseSyncGroup(node);
  if (!group) return clock;
  const phase = syncGroupPhase(ctx, group, cycleMs, weight);
  if (phase === null) {
    ctx.syncGroups.set(group, { phase: clock.normalised, leaderWeight: weight, leaderCycleMs: cycleMs });
    return clock;
  }
  return { ...clock, normalised: phase, timeMs: phase * (cycleMs > 0 ? cycleMs : 1) };
}

interface BlendSpaceTick {
  samples: readonly BlendSpaceNodeSample[];
  weights: readonly number[];
  /** One cycle of the blend: the samples' lengths (over their rate scales) averaged by weight. */
  cycleMs: number;
  /** A Sprite Blend Space whose sample changed this tick and does not keep time: its cycle starts over. */
  restart: boolean;
}

const EMPTY_BLEND_SPACE: BlendSpaceTick = { samples: [], weights: [], cycleMs: STATE_CLOCK_MS, restart: false };

/** A Sprite Blend Space's playing sample, kept beside its eased inputs. */
const SAMPLE_KEY = "#sample";

/** A resolved Blend Space's layout and triangulation, kept per stored object so triangles are built once. */
const blendSpaceLayouts = new WeakMap<
  object,
  {
    layout: BlendSpaceLayout;
    axes: BlendSpaceNodeAxis[];
    triangles: BlendSpaceTriangle[];
    samples: BlendSpaceNodeSample[];
    hysteresis: number;
    keepTime: boolean;
  } | null
>();

function blendSpaceLayout(node: GraphNode) {
  const raw = node.data.blendSpace;
  if (!raw || typeof raw !== "object") return null;
  if (blendSpaceLayouts.has(raw)) return blendSpaceLayouts.get(raw)!;
  const space = blendSpaceNodeData(node);
  const [first, second] = space.axes;
  const entry = first && space.samples.length > 0
    ? (() => {
        const axes: BlendSpaceLayout["axes"] = second ? [first, second] : [first];
        const layout: BlendSpaceLayout = { axes, samples: space.samples };
        return {
          layout,
          axes: space.axes,
          triangles: blendSpaceTriangles(layout),
          samples: space.samples,
          hysteresis: space.hysteresis ?? 0,
          keepTime: space.keepTime !== false,
        };
      })()
    : null;
  blendSpaceLayouts.set(raw, entry);
  return entry;
}

/** An input eased toward `target` over about the axis's Smoothing Time, the short way round a wrapping axis. */
function smoothAxis(axis: BlendSpaceNodeAxis, previous: number | undefined, target: number, dtSeconds: number): number {
  const value = blendSpaceAxisValue(axis, target);
  if (previous === undefined || !(axis.smoothingSeconds > 0)) return value;
  const step = 1 - Math.exp((-3 * Math.max(0, dtSeconds)) / axis.smoothingSeconds);
  return blendSpaceAxisValue(axis, previous + blendSpaceAxisDelta(axis, previous, value) * step);
}

/**
 * A Blend Space Player's tick: its X and Y eased by their Smoothing Times, the samples' weights there and the length
 * of one shared cycle. A Sprite Blend Space plays only the nearest sample (held by its hysteresis) for that sample's
 * length. Computed once per tick for each key (a fresh visit apart).
 */
function blendSpaceTick(
  ctx: EvalContext,
  key: string,
  node: GraphNode,
  data: AnimPoseData | undefined,
  dtSeconds: number,
  fresh: boolean,
): BlendSpaceTick {
  const cacheKey = fresh ? `${key}\0fresh` : key;
  const cached = ctx.blendSpaces.get(cacheKey);
  if (cached) return cached;
  const resolved = blendSpaceLayout(node);
  if (!resolved) {
    ctx.blendSpaces.set(cacheKey, EMPTY_BLEND_SPACE);
    return EMPTY_BLEND_SPACE;
  }
  const axes = resolved.axes;
  const previous = fresh ? undefined : ctx.previousSelectors[key];
  const input = [dataValue(data, node, "x", 0), dataValue(data, node, "y", 0)];
  const smoothed = axes.map((axis, index) => smoothAxis(axis, previous?.[index], input[index]!, dtSeconds));
  ctx.selectors[key] = smoothed;
  const point = { x: smoothed[0]!, y: smoothed[1] ?? 0 };
  if (node.type === ANIM_FRAME_SPRITE_BLEND_SPACE_PLAYER_TYPE) {
    const held = fresh ? undefined : ctx.previousSelectors[key + SAMPLE_KEY]?.[0];
    const index = nearestBlendSpaceSample(resolved.layout, point, held ?? null, resolved.hysteresis);
    ctx.selectors[key + SAMPLE_KEY] = [index];
    const sample = resolved.samples[index];
    const tick: BlendSpaceTick = {
      samples: resolved.samples,
      weights: resolved.samples.map((_, position) => (position === index ? 1 : 0)),
      cycleMs: sample ? sample.durationMs / sample.rateScale : STATE_CLOCK_MS,
      restart: held !== undefined && held !== index && !resolved.keepTime,
    };
    ctx.blendSpaces.set(cacheKey, tick);
    return tick;
  }
  const weights = blendSpaceWeights(resolved.layout, point, resolved.triangles);
  let cycleMs = 0;
  resolved.samples.forEach((sample, index) => {
    cycleMs += (weights[index] ?? 0) * (sample.durationMs / sample.rateScale);
  });
  const tick = { samples: resolved.samples, weights, cycleMs: cycleMs > 0 ? cycleMs : STATE_CLOCK_MS, restart: false };
  ctx.blendSpaces.set(cacheKey, tick);
  return tick;
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

/** Which of a Blend Space's samples fire their events. */
function blendSpaceEventMode(node: GraphNode): "highestWeight" | "all" | "none" {
  const raw = node.data.blendSpace;
  const mode = raw && typeof raw === "object" ? (raw as Record<string, unknown>).eventMode : undefined;
  return mode === "all" || mode === "none" ? mode : "highestWeight";
}

/** A mask list with one more Layered Blend Per Bone input inside it. */
function withMask(masks: readonly AnimLayerMaskRef[] | undefined, blend: number, input: number): AnimLayerMaskRef[] {
  return masks ? [...masks, { blend, input }] : [{ blend, input }];
}

/** Each blend input's branch filters as keys, kept per node object (graphs are replaced, never mutated). */
const layeredBlendKeys = new WeakMap<GraphNode, string[]>();

function layeredBlendFilterKeys(node: GraphNode): string[] {
  let keys = layeredBlendKeys.get(node);
  if (!keys) {
    keys = layeredBlendFilters(node).map(animBranchFilterKey);
    layeredBlendKeys.set(node, keys);
  }
  return keys;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A vector pin's value as `[x, y, z]`, missing components taking `fallback`'s. */
function vectorOf(value: unknown, fallback: number): number[] {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return [finiteOr(row.x, fallback), finiteOr(row.y, fallback), finiteOr(row.z, fallback)];
}

/**
 * A Transform Bone's change at `alpha`: its Translation, Rotation (a rotator, sent as a quaternion) and Scale
 * channels whose mode is not Ignore. Null when it names no bone or changes nothing.
 */
function transformBoneModifier(node: GraphNode, data: AnimPoseData | undefined, alpha: number): AnimBoneModifier | null {
  const bone = typeof node.data.bone === "string" ? node.data.bone.trim() : "";
  if (!bone || !(alpha > 0)) return null;
  const channel = (name: "translation" | "rotation" | "scale", value: () => number[]): AnimBoneChannel | undefined => {
    const mode = parseAnimBoneModifyMode(node.data[`${name}Mode`]);
    return mode === "ignore" ? undefined : { value: value(), mode, space: parseAnimBoneSpace(node.data[`${name}Space`]) };
  };
  const translation = channel("translation", () => vectorOf(dataValue<unknown>(data, node, "translation", null), 0));
  const rotation = channel("rotation", () => {
    const rotator = dataValue<unknown>(data, node, "rotation", null) as Record<string, unknown> | null;
    const q = rotatorToQuat({
      pitch: finiteOr(rotator?.pitch, 0),
      yaw: finiteOr(rotator?.yaw, 0),
      roll: finiteOr(rotator?.roll, 0),
    });
    return [q.x, q.y, q.z, q.w];
  });
  const scale = channel("scale", () => vectorOf(dataValue<unknown>(data, node, "scale", null), 1));
  if (!translation && !rotation && !scale) return null;
  return {
    kind: "transform",
    bone,
    alpha: Math.min(1, alpha),
    ...(translation ? { translation } : {}),
    ...(rotation ? { rotation } : {}),
    ...(scale ? { scale } : {}),
  };
}

function boneOf(node: GraphNode): string {
  return typeof node.data.bone === "string" ? node.data.bone.trim() : "";
}

/**
 * A Look At's target this tick: the one its Target pin gives, or, with an Interpolation Time, last tick's eased toward
 * it (a fresh visit starts at it). Kept in `ctx.lookAtTargets` for next tick.
 */
function easedLookAtTarget(ctx: EvalContext, key: string, node: GraphNode, target: number[], dtSeconds: number, fresh: boolean): number[] {
  const seconds = finiteOr(node.data.interpSeconds, 0);
  const previous = fresh ? undefined : ctx.previousLookAtTargets[key];
  let eased = target;
  if (seconds > 0 && previous && previous.length === 3) {
    // Exponential ease: about 95% of the way there after Interpolation Time.
    const t = 1 - Math.exp((-3 * Math.max(0, dtSeconds)) / seconds);
    eased = previous.map((value, i) => value + (target[i]! - value) * t);
  }
  ctx.lookAtTargets[key] = eased;
  return eased;
}

/** A Look At's change at `alpha`: its bone aimed at Target. Null when it names no bone. */
function lookAtModifier(node: GraphNode, target: number[], alpha: number): AnimBoneModifier | null {
  const bone = boneOf(node);
  if (!bone || !(alpha > 0)) return null;
  const up = node.data.upAxis;
  return {
    kind: "lookAt",
    bone,
    alpha: Math.min(1, alpha),
    target,
    targetSpace: parseAnimTargetSpace(node.data.targetSpace),
    aimAxis: animBoneAxisVector(node.data.aimAxis, "z"),
    ...(typeof up === "string" && up !== "none" ? { upAxis: animBoneAxisVector(up, "y") } : {}),
    limitDegrees: Math.min(180, Math.max(0, finiteOr(node.data.limitDegrees, 180))),
  };
}

/** A Two Bone IK's change at `alpha`: its bone reaching Effector. Null when it names no bone. */
function twoBoneIkModifier(node: GraphNode, data: AnimPoseData | undefined, alpha: number): AnimBoneModifier | null {
  const bone = boneOf(node);
  if (!bone || !(alpha > 0)) return null;
  return {
    kind: "twoBoneIk",
    bone,
    alpha: Math.min(1, alpha),
    effector: vectorOf(dataValue<unknown>(data, node, "effector", null), 0),
    effectorSpace: parseAnimTargetSpace(node.data.effectorSpace),
    ...(node.data.useJointTarget === true ? { jointTarget: vectorOf(dataValue<unknown>(data, node, "jointTarget", null), 0) } : {}),
    jointTargetSpace: parseAnimTargetSpace(node.data.jointTargetSpace),
    maxStretch: Math.max(1, finiteOr(node.data.maxStretch, 1)),
    keepEffectorRotation: node.data.keepEffectorRotation === true,
  };
}

/** A clip's root motion bone, as a layer names it for render to hold in place across the ground. */
function rootMotionBoneOf(value: unknown): { rootMotionBone?: string } {
  const bone = value && typeof value === "object" ? (value as { bone?: unknown }).bone : undefined;
  return typeof bone === "string" && bone ? { rootMotionBone: bone } : {};
}

/** Whether layers under `masks` play on a Layered Blend Per Bone's branch only, which root motion leaves out. */
function maskedToBranch(masks: readonly AnimLayerMaskRef[] | undefined): boolean {
  return !!masks && masks.some((mask) => mask.input >= 0);
}

/** A clip's root motion over its sweep, by `weight`: none in an additive context or on a branch alone. */
function addRootMotion(
  motion: RootMotionPart[],
  rootMotion: AnimClipRootMotion | undefined,
  sweep: AnimClipSweep,
  weight: number,
  masks: readonly AnimLayerMaskRef[] | undefined,
  additive: boolean,
): void {
  if (!rootMotion || additive || !(weight > 0) || maskedToBranch(masks)) return;
  motion.push({ ...animRootMotionDelta(rootMotion, sweep), weight });
}

/** Each Spring Bones node's settings, kept per node object (graphs are replaced, never mutated). */
const springSettings = new WeakMap<GraphNode, AnimSpringBoneSettings>();

/** A Spring Bones change at `alpha`, stepped by this tick's `dtSeconds`. Null when it names no Root Bone. */
function springBonesModifier(node: GraphNode, alpha: number, dtSeconds: number): AnimBoneModifier | null {
  const bone = boneOf(node);
  if (!bone || !(alpha > 0)) return null;
  let settings = springSettings.get(node);
  if (!settings) {
    settings = normalizeAnimSpringBoneSettings(node.data);
    springSettings.set(node, settings);
  }
  return { kind: "springBones", bone, alpha: Math.min(1, alpha), dtSeconds: Math.max(0, dtSeconds), settings };
}

/**
 * A cached pose's visit this tick: evaluated in the graph its Save Cached Pose is in, once a tick, at the tick's time
 * step, whichever state uses it first. Its players keep their time across the states that use it. An unknown name,
 * and a cached pose that uses itself, add nothing.
 */
function cachedPoseVisit(ctx: EvalContext, name: string, stateId: string): PoseVisit {
  if (ctx.cachedPoses.has(name)) return ctx.cachedPoses.get(name) ?? EMPTY_VISIT;
  const saved = machineIndex(ctx.machine).cachedPoses.get(name);
  if (!saved) {
    ctx.cachedPoses.set(name, EMPTY_VISIT);
    return EMPTY_VISIT;
  }
  ctx.cachedPoses.set(name, null);
  const graphKey = animPoseGraphKey(saved.stateId);
  const source = poseInputSource(poseGraphIndex(saved.graph), saved.node.id, "pose");
  const visit = source
    ? visitPoseGraph(ctx, graphKey, saved.graph, ctx.inputs.poseData?.(graphKey, null), ctx.dtSeconds, false, stateId, source)
    : EMPTY_VISIT;
  ctx.cachedPoses.set(name, visit);
  return visit;
}

/**
 * Walks a pose graph from its output (or `start`): advances every player and selector it reaches by `dtSeconds` (a
 * fresh visit starts them over) and returns its clip layers, the clip events its players crossed, the sources that
 * played and its bone changes, at weight 1. `stateId` tags them.
 */
function visitPoseGraph(
  ctx: EvalContext,
  graphKey: string,
  graph: SerializedGraph,
  data: AnimPoseData | undefined,
  dtSeconds: number,
  fresh: boolean,
  stateId: string,
  start?: GraphNode,
): PoseVisit {
  const index = poseGraphIndex(graph);
  if (!index.output && !start) return EMPTY_VISIT;
  const layers: AnimClipLayer[] = [];
  const pending: Pending[] = [];
  const sources: PoseVisit["sources"] = [];
  const modifiers: AnimBoneModifier[] = [];
  const motion: RootMotionPart[] = [];
  const visited = new Set<string>();
  const visit = (
    node: GraphNode | undefined,
    weight: number,
    flipX: boolean,
    flipY: boolean,
    masks?: AnimLayerMaskRef[],
    additive = false,
  ): void => {
    // A pose output feeds one input, so each node is reached once; a cycle stops here.
    if (!node || visited.has(node.id)) return;
    visited.add(node.id);
    const key = `${graphKey}#${node.id}`;
    const emit = (layer: Omit<AnimClipLayer, "weight" | "stateId">, additiveData: unknown = node.data.additive) => {
      if (weight <= 0) return;
      const base = parseResolvedClipAdditive(additiveData);
      layers.push({
        ...layer,
        stateId,
        weight,
        ...(flipX ? { flipX: true } : {}),
        ...(flipY ? { flipY: true } : {}),
        ...(masks ? { masks } : {}),
        ...(additive ? { additive: true } : {}),
        ...(base?.base === "clip"
          ? { additiveBase: { clipAssetGuid: base.clipAssetGuid, clipName: base.clipName, normalisedTime: base.normalisedTime } }
          : {}),
        ...(layer.rootMotionBone ? {} : rootMotionBoneOf(node.data.rootMotion)),
      });
    };
    if (isPoseOutputType(node.type)) {
      visit(firstPoseInput(index, node), weight, flipX, flipY, masks, additive);
      return;
    }
    if (isPosePlayerType(node.type)) {
      const timing = playerTiming(node, data);
      const kept = fresh ? undefined : ctx.previousPlayers[key];
      const previous = kept ?? playerStart(node, data, timing.durationMs);
      // A Play Rate at or below 0 holds the frame.
      const advanced = advanceClock(previous, timing.playRate > 0 ? dtSeconds * 1000 * timing.playRate : 0, timing.durationMs, timing.loop);
      // A looping player in a Sync Group runs at the group's phase.
      const clock = timing.loop
        ? syncedClock(ctx, node, advanced, timing.durationMs / Math.max(0.001, timing.playRate), weight)
        : advanced;
      ctx.players[key] = { timeMs: clock.timeMs, loopCount: clock.loopCount, normalised: clock.normalised };
      const clip = poseClipData(node);
      if (clip.assetGuid) {
        emit({ clipAssetGuid: clip.assetGuid, clipName: clip.clipName, clipKind: node.type.startsWith("anim.frame.") ? "sprite" : "animation", normalisedTime: clock.normalised });
        // A player starting over counts an event exactly at its start.
        if (!kept) pending.push({ restart: key });
        sources.push({ key, weight });
        const sweep = animClipSweep(previous, clock, timing.loop, !kept);
        sweepEvents(pending, poseClipEvents(node), sweep, timing.durationMs, {
          clipAssetGuid: clip.assetGuid,
          stateId,
          weight,
          source: key,
        });
        addRootMotion(motion, parseAnimClipRootMotion(node.data.rootMotion), sweep, weight, masks, additive);
      }
      return;
    }
    if (isBlendSpacePlayerType(node.type)) {
      const tick = blendSpaceTick(ctx, key, node, data, dtSeconds, fresh);
      const playRate = dataValue(data, node, "playRate", 1);
      // Every sample shares one phase; the cycle's length follows the weights, so the phase carries over, not the time.
      const kept = fresh || tick.restart ? undefined : ctx.previousPlayers[key];
      const prior = kept ?? ZERO_CLOCK;
      const clock = syncedClock(
        ctx,
        node,
        advanceClock(
          { ...prior, timeMs: prior.normalised * tick.cycleMs },
          playRate > 0 ? dtSeconds * 1000 * playRate : 0,
          tick.cycleMs,
          true,
        ),
        tick.cycleMs / Math.max(0.001, playRate),
        weight,
      );
      ctx.players[key] = { timeMs: clock.timeMs, loopCount: clock.loopCount, normalised: clock.normalised };
      if (!kept) pending.push({ restart: key });
      const sweep = animClipSweep(prior, clock, true, !kept);
      // A sample's events, at their positions in its own pass, which the shared phase runs through.
      const sampleEvents = (position: number, sampleWeight: number) => {
        const sample = tick.samples[position];
        if (!sample) return;
        const source = `${key}@${position}`;
        sources.push({ key: source, weight: sampleWeight });
        sweepEvents(pending, sample.events ?? [], sweep, sample.durationMs, {
          clipAssetGuid: sample.animationGuid,
          stateId,
          weight: sampleWeight,
          source,
        });
      };
      if (node.type === ANIM_FRAME_SPRITE_BLEND_SPACE_PLAYER_TYPE) {
        // Frames cannot blend: the playing sample shows alone, flipped as the graph flips it.
        const position = tick.weights.indexOf(1);
        const playing = tick.samples[position];
        if (playing) {
          emit({ clipAssetGuid: playing.animationGuid, clipName: "", clipKind: "sprite", normalisedTime: clock.normalised });
          sampleEvents(position, weight);
        }
        return;
      }
      const mode = blendSpaceEventMode(node);
      if (mode === "highestWeight") {
        // One footstep however the blend falls: the heaviest sample's events, at the Blend Space's own weight.
        let heaviest = -1;
        tick.weights.forEach((sampleWeight, position) => {
          if (sampleWeight > BLEND_SPACE_MIN_WEIGHT && (heaviest < 0 || sampleWeight > tick.weights[heaviest]!)) heaviest = position;
        });
        if (heaviest >= 0) sampleEvents(heaviest, weight);
      } else if (mode === "all") {
        tick.weights.forEach((sampleWeight, position) => {
          if (sampleWeight > BLEND_SPACE_MIN_WEIGHT) sampleEvents(position, weight * sampleWeight);
        });
      }
      tick.samples.forEach((sample, position) => {
        const sampleWeight = tick.weights[position] ?? 0;
        if (sampleWeight <= BLEND_SPACE_MIN_WEIGHT || weight <= 0) return;
        addRootMotion(motion, sample.rootMotion, sweep, weight * sampleWeight, masks, additive);
        const base = sample.additive;
        const rootBone = rootMotionBoneOf(sample.rootMotion);
        layers.push({
          stateId,
          clipAssetGuid: sample.animationGuid,
          clipName: sample.clipName,
          clipKind: "animation",
          normalisedTime: clock.normalised,
          weight: weight * sampleWeight,
          ...(masks ? { masks } : {}),
          ...(additive ? { additive: true } : {}),
          ...(base?.base === "clip"
            ? { additiveBase: { clipAssetGuid: base.clipAssetGuid, clipName: base.clipName, normalisedTime: base.normalisedTime } }
            : {}),
          ...rootBone,
        });
      });
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
      visit(poseInputSource(index, node.id, "a"), weight * (1 - alpha), flipX, flipY, masks, additive);
      visit(poseInputSource(index, node.id, "b"), weight * alpha, flipX, flipY, masks, additive);
      return;
    }
    if (isSlotNodeType(node.type)) {
      // A slot animation shows over the Source, which keeps playing underneath.
      const slot = ctx.slots[slotNodeName(node)];
      const source = poseInputSource(index, node.id, "source");
      const active = slot?.active && slot.active.weight > 0 ? slot.active : undefined;
      const outgoing = slot?.outgoing && slot.outgoing.weight > 0 ? slot.outgoing : undefined;
      const layer = (playback: AnimSlotPlayback) => ({
        clipAssetGuid: playback.clip.assetGuid,
        clipName: playback.clip.clipName,
        clipKind: playback.clip.clipKind,
        normalisedTime: slotClock(playback).normalised,
        ...rootMotionBoneOf(playback.clip.rootMotion),
      });
      if (node.type === ANIM_FRAME_SLOT_TYPE) {
        // Frames cannot blend: the slot's newest play shows alone while it has any weight.
        const shown = active ?? outgoing;
        visit(source, shown ? 0 : weight, flipX, flipY, masks, additive);
        if (shown) emit(layer(shown), undefined);
        return;
      }
      const a = active?.weight ?? 0;
      const b = outgoing?.weight ?? 0;
      const share = a + b > 1 ? 1 / (a + b) : 1;
      visit(source, weight * (1 - Math.min(1, a + b)), flipX, flipY, masks, additive);
      const scaled = (playback: AnimSlotPlayback, slotWeight: number) => {
        if (weight * slotWeight <= 0) return;
        layers.push({
          ...layer(playback),
          stateId,
          weight: weight * slotWeight,
          ...(masks ? { masks } : {}),
          ...(additive ? { additive: true } : {}),
        });
      };
      if (outgoing) scaled(outgoing, b * share);
      if (active) scaled(active, a * share);
      return;
    }
    if (node.type === ANIM_POSE_APPLY_ADDITIVE_TYPE) {
      // The Additive input's clips add their change from their base pose, at Alpha, to the Base input's pose.
      const alpha = Math.min(1, Math.max(0, dataValue(data, node, "alpha", 1)));
      visit(poseInputSource(index, node.id, "base"), weight, flipX, flipY, masks, additive);
      visit(poseInputSource(index, node.id, "additive"), weight * alpha, flipX, flipY, masks, true);
      return;
    }
    if (node.type === ANIM_POSE_LAYERED_BLEND_TYPE) {
      // Each blend input plays at its Blend Weight on its branches' bones; render works out the per-bone weights.
      const filters = layeredBlendFilterKeys(node);
      const weights = filters.map((_, position) =>
        Math.min(1, Math.max(0, dataValue(data, node, `blendWeight${position}`, 1))));
      const blend = weights.some((value) => value > 0) && weight > 0 ? ctx.layerBlends.push({ filters, weights }) - 1 : -1;
      visit(poseInputSource(index, node.id, "basePose"), weight, flipX, flipY, blend < 0 ? masks : withMask(masks, blend, -1), additive);
      filters.forEach((_, position) => {
        const source = poseInputSource(index, node.id, `blendPose${position}`);
        visit(source, weight * weights[position]!, flipX, flipY, blend < 0 ? masks : withMask(masks, blend, position), additive);
      });
      return;
    }
    if (node.type === ANIM_POSE_USE_CACHED_TYPE) {
      const name = cachedPoseName(node);
      const cached = cachedPoseVisit(ctx, name, stateId);
      pending.push({ cached: name, weight });
      if (weight <= 0) return;
      for (const layer of cached.layers) {
        const nested = masks && layer.masks ? [...masks, ...layer.masks] : masks ?? layer.masks;
        layers.push({
          ...layer,
          stateId,
          weight: layer.weight * weight,
          ...(nested ? { masks: nested } : {}),
          ...(additive ? { additive: true } : {}),
        });
      }
      for (const source of cached.sources) sources.push({ key: source.key, weight: source.weight * weight });
      // Bone changes and root motion belong to the whole pose: an additive input has none.
      if (additive) return;
      if (!maskedToBranch(masks)) for (const part of cached.motion) motion.push({ ...part, weight: part.weight * weight });
      for (const modifier of cached.modifiers) {
        const nested = masks && modifier.masks ? [...masks, ...modifier.masks] : masks ?? modifier.masks;
        modifiers.push({ ...modifier, alpha: modifier.alpha * weight, ...(nested ? { masks: nested } : {}) });
      }
      return;
    }
    if (
      node.type === ANIM_CONTROL_TRANSFORM_BONE_TYPE || node.type === ANIM_CONTROL_LOOK_AT_TYPE ||
      node.type === ANIM_CONTROL_TWO_BONE_IK_TYPE || node.type === ANIM_CONTROL_SPRING_BONES_TYPE
    ) {
      // The bone changes after the pose it takes, so a change deeper in the graph applies first.
      visit(poseInputSource(index, node.id, "sourcePose"), weight, flipX, flipY, masks, additive);
      if (additive) return;
      const alpha = Math.min(1, Math.max(0, dataValue(data, node, "alpha", 1))) * weight;
      const modifier = node.type === ANIM_CONTROL_TRANSFORM_BONE_TYPE
        ? transformBoneModifier(node, data, alpha)
        : node.type === ANIM_CONTROL_TWO_BONE_IK_TYPE
          ? twoBoneIkModifier(node, data, alpha)
          : node.type === ANIM_CONTROL_SPRING_BONES_TYPE
            ? springBonesModifier(node, alpha, dtSeconds)
            : lookAtModifier(node, easedLookAtTarget(ctx, key, node, vectorOf(dataValue<unknown>(data, node, "target", null), 0), dtSeconds, fresh), alpha);
      if (modifier) modifiers.push(masks ? { ...modifier, masks } : modifier);
      return;
    }
    if (node.type === ANIM_POSE_BLEND_BY_BOOL_TYPE || node.type === ANIM_POSE_BLEND_BY_INT_TYPE) {
      const pins = poseInputPins(node.type, node.data.count);
      const target = node.type === ANIM_POSE_BLEND_BY_BOOL_TYPE
        ? (dataValue(data, node, "active", true) ? 0 : 1)
        : clampIndex(dataValue(data, node, "activeIndex", 0), pins.length);
      const weights = blendSelector(ctx, key, node, pins.length, target, dtSeconds, fresh);
      pins.forEach((pin, position) => visit(poseInputSource(index, node.id, pin), weight * weights[position]!, flipX, flipY, masks, additive));
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
    // Rest Pose, Save Cached Pose (read only through its uses) and unknown nodes add no clip: the bones keep their
    // rest pose.
  };
  visit(start ?? index.output, 1, false, false);
  return { layers, pending, sources, modifiers, motion };
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

/**
 * A state's clock and facts: its primary player's, else a one-second looping state clock. A Blend Space Player's
 * cycle changes with its weights, so its state carries its phase over (`synced`), not its time.
 */
function stateTiming(
  ctx: EvalContext,
  stateId: string,
  state: AnimState,
  data: AnimPoseData | undefined,
  dtSeconds: number,
  fresh: boolean,
): { durationMs: number; playRate: number; loop: boolean; synced: boolean; restart: boolean } {
  const player = primaryPosePlayer(state.stateGraph);
  if (!player) return { durationMs: STATE_CLOCK_MS, playRate: 1, loop: true, synced: false, restart: false };
  if (isBlendSpacePlayerType(player.type)) {
    const tick = blendSpaceTick(ctx, `${animPoseGraphKey(stateId)}#${player.id}`, player, data, dtSeconds, fresh);
    return { durationMs: tick.cycleMs, playRate: dataValue(data, player, "playRate", 1), loop: true, synced: true, restart: tick.restart };
  }
  return { ...playerTiming(player, data), synced: false, restart: false };
}

/**
 * A state clock whose primary player is in a Sync Group follows the group's phase, as its player does; a wrap past
 * the end counts a loop.
 */
function syncedStateClock(
  ctx: EvalContext,
  state: AnimState,
  clock: Clock,
  start: AnimPlayerClock,
  timing: { durationMs: number; playRate: number; loop: boolean },
): Clock {
  const player = primaryPosePlayer(state.stateGraph);
  if (!player || !timing.loop) return clock;
  const group = poseSyncGroup(player);
  if (!group) return clock;
  const phase = syncGroupPhase(ctx, group, timing.durationMs / Math.max(0.001, timing.playRate), 1);
  if (phase === null) return clock;
  const wrapped = phase + 1e-9 < start.normalised;
  return {
    ...clock,
    normalised: phase,
    timeMs: phase * timing.durationMs,
    justLooped: wrapped,
    loopCount: start.loopCount + (wrapped ? 1 : 0),
  };
}

/** Where a state's clock starts on entry: at its primary player's start, else at 0. */
function stateStart(state: AnimState, data: AnimPoseData | undefined, durationMs: number): AnimPlayerClock {
  const player = primaryPosePlayer(state.stateGraph);
  return player && !isBlendSpacePlayerType(player.type) ? playerStart(player, data, durationMs) : ZERO_CLOCK;
}

/** The State Machine's tick: run its active state's graph and transitions, and blend. */
function evaluateMachine(
  ctx: EvalContext,
  machine: AnimStateMachine,
  previous: AnimMachineEvalState | null,
  dtSeconds: number,
): { state: AnimMachineEvalState; layers: AnimClipLayer[]; pending: Pending[]; sources: PoseVisit["sources"]; modifiers: AnimBoneModifier[]; motion: RootMotionPart[] } {
  const { states, outgoing: outgoingByState } = machineIndex(machine);
  const entryStateId = states.has(machine.entryStateId) ? machine.entryStateId : machine.states[0]?.id;
  let stateId = previous?.stateId ?? entryStateId;
  if (stateId === undefined || !states.has(stateId)) stateId = entryStateId;
  if (stateId === undefined) return { state: idleMachineState(machine.entryStateId), layers: [], pending: [], sources: [], modifiers: [], motion: [] };
  const current = states.get(stateId)!;
  // A jump leaves the target with a negative time, which enters it fresh.
  const sameState = previous !== null && previous.stateId === stateId && previous.timeMs >= 0;
  const entered = !sameState;
  const currentKey = animPoseGraphKey(stateId);
  // Data inputs see the state's facts from before this tick's advance.
  const currentData = ctx.inputs.poseData?.(currentKey, previous && sameState ? previous.facts : null);
  const timing = stateTiming(ctx, stateId, current, currentData, dtSeconds, entered);
  const start = sameState
    ? timing.restart
      ? { timeMs: 0, loopCount: previous.loopCount, normalised: 0 }
      : {
          timeMs: timing.synced ? previous.normalisedTime * timing.durationMs : previous.timeMs,
          loopCount: previous.loopCount,
          normalised: previous.normalisedTime,
        }
    : stateStart(current, currentData, timing.durationMs);
  const previousTotal = sameState
    ? totalNormalisedTime(previous.facts.looping, previous.loopCount, previous.normalisedTime)
    : start.normalised;
  const clock = syncedStateClock(
    ctx,
    current,
    advanceClock(start, timing.playRate > 0 ? dtSeconds * 1000 * timing.playRate : 0, timing.durationMs, timing.loop),
    start,
    timing,
  );
  const currentFacts = factsFor(clock, timing.durationMs / Math.max(0.001, timing.playRate), timing.loop, previousTotal);
  const currentVisit = visitPoseGraph(ctx, currentKey, current.stateGraph, currentData, dtSeconds, entered, stateId);

  let nextId = stateId;
  let nextClock: Clock = clock;
  let nextFacts = currentFacts;
  let nextVisit = currentVisit;
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
    const nextTiming = stateTiming(ctx, nextId, next, nextData, 0, true);
    const nextStart = stateStart(next, nextData, nextTiming.durationMs);
    // Entering a state whose player shares a Sync Group picks up the group's phase, so a stride carries on.
    nextClock = syncedStateClock(ctx, next, { ...nextStart, justLooped: false, justFinished: false }, nextStart, nextTiming);
    nextClock = { ...nextClock, justLooped: false };
    nextFacts = factsFor(nextClock, nextTiming.durationMs / Math.max(0.001, nextTiming.playRate), nextTiming.loop, nextStart.normalised);
    // A self-transition restarts the state, and its blend crossfades from the frame it left.
    nextVisit = visitPoseGraph(ctx, nextKey, next.stateGraph, nextData, 0, true, nextId);
    break;
  }
  const transitioned = nextVisit !== currentVisit;

  let blendFromStateId = previous?.blendFromStateId ?? null;
  let blendElapsedMs = previous?.blendElapsedMs ?? 0;
  let blendSeconds = previous?.blendSeconds ?? 0;
  let fromVisit: PoseVisit = EMPTY_VISIT;
  // Blending from a state that is still blending out keeps the frame it left.
  const wasBlending = !!blendFromStateId;
  if (startedBlend) {
    blendFromStateId = stateId;
    blendElapsedMs = Math.max(0, dtSeconds) * 1000;
    blendSeconds = startedBlend.blendSeconds;
    fromVisit = currentVisit;
  } else if (nextId !== stateId) {
    blendFromStateId = null;
    blendElapsedMs = 0;
    blendSeconds = 0;
  } else if (blendFromStateId && blendFromStateId !== nextId && states.has(blendFromStateId)) {
    blendElapsedMs += Math.max(0, dtSeconds) * 1000;
    const from = states.get(blendFromStateId)!;
    const fromKey = animPoseGraphKey(blendFromStateId);
    fromVisit = visitPoseGraph(ctx, fromKey, from.stateGraph, ctx.inputs.poseData?.(fromKey, null), dtSeconds, false, blendFromStateId);
  } else {
    blendFromStateId = null;
    blendElapsedMs = 0;
    blendSeconds = 0;
  }

  const blendWeights: Record<string, number> = {};
  let toWeight = 1;
  let fromWeight = 0;
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
      fromWeight = 1 - t;
      blendWeights[blendFromStateId] = 1 - t;
    }
  } else if (blendFromStateId) {
    blendFromStateId = null;
    blendElapsedMs = 0;
    blendSeconds = 0;
  }
  const from = scaleVisit(fromVisit, fromWeight);
  const to = scaleVisit(nextVisit, toWeight);
  layers.push(...from.layers, ...to.layers);
  blendWeights[nextId] = (blendWeights[nextId] ?? 0) + toWeight;

  // Events in the order they happened: the state left (its own crossings, then Exit), the state entered (Enter, then
  // its crossings), and Fully Blended once it plays alone.
  const pending: Pending[] = [];
  const sources = [...from.sources, ...to.sources];
  const enteredFresh = previous === null || previous.timeMs < 0;
  // A jump left a state: its Exit fires before the target's Enter.
  if (enteredFresh && previous?.exitingStateId) pending.push(...stateEvent(states.get(previous.exitingStateId)?.events?.exit, previous.exitingStateId));
  if (enteredFresh) pending.push(...stateEvent(current.events?.enter, stateId));
  if (transitioned) {
    // A crossfade keeps the left state playing in `from`; an instant transition stops it at once.
    pending.push(...(startedBlend ? from.pending : scaleVisit(currentVisit, 0).pending));
    pending.push(...stateEvent(current.events?.exit, stateId));
    pending.push(...stateEvent(states.get(nextId)?.events?.enter, nextId));
    pending.push(...to.pending);
  } else {
    pending.push(...from.pending, ...to.pending);
  }
  // Fully Blended: on entry with no crossfade, or the tick a crossfade into this state completes.
  const fullyBlended = !blendFromStateId && (transitioned || enteredFresh || (wasBlending && previous?.stateId === nextId));
  if (fullyBlended) pending.push(...stateEvent(states.get(nextId)?.events?.fullyBlended, nextId));

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
  return { state, layers, pending, sources, modifiers: [...from.modifiers, ...to.modifiers], motion: [...from.motion, ...to.motion] };
}

/**
 * The tick's events with each cached pose's own events in place of its uses: once, where it was first used, at its
 * uses' summed weight (at most 1), a cached pose used inside another counting that one's weight.
 */
function resolveCachedPoseEvents(ctx: EvalContext, pending: readonly Pending[]): readonly Pending[] {
  if (ctx.cachedPoses.size === 0) return pending;
  const totals = new Map<string, number>();
  const total = (items: readonly Pending[], scale: number, depth: number) => {
    for (const item of items) {
      if (!("cached" in item)) continue;
      const weight = item.weight * scale;
      totals.set(item.cached, (totals.get(item.cached) ?? 0) + weight);
      const visit = ctx.cachedPoses.get(item.cached);
      if (visit && depth < MAX_CACHED_POSE_DEPTH) total(visit.pending, weight, depth + 1);
    }
  };
  total(pending, 1, 0);
  const resolved: Pending[] = [];
  const placed = new Set<string>();
  const place = (items: readonly Pending[], scale: number) => {
    for (const item of items) {
      if (!("cached" in item)) {
        resolved.push(scale === 1 || "restart" in item ? item : { ...item, weight: item.weight * scale });
        continue;
      }
      if (placed.has(item.cached)) continue;
      placed.add(item.cached);
      const visit = ctx.cachedPoses.get(item.cached);
      if (visit) place(visit.pending, Math.min(1, totals.get(item.cached) ?? 0));
    }
  };
  place(pending, 1);
  return resolved;
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
  const dtMs = Math.max(0, Number.isFinite(dtSeconds) ? dtSeconds : 0) * 1000;
  // Slots run for the whole graph, before the State Machine, whichever state shows them.
  const slotTick = advanceAnimSlots(previous?.slots, inputs.slotRequests, dtMs);
  const ctx: EvalContext = {
    inputs,
    slots: slotTick.slots,
    machine: doc.stateMachine,
    dtSeconds,
    layerBlends: [],
    cachedPoses: new Map(),
    previousPlayers: previous?.players ?? {},
    players: {},
    previousSelectors: previous?.selectors ?? {},
    selectors: {},
    blendSpaces: new Map(),
    dtMs: Math.max(0, Number.isFinite(dtSeconds) ? dtSeconds : 0) * 1000,
    previousLookAtTargets: previous?.lookAtTargets ?? {},
    lookAtTargets: {},
    previousSyncGroups: previous?.syncGroups ?? {},
    syncGroups: new Map(),
  };
  const { state, layers, pending, sources, modifiers, motion } = evaluateMachine(ctx, doc.stateMachine, previous, dtSeconds);
  // A slot animation's clip events fire at its weight, under the state playing.
  for (const sweep of slotTick.sweeps) {
    const { playback } = sweep;
    const source = `slot:${sweep.slot}#${playback.id}`;
    if (sweep.fresh) pending.push({ restart: source });
    sources.push({ key: source, weight: playback.weight });
    const clipSweep = animClipSweep(sweep.previous, sweep.next, playback.loopCount !== 1, sweep.fresh);
    sweepEvents(
      pending,
      playback.clip.events ?? [],
      clipSweep,
      playback.clip.durationMs,
      { clipAssetGuid: playback.clip.assetGuid, stateId: state.stateId, weight: playback.weight, source },
    );
    // A slot's root motion moves the actor at its weight, as the pose under it gives way.
    addRootMotion(motion, playback.clip.rootMotion, clipSweep, playback.weight, undefined, false);
  }
  const result: AnimEvalState = { ...state, players: ctx.players, selectors: ctx.selectors, layers };
  if (Object.keys(slotTick.slots).length > 0) result.slots = slotTick.slots;
  if (slotTick.events.length > 0) result.slotEvents = slotTick.events;
  if (ctx.layerBlends.length > 0) result.layerBlends = ctx.layerBlends;
  if (modifiers.length > 0) result.boneModifiers = modifiers;
  if (Object.keys(ctx.lookAtTargets).length > 0) result.lookAtTargets = ctx.lookAtTargets;
  const rootMotion = sumAnimRootMotion(motion);
  if (rootMotion) result.rootMotion = rootMotion;
  const playing = new Map<string, number>();
  for (const source of sources) playing.set(source.key, Math.max(playing.get(source.key) ?? 0, source.weight));
  const { fired, open } = fireEvents(resolveCachedPoseEvents(ctx, pending), playing, previous?.openWindows);
  if (fired.length > 0) result.events = fired;
  if (open.size > 0) result.openWindows = Object.fromEntries(open);
  if (ctx.syncGroups.size > 0) {
    result.syncGroups = Object.fromEntries(
      [...ctx.syncGroups].map(([group, entry]) => [group, { phase: entry.phase, cycleMs: entry.leaderCycleMs }]),
    );
  }
  return result;
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
  const { events: _fired, slotEvents: _slotEvents, ...kept } = base;
  void _fired;
  void _slotEvents;
  return {
    ...kept,
    ...idleMachineState(stateId),
    timeMs: -1,
    // The state left fires its Exit event on the next evaluation, which enters the target.
    ...(previous ? { exitingStateId: previous.stateId } : {}),
  };
}
