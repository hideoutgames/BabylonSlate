import {
  ANIM_POSE_OUTPUT_NODE_ID,
  createDefaultAnimationObjectGraph,
  poseOutputType,
  posePlayerType,
  type AnimGraphDimension,
  type AnimGraphDocument,
  type AnimGraphVariable,
  type AnimState,
  type AnimStateAlias,
  type AnimTransition,
} from "@haptic/anim-graph";
import type { SerializedGraph } from "@haptic/core";
import { gNode, gWire, printString } from "./graph";

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
  options: { loop?: boolean; playRate?: number; syncGroup?: string } = {},
): GraphNode {
  return gNode(id, posePlayerType(dimension), x, y, {
    assetGuid: clip.assetGuid,
    ...(clip.clipName ? { clipName: clip.clipName } : {}),
    durationMs: clip.durationMs,
    loop: options.loop !== false,
    "default:playRate": options.playRate ?? 1,
    ...(options.syncGroup ? { syncGroup: options.syncGroup } : {}),
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
  options: { loop?: boolean; playRate?: number; syncGroup?: string } = {},
): AnimState {
  return { id, name, position: { x, y }, stateGraph: poseGraph(dimension, "player", [playerNode(dimension, "player", 60, 80, clip, options)]) };
}

/** An Animation Graph: its State Machine's states and transitions, and its variables. */
export function stateMachineGraph(
  dimension: AnimGraphDimension,
  options: {
    name: string;
    skeletonGuid: string | null;
    entryStateId: string;
    states: AnimState[];
    transitions: AnimTransition[];
    variables: AnimGraphVariable[];
    aliases?: AnimStateAlias[];
  },
): AnimGraphDocument {
  return {
    name: options.name,
    skeletonGuid: dimension === "3d" ? options.skeletonGuid : null,
    previewModelGuid: null,
    variables: options.variables,
    stateMachine: {
      entryStateId: options.entryStateId,
      states: options.states,
      transitions: options.transitions,
      aliases: options.aliases ?? [],
    },
    animationObject: createDefaultAnimationObjectGraph(),
  };
}

/**
 * The default Animation Object with an Event <Name> node for each of `events` that prints, once, that `owner` heard
 * it (a window: its Begin and its End), so the Feature Test check sees each event reach the graph's Animation Object.
 */
export function animationObjectHearing(
  owner: string,
  events: ReadonlyArray<{ name: string; window?: boolean }>,
): SerializedGraph {
  const graph = createDefaultAnimationObjectGraph();
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  events.forEach((event, row) => {
    const y = 360 + row * 220;
    const id = `heard-${row + 1}`;
    nodes.push(gNode(id, "anim.event.notify", 60, y, { eventName: event.name, ...(event.window ? { window: true } : {}) }));
    const outputs: Array<[string, string]> = event.window ? [["begin", " Begin"], ["end", " End"]] : [["execOut", ""]];
    outputs.forEach(([pin, suffix], index) => {
      const once = `${id}-once-${index + 1}`;
      const print = `${id}-print-${index + 1}`;
      nodes.push(
        gNode(once, "flow.doOnce", 380, y + index * 100),
        printString(print, 640, y + index * 100, `${owner} heard ${event.name}${suffix}`),
      );
      edges.push(gWire(id, pin, once, "execIn"), gWire(once, "then", print, "execIn"));
    });
  });
  return { ...graph, nodes, edges };
}

