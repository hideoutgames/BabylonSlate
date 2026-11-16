import { describe, expect, it } from "vitest";
import type { SerializedGraph } from "@haptic/core";
import {
  ANIM_CONTROL_FOOT_PLACEMENT_TYPE,
  ANIM_CONTROL_LOOK_AT_TYPE,
  ANIM_CONTROL_SPRING_BONES_TYPE,
  ANIM_CONTROL_TWO_BONE_IK_TYPE,
  ANIM_POSE_OUTPUT_NODE_ID,
  ANIM_POSE_SEQUENCE_PLAYER_TYPE,
  animGraphMembersFromVariables,
  createDefaultAnimGraph,
  defaultAnimVariableValue,
  evaluateAnimGraph,
  parseAnimGraphDocument,
  validateAnimGraph,
  type AnimGraphDocument,
} from "./index";

type Node = SerializedGraph["nodes"][number];

const node = (id: string, type: string, data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });
const player = (id: string): Node => node(id, ANIM_POSE_SEQUENCE_PLAYER_TYPE, { assetGuid: id, clipName: id, durationMs: 1000, loop: true });
const wire = (source: string, target: string, targetHandle: string) => ({
  id: `${source}->${target}:${targetHandle}`, source, sourceHandle: "pose", target, targetHandle,
});

/** Idle through one skeletal control into the output. */
function controlled(type: string, data: Record<string, unknown>): AnimGraphDocument {
  const stateGraph: SerializedGraph = {
    nodes: [player("idle"), node("control", type, data), node(ANIM_POSE_OUTPUT_NODE_ID, "anim.pose.output", { __protected: true })],
    edges: [wire("idle", "control", "sourcePose"), wire("control", ANIM_POSE_OUTPUT_NODE_ID, "pose")],
  };
  return {
    ...createDefaultAnimGraph("IK"),
    stateMachine: { entryStateId: "main", states: [{ id: "main", name: "Main", position: { x: 0, y: 0 }, stateGraph }], transitions: [] },
  };
}

describe("Look At", () => {
  it("sends its bone, target, axes and limit, at Alpha", () => {
    const state = evaluateAnimGraph(controlled(ANIM_CONTROL_LOOK_AT_TYPE, {
      bone: "head", targetSpace: "world", aimAxis: "-y", upAxis: "z", limitDegrees: 60,
      "default:target": { x: 1, y: 2, z: 3 }, "default:alpha": 0.5,
    }), null, 0.1, {});
    expect(state.boneModifiers).toEqual([{
      kind: "lookAt", bone: "head", alpha: 0.5, target: [1, 2, 3], targetSpace: "world",
      aimAxis: [0, -1, 0], upAxis: [0, 0, 1], limitDegrees: 60,
    }]);
  });

  it("aims along Z with no Up Axis and no limit by default", () => {
    const state = evaluateAnimGraph(controlled(ANIM_CONTROL_LOOK_AT_TYPE, { bone: "head" }), null, 0, {});
    expect(state.boneModifiers?.[0]).toMatchObject({ aimAxis: [0, 0, 1], limitDegrees: 180, targetSpace: "actor" });
    expect(state.boneModifiers?.[0]).not.toHaveProperty("upAxis");
  });

  it("eases its target over Interpolation Time, from where it was last tick", () => {
    const doc = (x: number) => controlled(ANIM_CONTROL_LOOK_AT_TYPE, { bone: "head", interpSeconds: 1, "default:target": { x, y: 0, z: 0 } });
    const first = evaluateAnimGraph(doc(0), null, 0.1, {});
    expect(first.boneModifiers?.[0]).toMatchObject({ target: [0, 0, 0] });
    const next = evaluateAnimGraph(doc(10), first, 0.1, {});
    const x = (next.boneModifiers?.[0] as { target: number[] }).target[0]!;
    expect(x).toBeCloseTo(10 * (1 - Math.exp(-0.3)), 6);
    expect(next.lookAtTargets?.["main#control"]?.[0]).toBeCloseTo(x, 9);
  });
});

describe("Two Bone IK", () => {
  const ik = (data: Record<string, unknown>) => evaluateAnimGraph(controlled(ANIM_CONTROL_TWO_BONE_IK_TYPE, { bone: "hand_r", ...data }), null, 0, {});

  it("sends its effector, and its Joint Target only when used", () => {
    expect(ik({ "default:effector": { x: 1, y: 2, z: 3 }, "default:jointTarget": { x: 0, y: 0, z: 5 } }).boneModifiers).toEqual([{
      kind: "twoBoneIk", bone: "hand_r", alpha: 1, effector: [1, 2, 3], effectorSpace: "actor", jointTargetSpace: "actor",
      maxStretch: 1, keepEffectorRotation: false,
    }]);
    expect(ik({ useJointTarget: true, jointTargetSpace: "world", "default:jointTarget": { x: 0, y: 0, z: 5 }, maxStretch: 1.2, keepEffectorRotation: true }).boneModifiers?.[0])
      .toMatchObject({ jointTarget: [0, 0, 5], jointTargetSpace: "world", maxStretch: 1.2, keepEffectorRotation: true });
  });

  it("reports a control that names no bone", () => {
    const diagnostics = validateAnimGraph(controlled(ANIM_CONTROL_TWO_BONE_IK_TYPE, {}), [], { dimension: "3d" });
    expect(diagnostics.filter((row) => row.code === "anim.missingBone").map((row) => row.message)).toEqual(["Two Bone IK changes no bone until it names one"]);
  });
});

