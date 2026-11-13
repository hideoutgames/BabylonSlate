import { describe, expect, it } from "vitest";
import {
  RIG_BONE_COLOR,
  RIG_BONE_VERTICES,
  RIG_JOINT_COLOR,
  RIG_JOINT_VERTICES,
  RIG_SELECTED_COLOR,
  rigPreviewLayout,
  writeRigPreview,
} from "./rig-preview-geometry";

/** A hip at the origin, a spine 1 m up, and a head 0.5 m above that; plus a second child of the hip. Drawn as a 4 m rig. */
const JOINTS = new Float32Array([0, 0, 0, 0, 1, 0, 0, 1.5, 0, 0.4, -0.1, 0]);
const PARENTS = [-1, 0, 1, 0];

function draw(options: { selected?: number; light?: [number, number, number]; joints?: Float32Array } = {}) {
  const layout = rigPreviewLayout(PARENTS);
  const positions = new Float32Array(layout.vertexCount * 3);
  const colors = new Float32Array(layout.vertexCount * 4);
  writeRigPreview({
    joints: options.joints ?? JOINTS,
    parents: PARENTS,
    layout,
    size: 4,
    light: options.light ?? [0, 0, -1],
    selected: options.selected ?? -1,
    positions,
    colors,
  });
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
  it("draws a bone for every joint with a parent and a ball for every joint", () => {
    const layout = rigPreviewLayout([-1, 0, 1, 0, 9, 5]);
    // Joint 4's parent is out of range and joint 5 names itself: neither draws a bone.
    expect(layout.bones).toEqual([1, 2, 3]);
    expect(layout.vertexCount).toBe(3 * RIG_BONE_VERTICES + 6 * RIG_JOINT_VERTICES);
  });
});

describe("writeRigPreview", () => {
  it("runs each bone from its parent joint to its child, widest near the head", () => {
    const { positions } = draw();
    // The first bone runs from the hip (0, 0, 0) to the spine (0, 1, 0): its triangles alternate head and tail.
    const bone = Array.from({ length: RIG_BONE_VERTICES }, (_, index) => vertex(positions, index));
    expect(bone[0]).toEqual([0, 0, 0]);
    expect(bone[3]).toEqual([0, 1, 0]);
    // The ring sits 15% along the bone, 0.1 of its length out from the axis.
    const ring = bone.filter((point, index) => index % 3 !== 0);
    for (const point of ring) {
      expect(point[1]).toBeCloseTo(0.15, 3);
      expect(Math.hypot(point[0]!, point[2]!)).toBeCloseTo(0.1, 3);
    }
  });

  it("keeps a short bone readable and a long one slender against the rig's size", () => {
    const tiny = new Float32Array([0, 0, 0, 0, 0.01, 0, 0, 1.5, 0, 0.4, -0.1, 0]);
    const { positions } = draw({ joints: tiny });
    // A 1 cm bone would be 1 mm wide; the minimum is 0.35% of the 4 m rig, 14 mm.
    const ringPoint = vertex(positions, 1);
    expect(Math.hypot(ringPoint[0]!, ringPoint[2]!)).toBeCloseTo(0.014, 4);
    // The 1.49 m spine-to-head bone would be 14.9 cm wide; the maximum is 3%, 12 cm.
    const longRing = vertex(positions, RIG_BONE_VERTICES + 1);
    expect(Math.hypot(longRing[0]!, longRing[2]!)).toBeCloseTo(0.12, 3);
  });

  it("collapses a zero-length bone instead of drawing a spike", () => {
    const stacked = new Float32Array([0, 0, 0, 0, 0, 0, 0, 1.5, 0, 0.4, -0.1, 0]);
    const { positions, colors } = draw({ joints: stacked });
    for (let index = 0; index < RIG_BONE_VERTICES; index++) {
      expect(vertex(positions, index)).toEqual([0, 0, 0]);
      expect([...colors.subarray(index * 4, index * 4 + 3)]).toEqual([0, 0, 0]);
    }
  });

  it("colours bones and joints, and the selected joint with the bones it heads in the selection colour", () => {
    const plain = draw();
    const firstJoint = plain.layout.bones.length * RIG_BONE_VERTICES;
    expect(hue(plain.colors, 0)).toEqual(hueOf(RIG_BONE_COLOR));
    expect(hue(plain.colors, firstJoint)).toEqual(hueOf(RIG_JOINT_COLOR));

    // Selecting the hip (joint 0) highlights its ball and both bones it heads, not the spine's bone.
    const selected = draw({ selected: 0 });
    const boneHues = plain.layout.bones.map((_, bone) => hue(selected.colors, bone * RIG_BONE_VERTICES));
    expect(boneHues).toEqual([hueOf(RIG_SELECTED_COLOR), hueOf(RIG_BONE_COLOR), hueOf(RIG_SELECTED_COLOR)]);
    expect(hue(selected.colors, firstJoint)).toEqual(hueOf(RIG_SELECTED_COLOR));
    expect(hue(selected.colors, firstJoint + RIG_JOINT_VERTICES)).toEqual(hueOf(RIG_JOINT_COLOR));
  });

  it("shades faces turned to the light brighter than faces turned away", () => {
    const { colors, layout } = draw({ light: [0, 0, -1] });
    // The hip's ball: its faces' brightness spans the ambient floor to full light.
    const first = layout.bones.length * RIG_BONE_VERTICES;
    const brightness = Array.from({ length: RIG_JOINT_VERTICES / 3 }, (_, face) =>
      colors[(first + face * 3) * 4 + 2]! / RIG_JOINT_COLOR[2]);
    expect(Math.min(...brightness)).toBeCloseTo(0.38, 2);
    expect(Math.max(...brightness)).toBeGreaterThan(0.9);
  });
});
