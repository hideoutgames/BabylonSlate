import type { Transform } from "@haptic/core";

export interface ObservedTransformOwner {
  noteTransformChanged(): void;
}

type Vec3 = Transform["position"];
type Quat = Transform["rotation"];

interface Vec3Raw {
  x: number;
  y: number;
  z: number;
  readonly owner: ObservedTransformOwner;
}

interface QuatRaw {
  x: number;
  y: number;
  z: number;
  w: number;
  readonly owner: ObservedTransformOwner;
}

interface TransformRaw {
  readonly position: ObservedVec3;
  readonly rotation: ObservedQuat;
  readonly scale: ObservedVec3;
  readonly posRaw: Vec3Raw;
  readonly rotRaw: QuatRaw;
  readonly scaleRaw: Vec3Raw;
  readonly owner: ObservedTransformOwner;
}

const RAW = Symbol("haptic.observedTransformRaw");

interface ObservedVec3 extends Vec3 {
  readonly [RAW]: Vec3Raw;
}

interface ObservedQuat extends Quat {
  readonly [RAW]: QuatRaw;
}

interface ObservedTransform extends Transform {
  readonly [RAW]: TransformRaw;
}

// Module-level singleton accessors: every observed Vec3, Quat and Transform shares
// the exact same hidden class / Structure and allocates zero per-instance closures.
function getX(this: ObservedVec3 | ObservedQuat): number { return this[RAW].x; }
function setX(this: ObservedVec3 | ObservedQuat, value: number): void {
  const raw = this[RAW];
  if (Object.is(raw.x, value)) return;
  raw.x = value;
  raw.owner.noteTransformChanged();
}
function getY(this: ObservedVec3 | ObservedQuat): number { return this[RAW].y; }
function setY(this: ObservedVec3 | ObservedQuat, value: number): void {
  const raw = this[RAW];
  if (Object.is(raw.y, value)) return;
  raw.y = value;
  raw.owner.noteTransformChanged();
}
function getZ(this: ObservedVec3 | ObservedQuat): number { return this[RAW].z; }
function setZ(this: ObservedVec3 | ObservedQuat, value: number): void {
  const raw = this[RAW];
  if (Object.is(raw.z, value)) return;
  raw.z = value;
  raw.owner.noteTransformChanged();
}
function getW(this: ObservedQuat): number { return this[RAW].w; }
function setW(this: ObservedQuat, value: number): void {
  const raw = this[RAW];
  if (Object.is(raw.w, value)) return;
  raw.w = value;
  raw.owner.noteTransformChanged();
}

function getPosition(this: ObservedTransform): Vec3 { return this[RAW].position; }
function setPosition(this: ObservedTransform, value: Vec3): void {
  const raw = this[RAW].posRaw;
  const x = value.x, y = value.y, z = value.z;
  if (Object.is(raw.x, x) && Object.is(raw.y, y) && Object.is(raw.z, z)) return;
  raw.x = x; raw.y = y; raw.z = z;
  raw.owner.noteTransformChanged();
}
function getRotation(this: ObservedTransform): Quat { return this[RAW].rotation; }
function setRotation(this: ObservedTransform, value: Quat): void {
  const raw = this[RAW].rotRaw;
  const x = value.x, y = value.y, z = value.z, w = value.w;
  if (Object.is(raw.x, x) && Object.is(raw.y, y) && Object.is(raw.z, z) && Object.is(raw.w, w)) return;
  raw.x = x; raw.y = y; raw.z = z; raw.w = w;
  raw.owner.noteTransformChanged();
}
function getScale(this: ObservedTransform): Vec3 { return this[RAW].scale; }
function setScale(this: ObservedTransform, value: Vec3): void {
  const raw = this[RAW].scaleRaw;
  const x = value.x, y = value.y, z = value.z;
  if (Object.is(raw.x, x) && Object.is(raw.y, y) && Object.is(raw.z, z)) return;
  raw.x = x; raw.y = y; raw.z = z;
  raw.owner.noteTransformChanged();
}

const VEC3_DESCRIPTORS: PropertyDescriptorMap = {
  x: { get: getX, set: setX, enumerable: true, configurable: true },
  y: { get: getY, set: setY, enumerable: true, configurable: true },
  z: { get: getZ, set: setZ, enumerable: true, configurable: true },
};

const QUAT_DESCRIPTORS: PropertyDescriptorMap = {
  x: { get: getX, set: setX, enumerable: true, configurable: true },
  y: { get: getY, set: setY, enumerable: true, configurable: true },
  z: { get: getZ, set: setZ, enumerable: true, configurable: true },
  w: { get: getW, set: setW, enumerable: true, configurable: true },
};

const TRANSFORM_DESCRIPTORS: PropertyDescriptorMap = {
  position: { get: getPosition, set: setPosition, enumerable: true, configurable: true },
  rotation: { get: getRotation, set: setRotation, enumerable: true, configurable: true },
  scale: { get: getScale, set: setScale, enumerable: true, configurable: true },
};

function createObservedVec3(raw: Vec3Raw): ObservedVec3 {
  const obj: Record<PropertyKey, unknown> = {};
  Object.defineProperty(obj, RAW, { value: raw, enumerable: false, configurable: false, writable: false });
  Object.defineProperties(obj, VEC3_DESCRIPTORS);
  return obj as unknown as ObservedVec3;
}

function createObservedQuat(raw: QuatRaw): ObservedQuat {
  const obj: Record<PropertyKey, unknown> = {};
  Object.defineProperty(obj, RAW, { value: raw, enumerable: false, configurable: false, writable: false });
  Object.defineProperties(obj, QUAT_DESCRIPTORS);
  return obj as unknown as ObservedQuat;
}

