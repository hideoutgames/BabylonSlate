/**
 * Geometry of the rig preview's bones, as the Skeleton, Animation and Animation Graph previews draw them: an
 * octahedral bone from each joint to each of its children, widest near its head, and a ball at every joint. Every
 * triangle has its own three vertices so it shades flat; shading is a fixed amount of ambient plus a headlight term,
 * baked into vertex colours because the preview's surface is unlit. Pure: no Babylon.
 */

/** Light grey-blue bones, near-white joints, amber for the selected joint and the bones it heads. */
export const RIG_BONE_COLOR: readonly [number, number, number] = [0.78, 0.84, 0.94];
export const RIG_JOINT_COLOR: readonly [number, number, number] = [0.93, 0.95, 1];
export const RIG_SELECTED_COLOR: readonly [number, number, number] = [1, 0.7, 0.22];

/** Shade of a face turned away from the light, and of one facing it. */
const AMBIENT = 0.38;
const DIFFUSE = 0.62;
/** Where along a bone its ring sits, and its half-width against its length. */
const RING_AT = 0.15;
const WIDTH_PER_LENGTH = 0.1;
/** Bone half-width and joint radius limits against the rig's size (its bounds' diagonal). */
const MIN_WIDTH = 0.0035;
const MAX_WIDTH = 0.03;
const JOINT_PER_WIDTH = 0.8;
const LONE_JOINT = 0.008;

const PHI = (1 + Math.sqrt(5)) / 2;
const ICOSAHEDRON_VERTICES = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
].map(([x, y, z]) => {
  const length = Math.hypot(x!, y!, z!);
  return [x! / length, y! / length, z! / length] as const;
});
const ICOSAHEDRON_FACES = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
] as const;

/** Vertices one bone and one joint take. */
export const RIG_BONE_VERTICES = 8 * 3;
export const RIG_JOINT_VERTICES = ICOSAHEDRON_FACES.length * 3;

export interface RigPreviewLayout {
  /** The child joint of each drawn bone, in draw order; its parent is the bone's head. */
  bones: number[];
  vertexCount: number;
}

/** One bone per joint that has a parent, then one ball per joint. */
export function rigPreviewLayout(parents: readonly number[]): RigPreviewLayout {
  const bones: number[] = [];
  for (let joint = 0; joint < parents.length; joint++) {
    const parent = parents[joint]!;
    if (parent >= 0 && parent < parents.length && parent !== joint) bones.push(joint);
  }
  return { bones, vertexCount: bones.length * RIG_BONE_VERTICES + parents.length * RIG_JOINT_VERTICES };
}

export interface RigPreviewFrame {
  /** Joint positions, xyz per joint, in the space the preview mesh draws in. */
  joints: Float32Array;
  parents: readonly number[];
  layout: RigPreviewLayout;
  /** The rig's size: its rest bounds' diagonal. Sets the width limits so tiny or huge rigs stay readable. */
  size: number;
  /** Unit direction towards the light (the camera), in the same space. */
  light: readonly [number, number, number];
  /** The selected joint, or -1. */
  selected: number;
  positions: Float32Array;
  colors: Float32Array;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Half-width of the bone from `head` to `tail`, and its length. */
function boneWidth(frame: RigPreviewFrame, head: number, tail: number): { width: number; length: number } {
  const { joints, size } = frame;
  const length = Math.hypot(
    joints[tail * 3]! - joints[head * 3]!,
    joints[tail * 3 + 1]! - joints[head * 3 + 1]!,
    joints[tail * 3 + 2]! - joints[head * 3 + 2]!,
  );
  return { width: clamp(length * WIDTH_PER_LENGTH, size * MIN_WIDTH, size * MAX_WIDTH), length };
}

class Writer {
  private vertex = 0;
  private readonly frame: RigPreviewFrame;
  constructor(frame: RigPreviewFrame) { this.frame = frame; }

