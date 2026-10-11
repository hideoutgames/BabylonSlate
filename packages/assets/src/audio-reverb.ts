import {
  composeAffineTransform,
  identitySerializedTransform,
  multiplyAffineTransforms,
  springArmChildOffset,
  type AffineTransform,
  type CollisionTriangleMesh,
  type SerializedActor,
  type SerializedComponent,
  type SerializedTransform,
} from "@babylonslate/core";
import { complexCollisionMeshForMeshKind } from "./mesh-collision";
import {
  AUDIO_GEOMETRY_COLLECT_SLICE,
  AUDIO_MAX_PROBES,
  AUDIO_OCCUPANCY_GRID_MAX_X,
  AUDIO_OCCUPANCY_GRID_MAX_Y,
  AUDIO_OCCUPANCY_GRID_MAX_Z,
  AUDIO_VOXEL_SIZE,
} from "./audio-payload";

export const AUDIO_REVERB_CHUNK_ID = "audioReverb";
export const AUDIO_REVERB_VERSION = 2;
export const AUDIO_OCCLUSION_WALLS_TO_SATURATE = 2;
export const AUDIO_MUFFLE_LOWPASS_HZ = 700;

const MAGIC = new TextEncoder().encode("BSAR");
const FLAG_DRY = 1;

export type AudioReverbProbe = {
  x: number;
  y: number;
  z: number;
  volume: number;
  openness: number;
  decay: number;
  damping: number;
  wet: number;
};

export type AudioReverbOccupancy = {
  originX: number;
  originY: number;
  originZ: number;
  voxelX: number;
  voxelY: number;
  voxelZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  bits: Uint8Array;
};

export type AudioReverbField = {
  version: number;
  dryFallback: boolean;
  geometryHash: string;
  probes: AudioReverbProbe[];
  occupancy?: AudioReverbOccupancy;
};

export type AudioReverbTriangle = {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  cx: number;
  cy: number;
  cz: number;
};

export type AudioReverbGeometry = {
  triangles: AudioReverbTriangle[];
};

export type AudioReverbOccupancyGrid = {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
};

export type ExtraChunkLike = {
  id: string;
  kind?: string;
  mime?: string;
  data?: Uint8Array;
};

export function audioReverbChunk(bytes: Uint8Array): {
  id: string;
  kind: string;
  mime: string;
  data: Uint8Array;
} {
  return {
    id: AUDIO_REVERB_CHUNK_ID,
    kind: "audioReverb",
    mime: "application/octet-stream",
    data: bytes,
  };
}

/** Replace or insert the Scene `audioReverb` extra chunk, keeping other extras. */
export function extraChunksWithAudioReverb(
  extra: Iterable<ExtraChunkLike>,
  bytes: Uint8Array,
): Array<{ id: string; kind: string; mime: string; data: Uint8Array }> {
  const next: Array<{ id: string; kind: string; mime: string; data: Uint8Array }> =
    [];
  for (const chunk of extra) {
    if (chunk.id === AUDIO_REVERB_CHUNK_ID || !chunk.data) continue;
    next.push({
      id: chunk.id,
      kind: chunk.kind ?? "bin",
      mime: chunk.mime ?? "application/octet-stream",
      data: chunk.data,
    });
  }
  next.push(audioReverbChunk(bytes));
  return next;
}

const OCCUPANCY_HEADER_BYTES = 54;

function occupancyBitCount(sizeX: number, sizeY: number, sizeZ: number): number {
  return Math.max(0, Math.ceil((sizeX * sizeY * sizeZ) / 8));
}

function encodeOccupancy(occupancy: AudioReverbOccupancy): Uint8Array {
  const sizeX = Math.max(1, Math.floor(occupancy.sizeX));
  const sizeY = Math.max(1, Math.floor(occupancy.sizeY));
  const sizeZ = Math.max(1, Math.floor(occupancy.sizeZ));
  const expectedBits = occupancyBitCount(sizeX, sizeY, sizeZ);
  const bits = new Uint8Array(expectedBits);
  bits.set(occupancy.bits.subarray(0, Math.min(occupancy.bits.length, expectedBits)));
  const bytes = new Uint8Array(OCCUPANCY_HEADER_BYTES + expectedBits);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setFloat64(0, occupancy.originX, true);
  view.setFloat64(8, occupancy.originY, true);
  view.setFloat64(16, occupancy.originZ, true);
  view.setFloat64(24, occupancy.voxelX, true);
  view.setFloat64(32, occupancy.voxelY, true);
  view.setFloat64(40, occupancy.voxelZ, true);
  view.setUint16(48, sizeX, true);
  view.setUint16(50, sizeY, true);
  view.setUint16(52, sizeZ, true);
  bytes.set(bits, OCCUPANCY_HEADER_BYTES);
  return bytes;
}

