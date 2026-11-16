/**
 * Geometry of the rig preview's bones, as the Skeleton, Animation and Animation Graph previews draw them, in the
 * manner of Blender's armatures: one octahedral bone per joint, widest near its head, running to the child that
 * continues it (else to a guessed tail), a thin line to each child it does not continue, and a ball at every drawn
 * joint. Model files store joints, not bone tails, so `rigPreviewTopology` works out from the rest pose which child
 * each joint continues and which joints draw no bone. Every triangle has its own three vertices so it shades flat;
 * shading is a fixed amount of ambient plus a headlight term, baked into vertex colours because the preview's surface
 * is unlit. Pure: no Babylon.
 */

/**
 * Steel-slate bones that read against the preview's sky and stay bluer than neutral greys, near-white joints, dimmer
 * slate lines, and amber for the selected joint and its bone.
 */
export const RIG_BONE_COLOR: readonly [number, number, number] = [0.44, 0.56, 0.74];
export const RIG_JOINT_COLOR: readonly [number, number, number] = [0.93, 0.95, 1];
export const RIG_LINE_COLOR: readonly [number, number, number] = [0.33, 0.4, 0.5];
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
/** A line's half-width against the rig's size: about a pixel across where the rig fills a preview. */
const LINE_WIDTH = 0.0012;

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

/** What a joint draws: nothing, a ball alone, or a bone and a ball. */
export const RIG_JOINT_HIDDEN = 0;
export const RIG_JOINT_MARKER = 1;
export const RIG_JOINT_BONE = 2;

/** A joint as its rest pose has it. */
export interface RigJointRest {
  /** Its parent joint, or -1. */
  parent: number;
  /** Its rest translation in its parent's frame. */
  local: readonly [number, number, number];
  /** Whether it moves anything: skinned vertices weighted to it, or (rigid-part rigs) a mesh part of its own. */
  deforms: boolean;
  /** Directly under the import's root: the armature object a converted FBX keeps as a joint. */
  underImportRoot: boolean;
}

export interface RigPreviewTopology {
  /** Per joint: `RIG_JOINT_HIDDEN`, `RIG_JOINT_MARKER` or `RIG_JOINT_BONE`. */
  kinds: Uint8Array;
  /** Per joint: the child its bone runs to, or -1 when its tail is guessed. */
  connected: Int32Array;
  /** Thin lines from a joint to a child its bone does not run to, as `[parent, child]` pairs. */
  lines: Array<readonly [number, number]>;
  /** The axis bones lie along in their own frames (Blender's +Y), along which a guessed tail runs. */
  axis: readonly [number, number, number];
}

/** A translation's share off its axis below which it lies on that axis. */
const ON_AXIS = 0.01;
const AXES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0], [-1, 0, 0], [0, 0, -1],
];

/** How far `local` runs along `axis`, when it lies on it (positive, nearly nothing off it); else 0. */
function alongAxis(local: readonly number[], axis: readonly number[]): number {
  const length = Math.hypot(local[0]!, local[1]!, local[2]!);
  const along = local[0]! * axis[0]! + local[1]! * axis[1]! + local[2]! * axis[2]!;
  if (!(length > 1e-9) || along <= 0) return 0;
  const off = Math.sqrt(Math.max(0, length * length - along * along));
  return off <= ON_AXIS * length ? along : 0;
}

/**
 * Which joints draw what, from the rest pose. With `connect` (skinned rigs and bare joint hierarchies), the rig's bone
 * axis is the joint axis most children lie along (Blender and FBX bones run along +Y), and a joint's bone runs to its
 * nearest child on that axis; every other child gets a line. Without it (rigid-part rigs, whose node axes say nothing
 * of their parts) every child gets a line. A joint that deforms nothing draws a ball alone; an armature object kept
 * as a joint above the bones (no parent, under the import's root, deforming nothing) draws nothing; and a childless
 * joint that deforms nothing and that its parent's bone runs to is that bone's tail (an exported end marker) and
 * draws nothing either. With `topMarkers` (joint hierarchies with no weights to tell what deforms), the top joint
 * draws a ball alone too.
 */
