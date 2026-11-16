import { describe, expect, it } from "vitest";
import {
  RIG_BONE_COLOR,
  RIG_BONE_VERTICES,
  RIG_JOINT_BONE,
  RIG_JOINT_COLOR,
  RIG_JOINT_HIDDEN,
  RIG_JOINT_MARKER,
  RIG_JOINT_VERTICES,
  RIG_SELECTED_COLOR,
  rigPreviewLayout,
  rigPreviewTopology,
  writeRigPreview,
  type RigJointRest,
} from "./rig-preview-geometry";

type Row = [name: string, parent: string | null, local: [number, number, number], deforms: boolean, underImportRoot?: boolean];

/** Joints from rows naming their parents, as the rest pose has them. */
function rig(rows: Row[]): { names: string[]; joints: RigJointRest[] } {
  const names = rows.map(([name]) => name);
  return {
    names,
    joints: rows.map(([, parent, local, deforms, underImportRoot = false]) => ({
      parent: parent === null ? -1 : names.indexOf(parent),
      local,
      deforms,
      underImportRoot,
    })),
  };
}

function describeTopology(rows: Row[], options: { connect: boolean; topMarkers?: boolean } = { connect: true }) {
  const { names, joints } = rig(rows);
  const topology = rigPreviewTopology(joints, options);
  const kind = (name: string) => ["hidden", "marker", "bone"][topology.kinds[names.indexOf(name)]!];
  const connectedTo = (name: string) => names[topology.connected[names.indexOf(name)]!] ?? null;
  const lines = topology.lines.map(([parent, child]) => `${names[parent]}-${names[child]}`);
  return { topology, kind, connectedTo, lines };
}

/** KayKit's Rig_Medium, one side, as its file has it: bones run along +Y; the root and hand slots deform nothing. */
const KAYKIT: Row[] = [
  ["root", null, [0, 0, 0], false],
  ["hips", "root", [0, 0.406, 0], true],
  ["upperleg.l", "hips", [0.171, 0.114, 0], true],
  ["lowerleg.l", "upperleg.l", [0, 0.227, 0], true],
  ["spine", "hips", [0, 0.192, 0], true],
  ["chest", "spine", [0, 0.375, 0], true],
  ["head", "chest", [0, 0.269, 0], true],
  ["upperarm.l", "chest", [0.212, 0.134, 0], true],
  ["hand.l", "upperarm.l", [0, 0.074, 0], true],
  ["handslot.l", "hand.l", [0, 0.096, -0.058], false],
];

/** The Velociraptor from FBX: its armature object kept as a joint above the bones, and end markers past its leaves. */
const RAPTOR: Row[] = [
  ["Armature", null, [0, 0, 0], false, true],
  ["root", "Armature", [0, -0.011, 0], true],
  ["Body", "root", [-0.031, 4.25, 1.043], false],
  ["BackFoot.R", "root", [0.966, 0.086, -1.16], true],
  ["BackFoot.R_end", "BackFoot.R", [0, 1, 0], false],
  ["Neck", "Body", [0, 0.719, -0.001], true],
  ["Head", "Neck", [0, 0.773, 0], true],
  ["Head_end", "Head", [0, 1.394, 0], false],
];

