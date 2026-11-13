import type { SerializedGraph } from "@haptic/core";

type SerializedGraphNode = SerializedGraph["nodes"][number];

/**
 * Pose graphs: the top-level Anim Graph and each state's graph. Pose (3D) and frame (2D) wires are read here as
 * structure; data inputs (Play Rate, Alpha, Active) come from a compiled pose-data module, or from the value stored
 * on the node when the input is unwired.
 */

export const ANIM_POSE_OUTPUT_TYPE = "anim.pose.output";
export const ANIM_POSE_STATE_MACHINE_TYPE = "anim.pose.stateMachine";
export const ANIM_POSE_SEQUENCE_PLAYER_TYPE = "anim.pose.sequencePlayer";
export const ANIM_POSE_SEQUENCE_EVALUATOR_TYPE = "anim.pose.sequenceEvaluator";
export const ANIM_POSE_REST_TYPE = "anim.pose.restPose";
export const ANIM_POSE_BLEND_TYPE = "anim.pose.blend";
export const ANIM_POSE_BLEND_BY_BOOL_TYPE = "anim.pose.blendByBool";
export const ANIM_POSE_BLEND_BY_INT_TYPE = "anim.pose.blendByInt";
export const ANIM_FRAME_OUTPUT_TYPE = "anim.frame.output";
export const ANIM_FRAME_STATE_MACHINE_TYPE = "anim.frame.stateMachine";
export const ANIM_FRAME_PLAYER_TYPE = "anim.frame.spritePlayer";
export const ANIM_FRAME_SELECT_BY_BOOL_TYPE = "anim.frame.selectByBool";
export const ANIM_FRAME_SELECT_BY_INT_TYPE = "anim.frame.selectByInt";
export const ANIM_FRAME_FLIP_TYPE = "anim.frame.flip";

/** The protected output node every pose graph has, under this id. */
export const ANIM_POSE_OUTPUT_NODE_ID = "output";

export type AnimPoseDimension = "3d" | "2d";

export function poseOutputType(dimension: AnimPoseDimension): string {
  return dimension === "3d" ? ANIM_POSE_OUTPUT_TYPE : ANIM_FRAME_OUTPUT_TYPE;
}

export function poseStateMachineType(dimension: AnimPoseDimension): string {
  return dimension === "3d" ? ANIM_POSE_STATE_MACHINE_TYPE : ANIM_FRAME_STATE_MACHINE_TYPE;
}

export function posePlayerType(dimension: AnimPoseDimension): string {
  return dimension === "3d" ? ANIM_POSE_SEQUENCE_PLAYER_TYPE : ANIM_FRAME_PLAYER_TYPE;
}

export function isPoseOutputType(type: string): boolean {
  return type === ANIM_POSE_OUTPUT_TYPE || type === ANIM_FRAME_OUTPUT_TYPE;
}

export function isPoseStateMachineType(type: string): boolean {
  return type === ANIM_POSE_STATE_MACHINE_TYPE || type === ANIM_FRAME_STATE_MACHINE_TYPE;
}

/** Nodes that play a clip and keep their own time. */
export function isPosePlayerType(type: string): boolean {
  return type === ANIM_POSE_SEQUENCE_PLAYER_TYPE || type === ANIM_FRAME_PLAYER_TYPE;
}

/** Nodes that name a clip asset: players and the Sequence Evaluator. */
export function isPoseClipNodeType(type: string): boolean {
  return isPosePlayerType(type) || type === ANIM_POSE_SEQUENCE_EVALUATOR_TYPE;
}