function decodeOccupancy(
  bytes: Uint8Array,
  offset: number,
): AudioReverbOccupancy | undefined {
  if (bytes.byteLength < offset + OCCUPANCY_HEADER_BYTES) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sizeX = view.getUint16(offset + 48, true);
  const sizeY = view.getUint16(offset + 50, true);
  const sizeZ = view.getUint16(offset + 52, true);
  if (sizeX < 1 || sizeY < 1 || sizeZ < 1) {
    return undefined;
  }
  const expectedBits = occupancyBitCount(sizeX, sizeY, sizeZ);
  if (bytes.byteLength < offset + OCCUPANCY_HEADER_BYTES + expectedBits) {
    return undefined;
  }
  return {
    originX: view.getFloat64(offset, true),
    originY: view.getFloat64(offset + 8, true),
    originZ: view.getFloat64(offset + 16, true),
    voxelX: view.getFloat64(offset + 24, true),
    voxelY: view.getFloat64(offset + 32, true),
    voxelZ: view.getFloat64(offset + 40, true),
    sizeX,
    sizeY,
    sizeZ,
    bits: bytes.slice(
      offset + OCCUPANCY_HEADER_BYTES,
      offset + OCCUPANCY_HEADER_BYTES + expectedBits,
    ),
  };
}

function occupancyCellOccupied(
  occupancy: AudioReverbOccupancy,
  ix: number,
  iy: number,
  iz: number,
): boolean {
  if (
    ix < 0 ||
    iy < 0 ||
    iz < 0 ||
    ix >= occupancy.sizeX ||
    iy >= occupancy.sizeY ||
    iz >= occupancy.sizeZ
  ) {
    return false;
  }
  const index = ix + occupancy.sizeX * (iy + occupancy.sizeY * iz);
  const packed = occupancy.bits[index >> 3];
  if (packed === undefined) return false;
  return ((packed >> (index & 7)) & 1) === 1;
}

/** Occupied voxels along the emitter→listener segment, saturated after two walls. */
export function occlusionFactor(
  emitter: { x: number; y: number; z: number },
  listener: { x: number; y: number; z: number },
  occupancy: AudioReverbOccupancy | null | undefined,
): number {
  if (
    !occupancy ||
    occupancy.voxelX <= 0 ||
    occupancy.voxelY <= 0 ||
    occupancy.voxelZ <= 0
  ) {
    return 0;
  }
  const startX = (emitter.x - occupancy.originX) / occupancy.voxelX;
  const startY = (emitter.y - occupancy.originY) / occupancy.voxelY;
  const startZ = (emitter.z - occupancy.originZ) / occupancy.voxelZ;
  const endX = (listener.x - occupancy.originX) / occupancy.voxelX;
  const endY = (listener.y - occupancy.originY) / occupancy.voxelY;
  const endZ = (listener.z - occupancy.originZ) / occupancy.voxelZ;
  const dx = endX - startX;
  const dy = endY - startY;
  const dz = endZ - startZ;
  let ix = Math.floor(startX);
  let iy = Math.floor(startY);
  let iz = Math.floor(startZ);
  const endIx = Math.floor(endX);
  const endIy = Math.floor(endY);
  const endIz = Math.floor(endZ);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const tDeltaX = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy);
  const tDeltaZ = dz === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dz);
  const firstPlane = (coord: number, step: number): number => {
    if (step > 0) return Math.floor(coord) + 1 - coord;
    if (step < 0) return coord - Math.floor(coord);
    return Number.POSITIVE_INFINITY;
  };
  let tMaxX =
    stepX === 0
      ? Number.POSITIVE_INFINITY
      : firstPlane(startX, stepX) * tDeltaX;
  let tMaxY =
    stepY === 0
      ? Number.POSITIVE_INFINITY
      : firstPlane(startY, stepY) * tDeltaY;
  let tMaxZ =
    stepZ === 0
      ? Number.POSITIVE_INFINITY
      : firstPlane(startZ, stepZ) * tDeltaZ;
  const maxSteps = occupancy.sizeX + occupancy.sizeY + occupancy.sizeZ + 8;
  let walls = 0;
  let skippedStart = false;
  for (let step = 0; step < maxSteps; step += 1) {
    if (skippedStart && occupancyCellOccupied(occupancy, ix, iy, iz)) {
      walls += 1;
      if (walls >= AUDIO_OCCLUSION_WALLS_TO_SATURATE) {
        return 1;
      }
    }
    skippedStart = true;
    if (ix === endIx && iy === endIy && iz === endIz) {
      break;
    }
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      ix += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY <= tMaxZ) {
      iy += stepY;
      tMaxY += tDeltaY;
    } else {
      iz += stepZ;
      tMaxZ += tDeltaZ;
    }
  }
  return Math.min(1, walls / AUDIO_OCCLUSION_WALLS_TO_SATURATE);
}