  /** One flat triangle; the normal faces away from `inside`, so either winding shades the same. */
  triangle(a: readonly number[], b: readonly number[], c: readonly number[], inside: readonly number[], color: readonly number[]): void {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
    const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    let shade = AMBIENT;
    if (length > 0) {
      nx /= length; ny /= length; nz /= length;
      const outward = (a[0]! + b[0]! + c[0]!) / 3 - inside[0]!;
      const outwardY = (a[1]! + b[1]! + c[1]!) / 3 - inside[1]!;
      const outwardZ = (a[2]! + b[2]! + c[2]!) / 3 - inside[2]!;
      if (nx * outward + ny * outwardY + nz * outwardZ < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const [lx, ly, lz] = this.frame.light;
      shade += DIFFUSE * Math.max(0, nx * lx + ny * ly + nz * lz);
    }
    for (const point of [a, b, c]) {
      const offset = this.vertex * 3;
      this.frame.positions[offset] = point[0]!;
      this.frame.positions[offset + 1] = point[1]!;
      this.frame.positions[offset + 2] = point[2]!;
      const colorOffset = this.vertex * 4;
      this.frame.colors[colorOffset] = color[0]! * shade;
      this.frame.colors[colorOffset + 1] = color[1]! * shade;
      this.frame.colors[colorOffset + 2] = color[2]! * shade;
      this.frame.colors[colorOffset + 3] = 1;
      this.vertex++;
    }
  }

  /** Skips `count` vertices, collapsed onto one point so they draw nothing. */
  collapse(count: number, at: readonly number[]): void {
    for (let index = 0; index < count; index++) {
      const offset = this.vertex * 3;
      this.frame.positions[offset] = at[0]!;
      this.frame.positions[offset + 1] = at[1]!;
      this.frame.positions[offset + 2] = at[2]!;
      this.frame.colors.fill(0, this.vertex * 4, this.vertex * 4 + 3);
      this.frame.colors[this.vertex * 4 + 3] = 1;
      this.vertex++;
    }
  }
}

function jointAt(joints: Float32Array, joint: number): number[] {
  return [joints[joint * 3]!, joints[joint * 3 + 1]!, joints[joint * 3 + 2]!];
}

/** Writes the frame's bones and joint balls into `positions` (xyz) and `colors` (rgba). */
export function writeRigPreview(frame: RigPreviewFrame): void {
  const { joints, parents, layout, selected } = frame;
  const writer = new Writer(frame);
  const jointWidth = new Float32Array(parents.length);
  for (const tail of layout.bones) {
    const head = parents[tail]!;
    const { width, length } = boneWidth(frame, head, tail);
    jointWidth[head] = Math.max(jointWidth[head]!, width);
    jointWidth[tail] = Math.max(jointWidth[tail]!, width);
    const from = jointAt(joints, head);
    const to = jointAt(joints, tail);
    if (length <= 1e-6) {
      writer.collapse(RIG_BONE_VERTICES, from);
      continue;
    }
    const axis = [(to[0]! - from[0]!) / length, (to[1]! - from[1]!) / length, (to[2]! - from[2]!) / length];
    // The ring's frame: any direction across the bone, then the one across both.
    const reference = Math.abs(axis[1]!) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let sx = axis[1]! * reference[2]! - axis[2]! * reference[1]!;
    let sy = axis[2]! * reference[0]! - axis[0]! * reference[2]!;
    let sz = axis[0]! * reference[1]! - axis[1]! * reference[0]!;
    const sideLength = Math.hypot(sx, sy, sz);
    sx /= sideLength; sy /= sideLength; sz /= sideLength;
    const ux = axis[1]! * sz - axis[2]! * sy, uy = axis[2]! * sx - axis[0]! * sz, uz = axis[0]! * sy - axis[1]! * sx;
    const middle = [from[0]! + axis[0]! * length * RING_AT, from[1]! + axis[1]! * length * RING_AT, from[2]! + axis[2]! * length * RING_AT];
    const ring = [
      [middle[0]! + sx * width, middle[1]! + sy * width, middle[2]! + sz * width],
      [middle[0]! + ux * width, middle[1]! + uy * width, middle[2]! + uz * width],
      [middle[0]! - sx * width, middle[1]! - sy * width, middle[2]! - sz * width],
      [middle[0]! - ux * width, middle[1]! - uy * width, middle[2]! - uz * width],
    ];
    const color = head === selected ? RIG_SELECTED_COLOR : RIG_BONE_COLOR;
    for (let side = 0; side < 4; side++) {
      const a = ring[side]!, b = ring[(side + 1) % 4]!;
      writer.triangle(from, a, b, middle, color);
      writer.triangle(to, b, a, middle, color);
    }
  }
  for (let joint = 0; joint < parents.length; joint++) {
    const center = jointAt(joints, joint);
    const width = jointWidth[joint]!;
    const radius = width > 0 ? width * JOINT_PER_WIDTH : frame.size * LONE_JOINT;
    const color = joint === selected ? RIG_SELECTED_COLOR : RIG_JOINT_COLOR;
    for (const [i, j, k] of ICOSAHEDRON_FACES) {
      const point = (index: number) => {
        const unit = ICOSAHEDRON_VERTICES[index]!;
        return [center[0]! + unit[0] * radius, center[1]! + unit[1] * radius, center[2]! + unit[2] * radius];
      };
      writer.triangle(point(i), point(j), point(k), center, color);
    }
  }
}
