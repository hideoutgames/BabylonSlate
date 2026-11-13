import {
  ANIM_POSE_OUTPUT_NODE_ID,
  createAnimGraphGraph,
  createDefaultAnimationObjectGraph,
  poseOutputType,
  posePlayerType,
  type AnimGraphDimension,
  type AnimGraphDocument,
  type AnimGraphVariable,
  type AnimState,
  type AnimTransition,
} from "@haptic/anim-graph";
import type { SerializedGraph } from "@haptic/core";
import { gNode, gWire } from "./graph";

type GraphNode = SerializedGraph["nodes"][number];
type GraphEdge = SerializedGraph["edges"][number];

/** A clip a player plays: its asset, its name in the file (empty for a Sprite Animation) and its length. */
export interface FeatureTestClip {
  assetGuid: string;
  clipName: string;
  durationMs: number;
}

/** A Sequence Player (3D) or Sprite Animation Player (2D) node. */
export function playerNode(
  dimension: AnimGraphDimension,
  id: string,
  x: number,
  y: number,
  clip: FeatureTestClip,
  options: { loop?: boolean; playRate?: number } = {},
): GraphNode {
  return gNode(id, posePlayerType(dimension), x, y, {
    assetGuid: clip.assetGuid,
    ...(clip.clipName ? { clipName: clip.clipName } : {}),
    durationMs: clip.durationMs,
    loop: options.loop !== false,
    "default:playRate": options.playRate ?? 1,
  });
}

/** A pose graph: `nodes` and `edges`, with `root`'s pose wired into a protected output. */
export function poseGraph(
  dimension: AnimGraphDimension,
  root: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[] = [],
): SerializedGraph {
  const pin = dimension === "3d" ? "pose" : "frame";
  const right = Math.max(0, ...nodes.map((node) => node.position.x)) + 460;
  return {
    nodes: [...nodes, { ...gNode(ANIM_POSE_OUTPUT_NODE_ID, poseOutputType(dimension), right, 80), data: { __protected: true } }],
    edges: [...edges, gWire(root, "pose", ANIM_POSE_OUTPUT_NODE_ID, pin)],
  };
}

/** A state that plays one clip. */
export function playerState(
  dimension: AnimGraphDimension,
  id: string,
  name: string,
  x: number,
  y: number,
  clip: FeatureTestClip,
  options: { loop?: boolean; playRate?: number } = {},
): AnimState {
  return { id, name, position: { x, y }, stateGraph: poseGraph(dimension, "player", [playerNode(dimension, "player", 60, 80, clip, options)]) };
}

/** A graph with one State Machine (`machine`) into the Anim Graph's output. */
export function singleMachineGraph(
  dimension: AnimGraphDimension,
  options: {
    name: string;
    skeletonGuid: string | null;
    machineName: string;
    entryStateId: string;
    states: AnimState[];
    transitions: AnimTransition[];
    variables: AnimGraphVariable[];
  },
): AnimGraphDocument {
  return {
    name: options.name,
    skeletonGuid: dimension === "3d" ? options.skeletonGuid : null,
    variables: options.variables,
    animGraph: createAnimGraphGraph(dimension, "machine"),
    stateMachines: [{
      id: "machine",
      name: options.machineName,
      entryStateId: options.entryStateId,
      states: options.states,
      transitions: options.transitions,
    }],
    animationObject: createDefaultAnimationObjectGraph(),
  };
}