export function encodeAudioReverbChunk(field: AudioReverbField): Uint8Array {
  const hashBytes = new TextEncoder().encode(field.geometryHash);
  const header = 4 + 4 + 4 + 2 + hashBytes.byteLength + 2;
  const probeBytes = field.probes.length * 64;
  const occupancyBytes = field.occupancy
    ? encodeOccupancy(field.occupancy)
    : new Uint8Array();
  const bytes = new Uint8Array(header + probeBytes + occupancyBytes.byteLength);
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(4, field.version, true);
  view.setUint32(8, field.dryFallback ? FLAG_DRY : 0, true);
  view.setUint16(12, hashBytes.byteLength, true);
  bytes.set(hashBytes, 14);
  let offset = 14 + hashBytes.byteLength;
  view.setUint16(offset, field.probes.length, true);
  offset += 2;
  for (const probe of field.probes) {
    view.setFloat64(offset, probe.x, true);
    view.setFloat64(offset + 8, probe.y, true);
    view.setFloat64(offset + 16, probe.z, true);
    view.setFloat64(offset + 24, probe.volume, true);
    view.setFloat64(offset + 32, probe.openness, true);
    view.setFloat64(offset + 40, probe.decay, true);
    view.setFloat64(offset + 48, probe.damping, true);
    view.setFloat64(offset + 56, probe.wet, true);
    offset += 64;
  }
  if (occupancyBytes.byteLength > 0) {
    bytes.set(occupancyBytes, offset);
  }
  return bytes;
}