describe("Spring Bones", () => {
  it("sends its Root Bone, cleaned settings and the tick's time step, at Alpha", () => {
    const state = evaluateAnimGraph(controlled(ANIM_CONTROL_SPRING_BONES_TYPE, {
      bone: "Tail1", stiffness: 2, gravity: [0, -9.8], excludeBones: ["Tail5", "", "Tail5"],
      colliders: [{ kind: "capsule", bone: "Hips", length: 0.5 }, { kind: "sphere" }],
      stiffnessCurve: [{ t: 1, value: 0.5 }, { t: 0, value: 1 }], "default:alpha": 0.5,
    }), null, 1 / 60, {});
    const change = state.boneModifiers?.[0];
    expect(change).toMatchObject({ kind: "springBones", bone: "Tail1", alpha: 0.5, dtSeconds: 1 / 60 });
    if (change?.kind !== "springBones") throw new Error("expected Spring Bones");
    expect(change.settings).toMatchObject({
      stiffness: 1, damping: 0.1, gravity: [0, -9.8, 0], excludeBones: ["Tail5"], tipLength: 0, planarConstraint: "none",
      curves: { stiffness: [{ t: 0, value: 1 }, { t: 1, value: 0.5 }], damping: [] },
    });
    // A collider with no bone is dropped.
    expect(change.settings.colliders).toEqual([{ kind: "capsule", bone: "Hips", offset: [0, 0, 0], radius: 0.1, length: 0.5, axis: "y" }]);
  });

  it("reports a Spring Bones with no Root Bone", () => {
    const diagnostics = validateAnimGraph(controlled(ANIM_CONTROL_SPRING_BONES_TYPE, {}), [], { dimension: "3d" });
    expect(diagnostics.find((row) => row.code === "anim.missingBone")?.message).toBe("Spring Bones changes no bone until it names one");
  });
});

describe("Foot Placement", () => {
  it("sends its feet, pelvis and traces, its first foot as its bone", () => {
    const state = evaluateAnimGraph(controlled(ANIM_CONTROL_FOOT_PLACEMENT_TYPE, {
      feet: ["foot.l", "foot.r", "foot.l", ""], pelvisBone: "hips", traceDown: 0.8,
    }), null, 0, {});
    expect(state.boneModifiers).toEqual([{
      kind: "footPlacement", bone: "foot.l", alpha: 1, feet: ["foot.l", "foot.r"], pelvisBone: "hips", traceUp: 0.5, traceDown: 0.8, alignToGround: true,
    }]);
  });

  it("reports a Foot Placement with no feet, and sends nothing", () => {
    const doc = controlled(ANIM_CONTROL_FOOT_PLACEMENT_TYPE, {});
    expect(validateAnimGraph(doc, [], { dimension: "3d" }).find((row) => row.code === "anim.missingBone")?.message)
      .toBe("Foot Placement places no foot until it names one");
    expect(evaluateAnimGraph(doc, null, 0, {}).boneModifiers).toBeUndefined();
  });
});

describe("Vector and Rotator variables", () => {
  it("default to zero and keep their components as numbers", () => {
    expect(defaultAnimVariableValue("vec3")).toEqual({ x: 0, y: 0, z: 0 });
    expect(defaultAnimVariableValue("rotator")).toEqual({ pitch: 0, yaw: 0, roll: 0 });
    const doc = parseAnimGraphDocument({
      ...createDefaultAnimGraph("Vars"),
      variables: [
        { id: "a", name: "LookTarget", typeId: "vec3", defaultValue: { x: 1, y: "2" } },
        { id: "b", name: "HeadTurn", typeId: "rotator", defaultValue: { yaw: 25 } },
      ],
    });
    expect(doc?.variables.map((variable) => [variable.typeId, variable.defaultValue])).toEqual([
      ["vec3", { x: 1, y: 0, z: 0 }],
      ["rotator", { pitch: 0, yaw: 25, roll: 0 }],
    ]);
    expect(animGraphMembersFromVariables(doc?.variables ?? []).map((member) => member.typeId)).toEqual(["vec3", "rotator"]);
  });
});
