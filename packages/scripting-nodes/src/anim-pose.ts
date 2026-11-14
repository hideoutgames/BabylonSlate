import { BOOL, FLOAT, FRAME, INT, POSE, pin, type GraphPin, type NodeDefinition } from "@haptic/scripting";

/**
 * Animation Graph pose (3D) and frame (2D) nodes. Their pose and frame wires are structure the evaluator in
 * `@haptic/anim-graph` reads; only their data inputs compile, into one `evaluate(ctx)` module per graph
 * (`compilePoseDataGraph`). Each node's own settings (its Animation, Loop, blend times) live in its data.
 */

/** Inputs a Blend Poses By Int or Select Frame By Int node starts with, and the most it takes. */
export const ANIM_POSE_DEFAULT_INPUTS = 2;
export const ANIM_POSE_MAX_INPUTS = 16;

export function animPoseInputCount(properties: Record<string, unknown>): number {
  const value = Number(properties.count);
  return Number.isFinite(value) ? Math.max(2, Math.min(ANIM_POSE_MAX_INPUTS, Math.round(value))) : ANIM_POSE_DEFAULT_INPUTS;
}

/** Pose nodes compile to nothing themselves; the pose-data module reads their data inputs. */
const structural = (): undefined => undefined;

function poseNode(
  id: string,
  title: string,
  description: string,
  pins: (properties: Record<string, unknown>) => GraphPin[],
): NodeDefinition {
  return { id, title, description, category: "animation", pure: true, declaredPinOrder: true, pins, codegen: structural };
}

const out = (type: typeof POSE) => pin("pose", type === FRAME ? "frame" : "pose", "out", type);

export const animPoseNodes: NodeDefinition[] = [
  // 3D pose graphs.
  poseNode("anim.pose.output", "Output Pose", "The pose this graph produces.", () => [pin("pose", "pose", "in", POSE)]),
  poseNode("anim.pose.sequencePlayer", "Sequence Player", "Plays an Animation.", () => [
    pin("playRate", "playRate", "in", FLOAT, "data", true, 1),
    pin("startPosition", "startPosition", "in", FLOAT, "data", true, 0),
    out(POSE),
  ]),
  poseNode("anim.pose.sequenceEvaluator", "Sequence Evaluator", "Holds an Animation at a normalized time.", () => [
    pin("normalizedTime", "normalizedTime", "in", FLOAT, "data", true, 0),
    out(POSE),
  ]),
  poseNode("anim.pose.blendSpacePlayer", "Blend Space Player", "Plays a Blend Space: the Animations around X and Y, in step.", () => [
    pin("x", "x", "in", FLOAT, "data", true, 0),
    pin("y", "y", "in", FLOAT, "data", true, 0),
    pin("playRate", "playRate", "in", FLOAT, "data", true, 1),
    out(POSE),
  ]),
  poseNode("anim.pose.restPose", "Rest Pose", "The Skeleton's rest pose.", () => [out(POSE)]),
  poseNode("anim.pose.blend", "Blend", "Blends two poses by Alpha: 0 is A, 1 is B.", () => [
    pin("a", "a", "in", POSE),
    pin("b", "b", "in", POSE),
    pin("alpha", "alpha", "in", FLOAT, "data", true, 0.5),
    out(POSE),
  ]),
  poseNode("anim.pose.blendByBool", "Blend Poses By Bool", "Blends to True Pose or False Pose as Active changes.", () => [
    pin("truePose", "truePose", "in", POSE),
    pin("falsePose", "falsePose", "in", POSE),
    pin("active", "active", "in", BOOL, "data", true, true),
    out(POSE),
  ]),
  poseNode("anim.pose.blendByInt", "Blend Poses By Int", "Blends to the pose Active Index picks.", (properties) => [
    ...Array.from({ length: animPoseInputCount(properties) }, (_, index) => pin(`pose${index}`, `pose${index}`, "in", POSE)),
    pin("activeIndex", "activeIndex", "in", INT, "data", true, 0),
    out(POSE),
  ]),
  // 2D frame graphs.
  poseNode("anim.frame.output", "Output Frame", "The frame this graph shows.", () => [pin("frame", "frame", "in", FRAME)]),
  poseNode("anim.frame.spritePlayer", "Sprite Animation Player", "Plays a Sprite Animation.", () => [
    pin("playRate", "playRate", "in", FLOAT, "data", true, 1),
    pin("startFrame", "startFrame", "in", INT, "data", true, 0),
    out(FRAME),
  ]),
  poseNode("anim.frame.spriteBlendSpacePlayer", "Sprite Blend Space Player", "Plays the Sprite Animation of a Sprite Blend Space nearest X and Y.", () => [
    pin("x", "x", "in", FLOAT, "data", true, 0),
    pin("y", "y", "in", FLOAT, "data", true, 0),
    pin("playRate", "playRate", "in", FLOAT, "data", true, 1),
    out(FRAME),
  ]),
  poseNode("anim.frame.selectByBool", "Select Frame By Bool", "Shows True Frame or False Frame as Active changes.", () => [
    pin("trueFrame", "trueFrame", "in", FRAME),
    pin("falseFrame", "falseFrame", "in", FRAME),
    pin("active", "active", "in", BOOL, "data", true, true),
    out(FRAME),
  ]),
  poseNode("anim.frame.selectByInt", "Select Frame By Int", "Shows the frame Active Index picks.", (properties) => [
    ...Array.from({ length: animPoseInputCount(properties) }, (_, index) => pin(`frame${index}`, `frame${index}`, "in", FRAME)),
    pin("activeIndex", "activeIndex", "in", INT, "data", true, 0),
    out(FRAME),
  ]),
  poseNode("anim.frame.flip", "Flip Frame", "Mirrors a frame, so one clip faces both ways.", () => [
    pin("frame", "frame", "in", FRAME),
    pin("flipX", "flipX", "in", BOOL, "data", true, false),
    pin("flipY", "flipY", "in", BOOL, "data", true, false),
    out(FRAME),
  ]),
];