describe("rigPreviewTopology", () => {
  it("runs each bone to the child on its +Y axis and joins every other child by a line", () => {
    const { kind, connectedTo, lines } = describeTopology(KAYKIT);
    expect(connectedTo("hips")).toBe("spine");
    expect(connectedTo("chest")).toBe("head");
    expect(connectedTo("upperleg.l")).toBe("lowerleg.l");
    // The hand slot sits off the hand's axis: the hand's tail is guessed and the slot is joined by a line.
    expect(connectedTo("hand.l")).toBeNull();
    expect(connectedTo("head")).toBeNull();
    expect(lines).toEqual(["root-hips", "hips-upperleg.l", "chest-upperarm.l", "hand.l-handslot.l"]);
    // The root and the hand slot deform nothing: a ball each, no bone; no floor-to-hips bone.
    expect(kind("root")).toBe("marker");
    expect(kind("handslot.l")).toBe("marker");
    expect(kind("head")).toBe("bone");
  });

  it("hides an armature object kept as a joint, and makes an end marker its bone's tail", () => {
    const { kind, connectedTo, lines } = describeTopology(RAPTOR);
    expect(kind("Armature")).toBe("hidden");
    expect(kind("Head_end")).toBe("hidden");
    expect(kind("BackFoot.R_end")).toBe("hidden");
    expect(connectedTo("Head")).toBe("Head_end");
    expect(connectedTo("BackFoot.R")).toBe("BackFoot.R_end");
    // The root deforms: a bone of its own (no child on its axis), lines to the body and the foot; the body deforms
    // nothing, a ball with a line on to the neck it heads.
    expect(kind("root")).toBe("bone");
    expect(connectedTo("root")).toBeNull();
    expect(kind("Body")).toBe("marker");
    expect(lines).toEqual(["root-Body", "root-BackFoot.R", "Body-Neck"]);
  });

  it("keeps a top joint that deforms nothing but sits under its own armature, and a deforming end joint", () => {
    // KayKit's root is under its armature node, not the import's root; a leaf that deforms stays a joint with a bone.
    const { kind } = describeTopology([
      ["root", null, [0, 0, 0], false, false],
      ["hips", "root", [0, 0.4, 0], true],
      ["toes", "hips", [0, 0.2, 0], true],
    ]);
    expect(kind("root")).toBe("marker");
    expect(kind("toes")).toBe("bone");
  });

  it("finds the bone axis the rig's children lie along", () => {
    // A rig whose bones run along -X: its chain connects along it, and a guessed tail runs along it too.
    const { topology, connectedTo } = describeTopology([
      ["pelvis", null, [0, 0, 0], true],
      ["spine", "pelvis", [-0.3, 0, 0], true],
      ["neck", "spine", [-0.4, 0, 0], true],
      ["thigh", "pelvis", [0.1, 0, 0.2], true],
      ["calf", "thigh", [-0.5, 0, 0], true],
    ]);
    expect(topology.axis).toEqual([-1, 0, 0]);
    expect(connectedTo("pelvis")).toBe("spine");
    expect(connectedTo("thigh")).toBe("calf");
  });

  it("connects nothing on a rigid-part rig, and only bare hierarchies draw their top joint as a ball", () => {
    const parts: Row[] = [
      ["character", null, [0, 0, 0], false, true],
      ["root", "character", [0, 0, 0], false],
      ["torso", "root", [0, 0.7, 0], true],
      ["head", "torso", [0, 1.2, 0], true],
    ];
    const rigid = describeTopology(parts, { connect: false });
    expect(rigid.kind("character")).toBe("hidden");
    expect(rigid.kind("root")).toBe("marker");
    expect(rigid.connectedTo("torso")).toBeNull();
    expect(rigid.lines).toEqual(["root-torso", "torso-head"]);
    const bare: Row[] = [
      ["Rig", null, [0, 0, 0], false, true],
      ["root", "Rig", [0, 0, 0], true],
      ["hips", "root", [0, 0.4, 0], true],
    ];
    expect(describeTopology(bare, { connect: true, topMarkers: true }).kind("root")).toBe("marker");
    expect(describeTopology(bare, { connect: true }).kind("root")).toBe("bone");
  });
});

/** A hip at the origin, a spine 1 m up running to a head 0.5 m above it, and a hand slot off the hip. A 4 m rig. */
const JOINTS = new Float32Array([0, 0, 0, 0, 1, 0, 0, 1.5, 0, 0.4, -0.1, 0]);
const ROWS: Row[] = [
  ["hip", null, [0, 0, 0], true],
  ["spine", "hip", [0, 1, 0], true],
  ["head", "spine", [0, 0.5, 0], true],
  ["slot", "hip", [0.4, -0.1, 0], false],
];

function draw(options: { selected?: number; light?: [number, number, number]; joints?: Float32Array; tails?: Float32Array } = {}) {
  const topology = rigPreviewTopology(rig(ROWS).joints, { connect: true });
  const layout = rigPreviewLayout(topology);
  const joints = options.joints ?? JOINTS;
  // Each bone ends at the child it runs to; the head's tail is given.
  const tails = options.tails ?? new Float32Array([...joints.subarray(3, 6), ...joints.subarray(6, 9), 0, 2, 0, NaN, NaN, NaN]);
  const positions = new Float32Array(layout.vertexCount * 3);
  const colors = new Float32Array(layout.vertexCount * 4);
  writeRigPreview({ joints, tails, layout, size: 4, light: options.light ?? [0, 0, -1], selected: options.selected ?? -1, positions, colors });
  return { layout, positions, colors };
}

function vertex(positions: Float32Array, index: number): number[] {
  return [...positions.subarray(index * 3, index * 3 + 3)].map((value) => Math.round(value * 1000) / 1000);
}

/** The hue of a vertex: its colour divided by its brightest channel, so shading drops out. */
function hue(colors: Float32Array, index: number): number[] {
  const [r, g, b] = colors.subarray(index * 4, index * 4 + 3);
  const max = Math.max(r!, g!, b!);
  return [r! / max, g! / max, b! / max].map((value) => Math.round(value * 100) / 100);
}

const hueOf = (color: readonly number[]) => {
  const max = Math.max(...color);
  return color.map((value) => Math.round((value / max) * 100) / 100);
};

