export type SkeletonKind = "skin" | "hierarchy";

export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];
export type SkeletonRestChannel = "position" | "rotation" | "scale";
const REST_CHANNELS: readonly SkeletonRestChannel[] = ["position", "rotation", "scale"];

/** One bone of a rig, identified by its name. */
export interface SkeletonBone {
  name: string;
  /** The parent bone's name; null for a root bone. */
  parent: string | null;
  /**
   * Rest transform relative to the parent bone. A root bone's is relative to its file's scene, with every node above
   * it applied, so two files place their roots the same way only when their whole chains agree.
   */
  position: Vec3Tuple;
  /** Quaternion, x y z w. */
  rotation: QuatTuple;
  scale: Vec3Tuple;
  /**
   * Channels whose value is not a rest pose: an animation library has no rest of its own, so the channels its clips
   * key hold their first frame. Matching ignores them, and a Model that joins with the bone fills them in.
   */
  posed?: SkeletonRestChannel[];
}

/**
 * A named point that follows a bone: its offset from the bone, in the bone's own space. Anything that takes a bone
 * name (Attach To Bone, Spawn Particles Attached, an Animation Event's particles) takes a socket's name too.
 */
export interface SkeletonSocket {
  /** Unique among the Skeleton's sockets and bones. */
  name: string;
  /** The bone it follows. A bone the Skeleton no longer has leaves the socket unresolved. */
  bone: string;
  position: Vec3Tuple;
  /** Quaternion, x y z w. */
  rotation: QuatTuple;
  scale: Vec3Tuple;
}

export interface SkeletonPayload {
  /** The Model the Skeleton editor previews; any Model on the Skeleton can be picked. */
  modelGuid: string;
  kind: SkeletonKind;
  /** Parents before children where the source file lists them that way; matching ignores the order. */
  bones: SkeletonBone[];
  /** In the order they were added. */
  sockets: SkeletonSocket[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function trimmedGuid(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberTuple<T extends number[]>(value: unknown, fallback: T): T {
  if (!Array.isArray(value) || value.length !== fallback.length) return [...fallback] as T;
  if (!value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return [...fallback] as T;
  return [...value] as T;
}

function normalizeBones(value: unknown): SkeletonBone[] {
  if (!Array.isArray(value)) return [];
  const bones: SkeletonBone[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = asRecord(entry);
    const name = typeof record.name === "string" ? record.name : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const posed = Array.isArray(record.posed)
      ? REST_CHANNELS.filter((channel) => (record.posed as unknown[]).includes(channel))
      : [];
    bones.push({
      name,
      parent: typeof record.parent === "string" && record.parent.length > 0 ? record.parent : null,
      position: numberTuple<Vec3Tuple>(record.position, [0, 0, 0]),
      rotation: numberTuple<QuatTuple>(record.rotation, [0, 0, 0, 1]),
      scale: numberTuple<Vec3Tuple>(record.scale, [1, 1, 1]),
      ...(posed.length > 0 ? { posed } : {}),
    });
  }
  // A parent outside the rig (or the bone itself) makes the bone a root.
  for (const bone of bones) {
    if (bone.parent !== null && (bone.parent === bone.name || !seen.has(bone.parent))) bone.parent = null;
  }
  return bones;
}

/** Named sockets on a bone, each name unique and none a bone's; unnamed and repeated ones are dropped. */
export function normalizeSkeletonSockets(value: unknown, bones: readonly SkeletonBone[] = []): SkeletonSocket[] {
  if (!Array.isArray(value)) return [];
  const taken = new Set(bones.map((bone) => bone.name));
  const sockets: SkeletonSocket[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name || taken.has(name)) continue;
    taken.add(name);
    sockets.push({
      name,
      bone: typeof record.bone === "string" ? record.bone : "",
      position: numberTuple<Vec3Tuple>(record.position, [0, 0, 0]),
      rotation: numberTuple<QuatTuple>(record.rotation, [0, 0, 0, 1]),
      scale: numberTuple<Vec3Tuple>(record.scale, [1, 1, 1]),
    });
  }
  return sockets;
}

export function normalizeSkeletonPayload(value: unknown): SkeletonPayload {
  const record = asRecord(value);
  const bones = normalizeBones(record.bones);
  return {
    modelGuid: trimmedGuid(record.modelGuid),
    kind: record.kind === "skin" ? "skin" : "hierarchy",
    bones,
    sockets: normalizeSkeletonSockets(record.sockets, bones),
  };
}

/** A name for a new socket on `bone`, unique among the Skeleton's sockets and bones. */
export function nextSkeletonSocketName(payload: SkeletonPayload, bone: string): string {
  const taken = new Set([...payload.bones.map((entry) => entry.name), ...payload.sockets.map((entry) => entry.name)]);
  const base = `${bone}_Socket`;
  if (!taken.has(base)) return base;
  for (let index = 2; ; index++) if (!taken.has(`${base}${index}`)) return `${base}${index}`;
}

/** The bone and socket names an attachment can name, bones first, in the Skeleton's order. */
export function skeletonAttachPointNames(payload: SkeletonPayload): string[] {
  return [...payload.bones.map((bone) => bone.name), ...payload.sockets.map((socket) => socket.name)];
}

export function skeletonBoneNames(payload: SkeletonPayload): string[] {
  return payload.bones.map((bone) => bone.name);
}

export function skeletonAssetGuids(payload: unknown): string[] {
  const guid = normalizeSkeletonPayload(payload).modelGuid;
  return guid ? [guid] : [];
}

/** A rest rotation as Euler degrees in Babylon's order (yaw, pitch, roll), for display. */
export function quaternionToEulerDegrees([x, y, z, w]: QuatTuple): Vec3Tuple {
  const zAxisY = y * z - x * w;
  const limit = 0.4999999;
  let euler: Vec3Tuple;
  if (zAxisY < -limit) euler = [Math.PI / 2, 2 * Math.atan2(y, w), 0];
  else if (zAxisY > limit) euler = [-Math.PI / 2, 2 * Math.atan2(y, w), 0];
  else {
    euler = [
      Math.asin(-2 * zAxisY),
      Math.atan2(2 * (z * x + y * w), z * z - x * x - y * y + w * w),
      Math.atan2(2 * (x * y + z * w), -z * z - x * x + y * y + w * w),
    ];
  }
  // Plus zero, so a display never reads −0.
  return euler.map((radians) => (radians * 180) / Math.PI + 0) as Vec3Tuple;
}

/** Bones depth-first from each root, children in listed order, with their depth; a cycle's bones are left out. */
export function skeletonBoneTree(bones: readonly SkeletonBone[]): Array<{ bone: SkeletonBone; depth: number; hasChildren: boolean }> {
  const children = new Map<string | null, SkeletonBone[]>();
  for (const bone of bones) {
    const siblings = children.get(bone.parent) ?? [];
    siblings.push(bone);
    children.set(bone.parent, siblings);
  }
  const rows: Array<{ bone: SkeletonBone; depth: number; hasChildren: boolean }> = [];
  const visit = (bone: SkeletonBone, depth: number) => {
    const below = children.get(bone.name) ?? [];
    rows.push({ bone, depth, hasChildren: below.length > 0 });
    for (const child of below) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  return rows;
}