/** The pose (or frame) inputs of a node type, in order; `count` is a Blend Poses By Int / Select By Int's. */
export function poseInputPins(type: string, count: unknown = 2): string[] {
  switch (type) {
    case ANIM_POSE_OUTPUT_TYPE: return ["pose"];
    case ANIM_FRAME_OUTPUT_TYPE: return ["frame"];
    case ANIM_POSE_BLEND_TYPE: return ["a", "b"];
    case ANIM_POSE_BLEND_BY_BOOL_TYPE: return ["truePose", "falsePose"];
    case ANIM_FRAME_SELECT_BY_BOOL_TYPE: return ["trueFrame", "falseFrame"];
    case ANIM_POSE_BLEND_BY_INT_TYPE: return Array.from({ length: inputCount(count) }, (_, index) => `pose${index}`);
    case ANIM_FRAME_SELECT_BY_INT_TYPE: return Array.from({ length: inputCount(count) }, (_, index) => `frame${index}`);
    case ANIM_FRAME_FLIP_TYPE: return ["frame"];
    default: return [];
  }
}

function inputCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(2, Math.min(16, Math.round(count))) : 2;
}

export interface PoseGraphIndex {
  nodes: Map<string, SerializedGraphNode>;
  /** The node wired into each pose input, keyed `nodeId\0pinId`. */
  poseSource: Map<string, string>;
  /** The output node, or undefined in a graph that lost it. */
  output: SerializedGraphNode | undefined;
}

const poseIndexes = new WeakMap<SerializedGraph, PoseGraphIndex>();

/** Derived once per graph object; graphs are replaced, never mutated. */
export function poseGraphIndex(graph: SerializedGraph): PoseGraphIndex {
  let index = poseIndexes.get(graph);
  if (!index) {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const poseSource = new Map<string, string>();
    for (const edge of graph.edges) {
      const target = nodes.get(edge.target);
      if (!target || !edge.targetHandle || !nodes.has(edge.source)) continue;
      if (!poseInputPins(target.type, target.data.count).includes(edge.targetHandle)) continue;
      poseSource.set(`${edge.target}\u0000${edge.targetHandle}`, edge.source);
    }
    index = { nodes, poseSource, output: graph.nodes.find((node) => isPoseOutputType(node.type)) };
    poseIndexes.set(graph, index);
  }
  return index;
}

export function poseInputSource(index: PoseGraphIndex, nodeId: string, pin: string): SerializedGraphNode | undefined {
  const source = index.poseSource.get(`${nodeId}\u0000${pin}`);
  return source === undefined ? undefined : index.nodes.get(source);
}

/** A node's stored value for a data input (`default:<pin>`), else `fallback`. */
export function poseNodeDefault<T>(node: SerializedGraphNode, pin: string, fallback: T): T {
  const value = node.data[`default:${pin}`];
  if (typeof fallback === "number") return (typeof value === "number" && Number.isFinite(value) ? value : fallback) as T;
  if (typeof fallback === "boolean") return (typeof value === "boolean" ? value : fallback) as T;
  return (value ?? fallback) as T;
}

/** The clip a player or Sequence Evaluator names, as stored on the node. */
export interface PoseClipData {
  assetGuid: string;
  /** Filled from the Animation asset at load (`resolveAnimGraphClips`); empty for a Sprite Animation. */
  clipName: string;
  durationMs: number;
  loop: boolean;
}

export function poseClipData(node: SerializedGraphNode): PoseClipData {
  const data = node.data;
  const durationMs = typeof data.durationMs === "number" && Number.isFinite(data.durationMs) && data.durationMs > 0
    ? data.durationMs
    : 1000;
  return {
    assetGuid: typeof data.assetGuid === "string" ? data.assetGuid : "",
    clipName: typeof data.clipName === "string" ? data.clipName : "",
    durationMs,
    loop: data.loop !== false,
  };
}

/**
 * The player a state's facts follow (its time, length and loop): reached from the output through the first pose
 * input of each node on the way. Null when that path ends without one.
 */
export function primaryPosePlayer(graph: SerializedGraph): SerializedGraphNode | null {
  const index = poseGraphIndex(graph);
  let node = index.output;
  const seen = new Set<string>();
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    if (isPosePlayerType(node.type)) return node;
    let next: SerializedGraphNode | undefined;
    for (const pin of poseInputPins(node.type, node.data.count)) {
      next = poseInputSource(index, node.id, pin);
      if (next) break;
    }
    node = next;
  }
  return null;
}