describe("rigPreviewLayout", () => {
  it("draws a bone per bone joint and a ball per drawn joint, and leaves the lines to be drawn apart", () => {
    const { layout } = draw();
    expect(layout.bones).toEqual([0, 1, 2]);
    expect(layout.lines).toEqual([[0, 3]]);
    expect(layout.balls).toEqual([0, 1, 2, 3]);
    expect(layout.vertexCount).toBe(3 * RIG_BONE_VERTICES + 4 * RIG_JOINT_VERTICES);
    expect([RIG_JOINT_HIDDEN, RIG_JOINT_MARKER, RIG_JOINT_BONE]).toEqual([0, 1, 2]);
  });
});

describe("writeRigPreview", () => {
  it("runs each bone from its joint to its tail, widest near the head", () => {
    const { positions } = draw();
    // The hip's bone runs to the spine (0, 1, 0): its triangles alternate head and tail.
    const bone = Array.from({ length: RIG_BONE_VERTICES }, (_, index) => vertex(positions, index));
    expect(bone[0]).toEqual([0, 0, 0]);
    expect(bone[3]).toEqual([0, 1, 0]);
    // The ring sits 15% along the bone, 0.1 of its length out from the axis.
    const ring = bone.filter((_, index) => index % 3 !== 0);
    for (const point of ring) {
      expect(point[1]).toBeCloseTo(0.15, 3);
      expect(Math.hypot(point[0]!, point[2]!)).toBeCloseTo(0.1, 3);
    }
    // The head's bone runs to its given tail.
    expect(vertex(positions, 2 * RIG_BONE_VERTICES)).toEqual([0, 1.5, 0]);
    expect(vertex(positions, 2 * RIG_BONE_VERTICES + 3)).toEqual([0, 2, 0]);
  });

  it("keeps a short bone readable and a long one slender against the rig's size", () => {
    const joints = new Float32Array([0, 0, 0, 0, 0.01, 0, 0, 1.5, 0, 0.4, -0.1, 0]);
    const { positions } = draw({ joints });
    // A 1 cm bone would be 1 mm wide; the minimum is 0.35% of the 4 m rig, 14 mm.
    const ringPoint = vertex(positions, 1);
    expect(Math.hypot(ringPoint[0]!, ringPoint[2]!)).toBeCloseTo(0.014, 4);
    // The 1.49 m spine-to-head bone would be 14.9 cm wide; the maximum is 3%, 12 cm.
    const longRing = vertex(positions, RIG_BONE_VERTICES + 1);
    expect(Math.hypot(longRing[0]!, longRing[2]!)).toBeCloseTo(0.12, 3);
  });

  it("collapses a bone with no tail, or with its tail on its head, instead of drawing a spike", () => {
    const tails = new Float32Array([0, 0, 0, NaN, NaN, NaN, 0, 2, 0, NaN, NaN, NaN]);
    const { positions, colors } = draw({ tails });
    for (let index = 0; index < 2 * RIG_BONE_VERTICES; index++) {
      const joint = index < RIG_BONE_VERTICES ? [0, 0, 0] : [0, 1, 0];
      expect(vertex(positions, index)).toEqual(joint);
      expect([...colors.subarray(index * 4, index * 4 + 3)]).toEqual([0, 0, 0]);
    }
  });

  it("colours bones and joints, and the selected joint with its bone in the selection colour", () => {
    const plain = draw();
    const firstBall = 3 * RIG_BONE_VERTICES;
    expect(hue(plain.colors, 0)).toEqual(hueOf(RIG_BONE_COLOR));
    expect(hue(plain.colors, firstBall)).toEqual(hueOf(RIG_JOINT_COLOR));

    // Selecting the spine (joint 1) highlights its ball and its own bone, not the hip's bone that runs to it.
    const selected = draw({ selected: 1 });
    expect([0, 1, 2].map((bone) => hue(selected.colors, bone * RIG_BONE_VERTICES)))
      .toEqual([hueOf(RIG_BONE_COLOR), hueOf(RIG_SELECTED_COLOR), hueOf(RIG_BONE_COLOR)]);
    expect(hue(selected.colors, firstBall + RIG_JOINT_VERTICES)).toEqual(hueOf(RIG_SELECTED_COLOR));
    expect(hue(selected.colors, firstBall)).toEqual(hueOf(RIG_JOINT_COLOR));
  });

  it("shades faces turned to the light brighter than faces turned away", () => {
    const { colors } = draw({ light: [0, 0, -1] });
    // The hip's ball: its faces' brightness spans the ambient floor to full light.
    const first = 3 * RIG_BONE_VERTICES;
    const brightness = Array.from({ length: RIG_JOINT_VERTICES / 3 }, (_, face) =>
      colors[(first + face * 3) * 4 + 2]! / RIG_JOINT_COLOR[2]);
    expect(Math.min(...brightness)).toBeCloseTo(0.38, 2);
    expect(Math.max(...brightness)).toBeGreaterThan(0.9);
  });
});
