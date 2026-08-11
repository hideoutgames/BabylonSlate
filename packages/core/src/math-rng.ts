export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Transform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function identityTransform(): Transform {
  return {
    position: vec3(),
    rotation: quatIdentity(),
    scale: vec3(1, 1, 1),
  };
}

export function serializeVec3(v: Vec3): [number, number, number] {
  return [v.x, v.y, v.z];
}

export function serializeQuat(q: Quat): [number, number, number, number] {
  return [q.x, q.y, q.z, q.w];
}

export function serializeTransform(t: Transform): {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
} {
  return {
    position: serializeVec3(t.position),
    rotation: serializeQuat(t.rotation),
    scale: serializeVec3(t.scale),
  };
}

export interface Rng {
  /** Next uint32 in [0, 2^32). */
  next(): number;
  /** Next float in [0, 1). */
  nextFloat(): number;
}

/**
 * Mulberry32 seeded PRNG — deterministic across engines, no platform entropy.
 */
export function createSeededRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    next,
    nextFloat: () => next() / 0x100000000,
  };
}