/**
 * A state graph that is a single player wired to the output, which the state Inspector edits directly (Animation,
 * Speed, Loop). Null for any other graph.
 */
export function singlePlayerOf(graph: SerializedGraph): SerializedGraphNode | null {
  const posed = graph.nodes.filter((node) => node.type.startsWith("anim.pose.") || node.type.startsWith("anim.frame."));
  if (posed.length !== 2) return null;
  const player = primaryPosePlayer(graph);
  return player && posed.includes(player) ? player : null;
}

/** A player node's stored data for a clip. */
export interface PosePlayerSettings {
  assetGuid?: string;
  clipName?: string;
  durationMs?: number;
  playRate?: number;
  loop?: boolean;
}

function playerData(settings: PosePlayerSettings): Record<string, unknown> {
  return {
    assetGuid: settings.assetGuid ?? "",
    ...(settings.clipName ? { clipName: settings.clipName } : {}),
    ...(settings.durationMs ? { durationMs: settings.durationMs } : {}),
    loop: settings.loop !== false,
    "default:playRate": settings.playRate ?? 1,
  };
}

/** A state graph: one player (Sequence Player or Sprite Animation Player) into the output. */
export function createStateGraph(dimension: AnimPoseDimension, settings: PosePlayerSettings = {}): SerializedGraph {
  const playerType = posePlayerType(dimension);
  return {
    nodes: [
      { id: "player", type: playerType, position: { x: 60, y: 80 }, data: playerData(settings) },
      { id: ANIM_POSE_OUTPUT_NODE_ID, type: poseOutputType(dimension), position: { x: 560, y: 80 }, data: { __protected: true } },
    ],
    edges: [{
      id: `player:pose->${ANIM_POSE_OUTPUT_NODE_ID}:${dimension === "3d" ? "pose" : "frame"}`,
      source: "player",
      sourceHandle: "pose",
      target: ANIM_POSE_OUTPUT_NODE_ID,
      targetHandle: dimension === "3d" ? "pose" : "frame",
    }],
  };
}

/** The top-level Anim Graph: one State Machine node into the output. */
export function createAnimGraphGraph(dimension: AnimPoseDimension, machineId: string): SerializedGraph {
  const inputPin = dimension === "3d" ? "pose" : "frame";
  return {
    nodes: [
      { id: `machine-${machineId}`, type: poseStateMachineType(dimension), position: { x: 60, y: 80 }, data: { machineId } },
      { id: ANIM_POSE_OUTPUT_NODE_ID, type: poseOutputType(dimension), position: { x: 560, y: 80 }, data: { __protected: true } },
    ],
    edges: [{
      id: `machine-${machineId}:pose->${ANIM_POSE_OUTPUT_NODE_ID}:${inputPin}`,
      source: `machine-${machineId}`,
      sourceHandle: "pose",
      target: ANIM_POSE_OUTPUT_NODE_ID,
      targetHandle: inputPin,
    }],
  };
}

/** Sets a player's stored settings, keeping the rest of the node. */
export function patchPosePlayer(graph: SerializedGraph, nodeId: string, settings: PosePlayerSettings): SerializedGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const data = { ...node.data };
      if (settings.assetGuid !== undefined) {
        data.assetGuid = settings.assetGuid;
        delete data.clipName;
        delete data.durationMs;
      }
      if (settings.clipName !== undefined) data.clipName = settings.clipName;
      if (settings.durationMs !== undefined) data.durationMs = settings.durationMs;
      if (settings.loop !== undefined) data.loop = settings.loop;
      if (settings.playRate !== undefined) data["default:playRate"] = settings.playRate;
      return { ...node, data };
    }),
  };
}