export function decodeAudioReverbChunk(
  bytes: Uint8Array | null | undefined,
): AudioReverbField | null {
  if (!bytes || bytes.byteLength < 16) return null;
  if (
    bytes[0] !== MAGIC[0] ||
    bytes[1] !== MAGIC[1] ||
    bytes[2] !== MAGIC[2] ||
    bytes[3] !== MAGIC[3]
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  const flags = view.getUint32(8, true);
  const hashLen = view.getUint16(12, true);
  if (14 + hashLen + 2 > bytes.byteLength) return null;
  const geometryHash = new TextDecoder().decode(
    bytes.subarray(14, 14 + hashLen),
  );
  let offset = 14 + hashLen;
  const probeCount = view.getUint16(offset, true);
  offset += 2;
  if (offset + probeCount * 64 > bytes.byteLength) return null;
  const probes: AudioReverbProbe[] = [];
  for (let i = 0; i < probeCount; i += 1) {
    probes.push({
      x: view.getFloat64(offset, true),
      y: view.getFloat64(offset + 8, true),
      z: view.getFloat64(offset + 16, true),
      volume: view.getFloat64(offset + 24, true),
      openness: view.getFloat64(offset + 32, true),
      decay: view.getFloat64(offset + 40, true),
      damping: view.getFloat64(offset + 48, true),
      wet: view.getFloat64(offset + 56, true),
    });
    offset += 64;
  }
  const occupancy = decodeOccupancy(bytes, offset);
  return {
    version,
    dryFallback: (flags & FLAG_DRY) !== 0,
    geometryHash,
    probes,
    ...(occupancy ? { occupancy } : {}),
  };
}

export function isDryAudioReverbFallback(
  field: AudioReverbField | null | undefined,
): boolean {
  return !field || field.dryFallback === true;
}

export function dryAudioReverbFallbackBytes(geometryHash: string): Uint8Array {
  return encodeAudioReverbChunk({
    version: AUDIO_REVERB_VERSION,
    dryFallback: true,
    geometryHash,
    probes: [],
  });
}

/** Sync FNV-1a of quantized triangle verts — not SHA-256. */
export function geometryHashForAudioBake(
  geometry: AudioReverbGeometry,
): string {
  let hash = 0x811c9dc5;
  const write = (value: number) => {
    const quantized = Math.round(value * 1000);
    hash ^= quantized & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (quantized >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (quantized >>> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (quantized >>> 24) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  write(geometry.triangles.length);
  for (const triangle of geometry.triangles) {
    write(triangle.ax);
    write(triangle.ay);
    write(triangle.az);
    write(triangle.bx);
    write(triangle.by);
    write(triangle.bz);
    write(triangle.cx);
    write(triangle.cy);
    write(triangle.cz);
  }
  return hash.toString(16).padStart(8, "0");
}

/** `Matrix.Compose` of a serialized transform (row-vector layout, as authored). */
function affineOf(transform: SerializedTransform | undefined): AffineTransform {
  const { position: [px, py, pz], rotation: [rx, ry, rz, rw], scale: [sx, sy, sz] } =
    transform ?? identitySerializedTransform();
  return composeAffineTransform({
    position: { x: px, y: py, z: pz },
    rotation: { x: rx, y: ry, z: rz, w: rw },
    scale: { x: sx, y: sy, z: sz },
  });
}

/**
 * Authored world matrices of actors (`local × parentWorld`, as the editor and
 * Play place them). A cyclic or dangling attachment has no placement: null.
 */
function actorWorldMatrices(actors: readonly SerializedActor[]): (actor: SerializedActor) => AffineTransform | null {
  const byId = new Map(actors.map((actor) => [actor.id, actor]));
  const worlds = new Map<string, AffineTransform | null>();
  const world = (actor: SerializedActor): AffineTransform | null => {
    const cached = worlds.get(actor.id);
    if (cached !== undefined) return cached;
    worlds.set(actor.id, null);
    let matrix: AffineTransform | null = affineOf(actor.transform);
    if (actor.parentId) {
      const parent = byId.get(actor.parentId);
      const parentWorld = parent ? world(parent) : null;
      matrix = parentWorld ? multiplyAffineTransforms(matrix, parentWorld, matrix) : null;
    }
    worlds.set(actor.id, matrix);
    return matrix;
  };
  return world;
}

/** A component relative to its actor: its parent components (and Spring Arm sockets) compose in. */
function componentActorMatrix(actor: SerializedActor, component: SerializedComponent): AffineTransform {
  const matrix = affineOf(component.transform);
  const byId = new Map(actor.components.map((entry) => [entry.id, entry]));
  const visited = new Set([component.id]);
  let parent = component.parentId ? byId.get(component.parentId) : undefined;
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    const offset = springArmChildOffset(parent);
    if (offset) {
      matrix[9] = matrix[9]! + offset[0];
      matrix[10] = matrix[10]! + offset[1];
      matrix[11] = matrix[11]! + offset[2];
    }
    multiplyAffineTransforms(matrix, affineOf(parent.transform), matrix);
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return matrix;
}

function pushMeshTriangles(
  triangles: AudioReverbTriangle[],
  mesh: CollisionTriangleMesh,
  world: AffineTransform,
): void {
  const { positions, indices } = mesh;
  const point = (index: number): [number, number, number] => {
    const x = positions[index * 3]!, y = positions[index * 3 + 1]!, z = positions[index * 3 + 2]!;
    return [
      x * world[0]! + y * world[3]! + z * world[6]! + world[9]!,
      x * world[1]! + y * world[4]! + z * world[7]! + world[10]!,
      x * world[2]! + y * world[5]! + z * world[8]! + world[11]!,
    ];
  };
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const [ax, ay, az] = point(indices[i]!);
    const [bx, by, bz] = point(indices[i + 1]!);
    const [cx, cy, cz] = point(indices[i + 2]!);
    triangles.push({ ax, ay, az, bx, by, bz, cx, cy, cz });
  }
}

function isDynamicRigidBody(actor: SerializedActor): boolean {
  return actor.components.some(
    (component) =>
      component.classId === "RigidBodyComponent" &&
      component.properties.motionType === "dynamic",
  );
}

function hasMeshComponent(actor: SerializedActor): boolean {
  return actor.components.some(
    (component) => component.classId === "MeshComponent",
  );
}

/**
 * Static MeshComponent triangles in world space: each primitive's own shape
 * and size (`createPrimitiveMesh`), placed through its component and actor
 * attachments. A Model mesh (`assetGuid`) stands in as the Box primitive:
 * the bake reads scene actors only, not Model geometry.
 */
export async function collectStaticAudioGeometry(options: {
  actors: readonly SerializedActor[];
  yieldSlice?: () => Promise<void>;
}): Promise<AudioReverbGeometry> {
  const triangles: AudioReverbTriangle[] = [];
  const actorWorld = actorWorldMatrices(options.actors);
  const meshes = new Map<string, CollisionTriangleMesh>();
  let processed = 0;
  for (const actor of options.actors) {
    if (isDynamicRigidBody(actor)) continue;
    if (!hasMeshComponent(actor)) continue;
    const world = actorWorld(actor);
    for (const component of world ? actor.components : []) {
      if (component.classId !== "MeshComponent") continue;
      const kind = typeof component.properties.assetGuid === "string" && component.properties.assetGuid
        ? "box"
        : String(component.properties.meshKind ?? "box");
      let mesh = meshes.get(kind);
      if (!mesh) {
        mesh = complexCollisionMeshForMeshKind(kind);
        meshes.set(kind, mesh);
      }
      pushMeshTriangles(triangles, mesh, multiplyAffineTransforms(componentActorMatrix(actor, component), world!));
    }
    processed += 1;
    if (
      processed % AUDIO_GEOMETRY_COLLECT_SLICE === 0 &&
      options.yieldSlice
    ) {
      await options.yieldSlice();
    }
  }
  return { triangles };
}

type InternalGrid = AudioReverbOccupancyGrid & {
  occupied: Uint8Array;
  originX: number;
  originY: number;
  originZ: number;
  voxelX: number;
  voxelY: number;
  voxelZ: number;
};

function occupancyFromGrid(grid: InternalGrid): AudioReverbOccupancy {
  const sizeX = Math.max(1, Math.floor(grid.sizeX));
  const sizeY = Math.max(1, Math.floor(grid.sizeY));
  const sizeZ = Math.max(1, Math.floor(grid.sizeZ));
  const cellCount = sizeX * sizeY * sizeZ;
  const bits = new Uint8Array(occupancyBitCount(sizeX, sizeY, sizeZ));
  for (let i = 0; i < cellCount && i < grid.occupied.length; i += 1) {
    if (grid.occupied[i] !== 0) {
      bits[i >> 3] |= 1 << (i & 7);
    }
  }
  return {
    originX: grid.originX,
    originY: grid.originY,
    originZ: grid.originZ,
    voxelX: grid.voxelX,
    voxelY: grid.voxelY,
    voxelZ: grid.voxelZ,
    sizeX,
    sizeY,
    sizeZ,
    bits,
  };
}

function emptyGrid(): InternalGrid {
  return {
    sizeX: 1,
    sizeY: 1,
    sizeZ: 1,
    occupied: new Uint8Array(1),
    originX: 0,
    originY: 0,
    originZ: 0,
    voxelX: AUDIO_VOXEL_SIZE,
    voxelY: AUDIO_VOXEL_SIZE,
    voxelZ: AUDIO_VOXEL_SIZE,
  };
}

function clampGridAxis(
  extent: number,
  maxCells: number,
): { size: number; voxel: number } {
  const safeExtent = Math.max(extent, AUDIO_VOXEL_SIZE);
  let voxel = AUDIO_VOXEL_SIZE;
  let size = Math.max(1, Math.ceil(safeExtent / voxel));
  if (size > maxCells) {
    voxel = safeExtent / maxCells;
    size = maxCells;
  }
  return { size, voxel };
}

function buildOccupancy(geometry: AudioReverbGeometry): InternalGrid {
  if (geometry.triangles.length === 0) return emptyGrid();
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const bump = (x: number, y: number, z: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  };
  for (const triangle of geometry.triangles) {
    bump(triangle.ax, triangle.ay, triangle.az);
    bump(triangle.bx, triangle.by, triangle.bz);
    bump(triangle.cx, triangle.cy, triangle.cz);
  }
  const x = clampGridAxis(maxX - minX, AUDIO_OCCUPANCY_GRID_MAX_X);
  const y = clampGridAxis(maxY - minY, AUDIO_OCCUPANCY_GRID_MAX_Y);
  const z = clampGridAxis(maxZ - minZ, AUDIO_OCCUPANCY_GRID_MAX_Z);
  const occupied = new Uint8Array(x.size * y.size * z.size);
  const grid: InternalGrid = {
    sizeX: x.size,
    sizeY: y.size,
    sizeZ: z.size,
    occupied,
    originX: minX,
    originY: minY,
    originZ: minZ,
    voxelX: x.voxel,
    voxelY: y.voxel,
    voxelZ: z.voxel,
  };
  const indexOf = (ix: number, iy: number, iz: number) =>
    ix + iy * grid.sizeX + iz * grid.sizeX * grid.sizeY;
  const halfX = grid.voxelX / 2;
  const halfY = grid.voxelY / 2;
  const halfZ = grid.voxelZ / 2;
  // Mark the voxels of the triangle's bounds that the triangle itself touches:
  // a slanted wall marks a band of voxels, not the box around it.
  const markTriangle = (triangle: AudioReverbTriangle) => {
    const x0 = Math.min(triangle.ax, triangle.bx, triangle.cx);
    const y0 = Math.min(triangle.ay, triangle.by, triangle.cy);
    const z0 = Math.min(triangle.az, triangle.bz, triangle.cz);
    const x1 = Math.max(triangle.ax, triangle.bx, triangle.cx);
    const y1 = Math.max(triangle.ay, triangle.by, triangle.cy);
    const z1 = Math.max(triangle.az, triangle.bz, triangle.cz);
    const ix0 = Math.max(0, Math.floor((x0 - grid.originX) / grid.voxelX));
    const iy0 = Math.max(0, Math.floor((y0 - grid.originY) / grid.voxelY));
    const iz0 = Math.max(0, Math.floor((z0 - grid.originZ) / grid.voxelZ));
    const ix1 = Math.min(
      grid.sizeX - 1,
      Math.floor((x1 - grid.originX) / grid.voxelX),
    );
    const iy1 = Math.min(
      grid.sizeY - 1,
      Math.floor((y1 - grid.originY) / grid.voxelY),
    );
    const iz1 = Math.min(
      grid.sizeZ - 1,
      Math.floor((z1 - grid.originZ) / grid.voxelZ),
    );
    for (let iz = iz0; iz <= iz1; iz += 1) {
      for (let iy = iy0; iy <= iy1; iy += 1) {
        for (let ix = ix0; ix <= ix1; ix += 1) {
          const index = indexOf(ix, iy, iz);
          if (occupied[index]) continue;
          if (triangleTouchesBox(
            grid.originX + (ix + 0.5) * grid.voxelX,
            grid.originY + (iy + 0.5) * grid.voxelY,
            grid.originZ + (iz + 0.5) * grid.voxelZ,
            halfX, halfY, halfZ, triangle,
          )) occupied[index] = 1;
        }
      }
    }
  };
  for (const triangle of geometry.triangles) markTriangle(triangle);
  return grid;
}

/** Separating-axis triangle / axis-aligned box test; touching counts as overlap. */
function triangleTouchesBox(
  centerX: number,
  centerY: number,
  centerZ: number,
  halfX: number,
  halfY: number,
  halfZ: number,
  triangle: AudioReverbTriangle,
): boolean {
  const eps = 1e-9;
  const v0x = triangle.ax - centerX, v0y = triangle.ay - centerY, v0z = triangle.az - centerZ;
  const v1x = triangle.bx - centerX, v1y = triangle.by - centerY, v1z = triangle.bz - centerZ;
  const v2x = triangle.cx - centerX, v2y = triangle.cy - centerY, v2z = triangle.cz - centerZ;
  const separated = (ax: number, ay: number, az: number): boolean => {
    const p0 = v0x * ax + v0y * ay + v0z * az;
    const p1 = v1x * ax + v1y * ay + v1z * az;
    const p2 = v2x * ax + v2y * ay + v2z * az;
    const radius = halfX * Math.abs(ax) + halfY * Math.abs(ay) + halfZ * Math.abs(az);
    return Math.min(p0, p1, p2) > radius + eps || Math.max(p0, p1, p2) < -radius - eps;
  };
  // The box's face normals.
  if (separated(1, 0, 0) || separated(0, 1, 0) || separated(0, 0, 1)) return false;
  // Each triangle edge crossed with each box axis.
  const edges: Array<[number, number, number]> = [
    [v1x - v0x, v1y - v0y, v1z - v0z],
    [v2x - v1x, v2y - v1y, v2z - v1z],
    [v0x - v2x, v0y - v2y, v0z - v2z],
  ];
  for (const [ex, ey, ez] of edges) {
    if (separated(0, -ez, ey) || separated(ez, 0, -ex) || separated(-ey, ex, 0)) return false;
  }
  // The triangle's plane.
  const [e0x, e0y, e0z] = edges[0]!;
  const [e1x, e1y, e1z] = edges[1]!;
  return !separated(e0y * e1z - e0z * e1y, e0z * e1x - e0x * e1z, e0x * e1y - e0y * e1x);
}

const NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function floodExterior(grid: InternalGrid): Uint8Array {
  const exterior = new Uint8Array(grid.occupied.length);
  const indexOf = (ix: number, iy: number, iz: number) =>
    ix + iy * grid.sizeX + iz * grid.sizeX * grid.sizeY;
  const inBounds = (ix: number, iy: number, iz: number) =>
    ix >= 0 &&
    iy >= 0 &&
    iz >= 0 &&
    ix < grid.sizeX &&
    iy < grid.sizeY &&
    iz < grid.sizeZ;
  const queue: number[] = [];
  const tryVisit = (ix: number, iy: number, iz: number) => {
    if (!inBounds(ix, iy, iz)) return;
    const index = indexOf(ix, iy, iz);
    if (grid.occupied[index] || exterior[index]) return;
    exterior[index] = 1;
    queue.push(index);
  };
  for (let iy = 0; iy < grid.sizeY; iy += 1) {
    for (let ix = 0; ix < grid.sizeX; ix += 1) {
      tryVisit(ix, iy, 0);
      tryVisit(ix, iy, grid.sizeZ - 1);
    }
  }
  for (let iz = 0; iz < grid.sizeZ; iz += 1) {
    for (let ix = 0; ix < grid.sizeX; ix += 1) {
      tryVisit(ix, 0, iz);
      tryVisit(ix, grid.sizeY - 1, iz);
    }
  }
  for (let iz = 0; iz < grid.sizeZ; iz += 1) {
    for (let iy = 0; iy < grid.sizeY; iy += 1) {
      tryVisit(0, iy, iz);
      tryVisit(grid.sizeX - 1, iy, iz);
    }
  }
  while (queue.length > 0) {
    const index = queue.pop()!;
    const ix = index % grid.sizeX;
    const plane = (index / grid.sizeX) | 0;
    const iy = plane % grid.sizeY;
    const iz = (plane / grid.sizeY) | 0;
    for (const [dx, dy, dz] of NEIGHBORS) {
      tryVisit(ix + dx, iy + dy, iz + dz);
    }
  }
  return exterior;
}

function cellCenter(
  grid: InternalGrid,
  ix: number,
  iy: number,
  iz: number,
): AudioReverbProbe {
  const x = grid.originX + (ix + 0.5) * grid.voxelX;
  const y = grid.originY + (iy + 0.5) * grid.voxelY;
  const z = grid.originZ + (iz + 0.5) * grid.voxelZ;
  return {
    x,
    y,
    z,
    volume: grid.voxelX * grid.voxelY * grid.voxelZ,
    openness: 0,
    decay: 0.4,
    damping: 0.5,
    wet: 0.25,
  };
}

function subsampleCells(
  cells: number[],
  grid: InternalGrid,
  exterior: Uint8Array,
): AudioReverbProbe[] {
  if (cells.length === 0) return [];
  cells.sort((a, b) => a - b);
  const stride = Math.max(1, Math.ceil(cells.length / AUDIO_MAX_PROBES));
  const probes: AudioReverbProbe[] = [];
  const indexOf = (ix: number, iy: number, iz: number) =>
    ix + iy * grid.sizeX + iz * grid.sizeX * grid.sizeY;
  const decode = (index: number) => {
    const ix = index % grid.sizeX;
    const plane = (index / grid.sizeX) | 0;
    const iy = plane % grid.sizeY;
    const iz = (plane / grid.sizeY) | 0;
    return [ix, iy, iz] as const;
  };
  for (let i = 0; i < cells.length && probes.length < AUDIO_MAX_PROBES; i += stride) {
    const index = cells[i]!;
    const [ix, iy, iz] = decode(index);
    const probe = cellCenter(grid, ix, iy, iz);
    let open = 0;
    let neighbors = 0;
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = ix + dx;
      const ny = iy + dy;
      const nz = iz + dz;
      neighbors += 1;
      if (
        nx < 0 ||
        ny < 0 ||
        nz < 0 ||
        nx >= grid.sizeX ||
        ny >= grid.sizeY ||
        nz >= grid.sizeZ
      ) {
        open += 1;
        continue;
      }
      const nIndex = indexOf(nx, ny, nz);
      if (exterior[nIndex] || grid.occupied[nIndex]) open += 1;
    }
    const openness = neighbors === 0 ? 1 : open / neighbors;
    const enclosed = 1 - openness;
    probe.openness = openness;
    probe.volume = cells.length * grid.voxelX * grid.voxelY * grid.voxelZ;
    probe.decay = 0.2 + enclosed * 0.5;
    probe.damping = 0.3 + enclosed * 0.4;
    probe.wet = Math.min(0.5, 0.1 + enclosed * 0.4);
    probes.push(probe);
  }
  return probes;
}

export function bakeAudioReverb(geometry: AudioReverbGeometry): Uint8Array {
  const geometryHash = geometryHashForAudioBake(geometry);
  if (geometry.triangles.length === 0) {
    return dryAudioReverbFallbackBytes(geometryHash);
  }
  const grid = buildOccupancy(geometry);
  const exterior = floodExterior(grid);
  const interior: number[] = [];
  const empty: number[] = [];
  for (let i = 0; i < grid.occupied.length; i += 1) {
    if (grid.occupied[i]) continue;
    empty.push(i);
    if (!exterior[i]) interior.push(i);
  }
  const probes = subsampleCells(
    interior.length > 0 ? interior : empty,
    grid,
    exterior,
  );
  if (probes.length === 0) {
    return dryAudioReverbFallbackBytes(geometryHash);
  }
  return encodeAudioReverbChunk({
    version: AUDIO_REVERB_VERSION,
    dryFallback: false,
    geometryHash,
    probes,
    occupancy: occupancyFromGrid(grid),
  });
}

/** Inverse-distance blend of at most two nearest probes. */
export type InterpolatedAudioReverb = {
  wet: number;
  decay: number;
  damping: number;
};

const DRY_REVERB_PROFILE: InterpolatedAudioReverb = {
  wet: 0,
  decay: 0.4,
  damping: 0.5,
};

function blendProbeField(
  first: number,
  second: number,
  weightFirst: number,
  weightSecond: number,
): number {
  return (first * weightFirst + second * weightSecond) / (weightFirst + weightSecond);
}

export function interpolateAudioReverb(
  listener: { x: number; y: number; z: number },
  probes: readonly AudioReverbProbe[],
): InterpolatedAudioReverb {
  if (probes.length === 0) return { ...DRY_REVERB_PROFILE };
  if (probes.length === 1) {
    const probe = probes[0]!;
    return { wet: probe.wet, decay: probe.decay, damping: probe.damping };
  }
  let first: AudioReverbProbe | null = null;
  let second: AudioReverbProbe | null = null;
  let firstDist = Infinity;
  let secondDist = Infinity;
  for (const probe of probes) {
    const dist = Math.hypot(
      probe.x - listener.x,
      probe.y - listener.y,
      probe.z - listener.z,
    );
    if (dist < firstDist) {
      second = first;
      secondDist = firstDist;
      first = probe;
      firstDist = dist;
    } else if (dist < secondDist) {
      second = probe;
      secondDist = dist;
    }
  }
  if (!first) return { ...DRY_REVERB_PROFILE };
  if (!second || firstDist === 0) {
    return { wet: first.wet, decay: first.decay, damping: first.damping };
  }
  const w1 = 1 / firstDist;
  const w2 = 1 / secondDist;
  return {
    wet: blendProbeField(first.wet, second.wet, w1, w2),
    decay: blendProbeField(first.decay, second.decay, w1, w2),
    damping: blendProbeField(first.damping, second.damping, w1, w2),
  };
}

export function packAudioReverbTriangles(
  geometry: AudioReverbGeometry,
): Float32Array {
  const packed = new Float32Array(geometry.triangles.length * 9);
  let offset = 0;
  for (const triangle of geometry.triangles) {
    packed[offset] = triangle.ax;
    packed[offset + 1] = triangle.ay;
    packed[offset + 2] = triangle.az;
    packed[offset + 3] = triangle.bx;
    packed[offset + 4] = triangle.by;
    packed[offset + 5] = triangle.bz;
    packed[offset + 6] = triangle.cx;
    packed[offset + 7] = triangle.cy;
    packed[offset + 8] = triangle.cz;
    offset += 9;
  }
  return packed;
}

export function unpackAudioReverbTriangles(
  packed: Float32Array,
): AudioReverbGeometry {
  const triangles: AudioReverbTriangle[] = [];
  for (let i = 0; i + 8 < packed.length; i += 9) {
    triangles.push({
      ax: packed[i]!,
      ay: packed[i + 1]!,
      az: packed[i + 2]!,
      bx: packed[i + 3]!,
      by: packed[i + 4]!,
      bz: packed[i + 5]!,
      cx: packed[i + 6]!,
      cy: packed[i + 7]!,
      cz: packed[i + 8]!,
    });
  }
  return { triangles };
}