/**
 * Plain-object (`Object.prototype`) Transform whose enumerable own accessors notify `owner` on any
 * coordinate write or sub-object replacement while preserving `{ ...v }`, `Object.keys`, `JSON.stringify`,
 * `structuredClone`, `Object.assign`, and deep-equality assertions.
 */
export function createObservedTransform(
  initial: Transform | undefined,
  owner: ObservedTransformOwner,
): Transform {
  const posRaw: Vec3Raw = initial
    ? { x: initial.position.x, y: initial.position.y, z: initial.position.z, owner }
    : { x: 0, y: 0, z: 0, owner };
  const rotRaw: QuatRaw = initial
    ? { x: initial.rotation.x, y: initial.rotation.y, z: initial.rotation.z, w: initial.rotation.w, owner }
    : { x: 0, y: 0, z: 0, w: 1, owner };
  const scaleRaw: Vec3Raw = initial
    ? { x: initial.scale.x, y: initial.scale.y, z: initial.scale.z, owner }
    : { x: 1, y: 1, z: 1, owner };
  const position = createObservedVec3(posRaw);
  const rotation = createObservedQuat(rotRaw);
  const scale = createObservedVec3(scaleRaw);
  const raw: TransformRaw = { position, rotation, scale, posRaw, rotRaw, scaleRaw, owner };
  const transform: Record<PropertyKey, unknown> = {};
  Object.defineProperty(transform, RAW, { value: raw, enumerable: false, configurable: false, writable: false });
  Object.defineProperties(transform, TRANSFORM_DESCRIPTORS);
  return transform as unknown as Transform;
}

/**
 * Copy all 10 coordinates of `next` into `target` in place, firing at most one notification.
 * Returns true if any coordinate changed (`!Object.is`).
 */
export function writeObservedTransform(target: Transform, next: Transform): boolean {
  const raw = (target as ObservedTransform)[RAW];
  const { posRaw, rotRaw, scaleRaw } = raw;
  const p = next.position, r = next.rotation, s = next.scale;
  const changed =
    !Object.is(posRaw.x, p.x) || !Object.is(posRaw.y, p.y) || !Object.is(posRaw.z, p.z) ||
    !Object.is(rotRaw.x, r.x) || !Object.is(rotRaw.y, r.y) || !Object.is(rotRaw.z, r.z) || !Object.is(rotRaw.w, r.w) ||
    !Object.is(scaleRaw.x, s.x) || !Object.is(scaleRaw.y, s.y) || !Object.is(scaleRaw.z, s.z);
  if (!changed) return false;
  posRaw.x = p.x; posRaw.y = p.y; posRaw.z = p.z;
  rotRaw.x = r.x; rotRaw.y = r.y; rotRaw.z = r.z; rotRaw.w = r.w;
  scaleRaw.x = s.x; scaleRaw.y = s.y; scaleRaw.z = s.z;
  raw.owner.noteTransformChanged();
  return true;
}

/**
 * Write position and rotation directly into `target`'s backing slots without triggering the scripted
 * `noteTransformChanged()` callback (used by `PhysicsReadback`). Returns true iff at least one coordinate changed.
 */
export function writeObservedPoseSilent(target: Transform, position: Vec3, rotation: Quat): boolean {
  const raw = (target as ObservedTransform)[RAW];
  const { posRaw, rotRaw } = raw;
  const changed =
    !Object.is(posRaw.x, position.x) || !Object.is(posRaw.y, position.y) || !Object.is(posRaw.z, position.z) ||
    !Object.is(rotRaw.x, rotation.x) || !Object.is(rotRaw.y, rotation.y) ||
    !Object.is(rotRaw.z, rotation.z) || !Object.is(rotRaw.w, rotation.w);
  if (!changed) return false;
  posRaw.x = position.x; posRaw.y = position.y; posRaw.z = position.z;
  rotRaw.x = rotation.x; rotRaw.y = rotation.y; rotRaw.z = rotation.z; rotRaw.w = rotation.w;
  return true;
}

/** Write position coordinates in place, firing at most one notification. */
export function writeObservedPosition(target: Transform, x: number, y: number, z: number): boolean {
  const raw = (target as ObservedTransform)[RAW].posRaw;
  if (Object.is(raw.x, x) && Object.is(raw.y, y) && Object.is(raw.z, z)) return false;
  raw.x = x; raw.y = y; raw.z = z;
  raw.owner.noteTransformChanged();
  return true;
}

/** Write rotation quaternion coordinates in place, firing at most one notification. */
export function writeObservedRotation(target: Transform, x: number, y: number, z: number, w: number): boolean {
  const raw = (target as ObservedTransform)[RAW].rotRaw;
  if (Object.is(raw.x, x) && Object.is(raw.y, y) && Object.is(raw.z, z) && Object.is(raw.w, w)) return false;
  raw.x = x; raw.y = y; raw.z = z; raw.w = w;
  raw.owner.noteTransformChanged();
  return true;
}

/** Write scale coordinates in place, firing at most one notification. */
export function writeObservedScale(target: Transform, x: number, y: number, z: number): boolean {
  const raw = (target as ObservedTransform)[RAW].scaleRaw;
  if (Object.is(raw.x, x) && Object.is(raw.y, y) && Object.is(raw.z, z)) return false;
  raw.x = x; raw.y = y; raw.z = z;
  raw.owner.noteTransformChanged();
  return true;
}

/** Write position and rotation in place, firing at most one notification. */
export function writeObservedPose(target: Transform, position: Vec3, rotation: Quat): boolean {
  if (!writeObservedPoseSilent(target, position, rotation)) return false;
  (target as ObservedTransform)[RAW].owner.noteTransformChanged();
  return true;
}