export function rigPreviewTopology(
  joints: readonly RigJointRest[],
  options: { connect: boolean; topMarkers?: boolean },
): RigPreviewTopology {
  const count = joints.length;
  const children: number[][] = Array.from({ length: count }, () => []);
  joints.forEach((joint, index) => {
    if (joint.parent >= 0 && joint.parent < count && joint.parent !== index) children[joint.parent]!.push(index);
  });
  const parentOf = (index: number) => {
    const parent = joints[index]!.parent;
    return parent >= 0 && parent < count && parent !== index ? parent : -1;
  };
  // The bone axis: the one most links lie along. Too few on any axis leaves every child a line.
  let axis: readonly [number, number, number] = AXES[0]!;
  let connect = options.connect;
  if (connect) {
    let best = -1;
    let links = 0;
    for (const candidate of AXES) {
      let on = 0;
      links = 0;
      joints.forEach((joint, index) => {
        if (parentOf(index) < 0) return;
        links++;
        if (alongAxis(joint.local, candidate) > 0) on++;
      });
      if (on > best) {
        best = on;
        axis = candidate;
      }
    }
    connect = best > 0 && best >= links * 0.25;
  }
  const kinds = new Uint8Array(count);
  joints.forEach((joint, index) => {
    if (parentOf(index) < 0 && joint.underImportRoot && !joint.deforms && children[index]!.length > 0) kinds[index] = RIG_JOINT_HIDDEN;
    else kinds[index] = joint.deforms ? RIG_JOINT_BONE : RIG_JOINT_MARKER;
  });
  if (options.topMarkers) {
    // Without weights to tell, the top joint (a root bone at the floor, as a rule) is a ball.
    joints.forEach((_, index) => {
      const parent = parentOf(index);
      if (kinds[index] === RIG_JOINT_BONE && (parent < 0 || kinds[parent] === RIG_JOINT_HIDDEN)) kinds[index] = RIG_JOINT_MARKER;
    });
  }
  const connected = new Int32Array(count).fill(-1);
  if (connect) {
    for (let index = 0; index < count; index++) {
      if (kinds[index] !== RIG_JOINT_BONE) continue;
      let nearest = Infinity;
      for (const child of children[index]!) {
        const along = alongAxis(joints[child]!.local, axis);
        if (along > 0 && along < nearest) {
          nearest = along;
          connected[index] = child;
        }
      }
    }
  }
  // An end marker is the tail of the bone that runs to it.
  for (let index = 0; index < count; index++) {
    const parent = parentOf(index);
    if (parent >= 0 && !joints[index]!.deforms && children[index]!.length === 0 && connected[parent] === index) {
      kinds[index] = RIG_JOINT_HIDDEN;
    }
  }
  const lines: Array<readonly [number, number]> = [];
  for (let index = 0; index < count; index++) {
    const parent = parentOf(index);
    if (parent < 0 || kinds[index] === RIG_JOINT_HIDDEN || kinds[parent] === RIG_JOINT_HIDDEN) continue;
    if (connected[parent] !== index) lines.push([parent, index]);
  }
  return { kinds, connected, lines, axis };
}

export interface RigPreviewLayout {
  /** The joints that draw a bone, in draw order. */
  bones: number[];
  lines: ReadonlyArray<readonly [number, number]>;
  /** The joints that draw a ball, in draw order. */
  balls: number[];
  vertexCount: number;
}

/** The bones, then the lines, then the balls a topology draws, and the vertices they take. */
export function rigPreviewLayout(topology: RigPreviewTopology): RigPreviewLayout {
  const bones: number[] = [];
  const balls: number[] = [];
  topology.kinds.forEach((kind, joint) => {
    if (kind === RIG_JOINT_BONE) bones.push(joint);
    if (kind !== RIG_JOINT_HIDDEN) balls.push(joint);
  });
  return {
    bones,
    lines: topology.lines,
    balls,
    vertexCount: (bones.length + topology.lines.length) * RIG_BONE_VERTICES + balls.length * RIG_JOINT_VERTICES,
  };
}

export interface RigPreviewFrame {
  /** Joint positions, xyz per joint, in the space the preview mesh draws in. */
  joints: Float32Array;
  /** Each bone's tail point, xyz per joint, read only for the layout's bones; a non-finite one draws no bone. */
  tails: Float32Array;
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

/** Half-width of a bone of `length` in a rig of `size`. */
function boneWidth(length: number, size: number): number {
  return clamp(length * WIDTH_PER_LENGTH, size * MIN_WIDTH, size * MAX_WIDTH);
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

/** One octahedral bone from `from` to `to`, its ring `RING_AT` along it; a zero-length bone collapses to a point. */
function writeBone(writer: Writer, from: number[], to: number[], width: number, color: readonly number[]): void {
  const length = Math.hypot(to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!);
  if (length <= 1e-6) {
    writer.collapse(RIG_BONE_VERTICES, from);
    return;
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
  for (let side = 0; side < 4; side++) {
    const a = ring[side]!, b = ring[(side + 1) % 4]!;
    writer.triangle(from, a, b, middle, color);
    writer.triangle(to, b, a, middle, color);
  }
}

function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

/** Writes the frame's bones, lines and joint balls into `positions` (xyz) and `colors` (rgba). */
export function writeRigPreview(frame: RigPreviewFrame): void {
  const { joints, tails, layout, selected, size } = frame;
  const writer = new Writer(frame);
  const jointWidth = new Float32Array(joints.length / 3);
  for (const joint of layout.bones) {
    const from = jointAt(joints, joint);
    const tail = jointAt(tails, joint);
    const to = tail.every(Number.isFinite) ? tail : from;
    const width = boneWidth(distance(from, to), size);
    jointWidth[joint] = Math.max(jointWidth[joint]!, width);
    writeBone(writer, from, to, width, joint === selected ? RIG_SELECTED_COLOR : RIG_BONE_COLOR);
  }
  for (const [parent, child] of layout.lines) {
    writeBone(writer, jointAt(joints, parent), jointAt(joints, child), size * LINE_WIDTH, RIG_LINE_COLOR);
  }
  for (const joint of layout.balls) {
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
