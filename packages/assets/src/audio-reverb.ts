import {
  identitySerializedTransform,
  type SerializedActor,
  type SerializedComponent,
  type SerializedTransform,
} from "@babylonslate/core";
import {
  AUDIO_GEOMETRY_COLLECT_SLICE,
  AUDIO_MAX_PROBES,
  AUDIO_OCCUPANCY_GRID_MAX_X,
  AUDIO_OCCUPANCY_GRID_MAX_Y,
  AUDIO_OCCUPANCY_GRID_MAX_Z,
  AUDIO_VOXEL_SIZE,
} from "./audio-payload";

export const AUDIO_REVERB_CHUNK_ID = "audioReverb";
export const AUDIO_REVERB_VERSION = 1;

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

export type AudioReverbField = {
  version: number;
  dryFallback: boolean;
  geometryHash: string;
  probes: AudioReverbProbe[];
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

export function audioReverbBytesFromChunks(
  chunks: Iterable<{ id: string; data?: Uint8Array }>,
): Uint8Array | null {
  for (const chunk of chunks) {
    if (chunk.id === AUDIO_REVERB_CHUNK_ID && chunk.data) return chunk.data;
  }
  return null;
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

export function encodeAudioReverbChunk(field: AudioReverbField): Uint8Array {
  const hashBytes = new TextEncoder().encode(field.geometryHash);
  const header = 4 + 4 + 4 + 2 + hashBytes.byteLength + 2;
  const bytes = new Uint8Array(header + field.probes.length * 64);
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
  return {
    version,
    dryFallback: (flags & FLAG_DRY) !== 0,
    geometryHash,
    probes,
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

function actorTransform(actor: SerializedActor): SerializedTransform {
  return actor.transform ?? identitySerializedTransform();
}

function componentTransform(
  component: SerializedComponent,
): SerializedTransform {
  return component.transform ?? identitySerializedTransform();
}

function rotateByQuat(
  x: number,
  y: number,
  z: number,
  q: readonly [number, number, number, number],
): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const uvx = qy * z - qz * y;
  const uvy = qz * x - qx * z;
  const uvz = qx * y - qy * x;
  const uuvx = qy * uvz - qz * uvy;
  const uuvy = qz * uvx - qx * uvz;
  const uuvz = qx * uvy - qy * uvx;
  const w2 = qw * 2;
  return [
    x + uvx * w2 + uuvx * 2,
    y + uvy * w2 + uuvy * 2,
    z + uvz * w2 + uuvz * 2,
  ];
}

function applyTransform(
  x: number,
  y: number,
  z: number,
  transform: SerializedTransform,
): [number, number, number] {
  const scaledX = x * transform.scale[0];
  const scaledY = y * transform.scale[1];
  const scaledZ = z * transform.scale[2];
  const rotated = rotateByQuat(
    scaledX,
    scaledY,
    scaledZ,
    transform.rotation,
  );
  return [
    rotated[0] + transform.position[0],
    rotated[1] + transform.position[1],
    rotated[2] + transform.position[2],
  ];
}

function worldPoint(
  local: readonly [number, number, number],
  component: SerializedTransform,
  actor: SerializedTransform,
): [number, number, number] {
  const mid = applyTransform(local[0], local[1], local[2], component);
  return applyTransform(mid[0], mid[1], mid[2], actor);
}

const BOX_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [-0.5, -0.5, -0.5],
  [0.5, -0.5, -0.5],
  [0.5, 0.5, -0.5],
  [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5],
  [0.5, -0.5, 0.5],
  [0.5, 0.5, 0.5],
  [-0.5, 0.5, 0.5],
];

const BOX_FACES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 1, 2, 3],
  [4, 7, 6, 5],
  [0, 4, 5, 1],
  [3, 2, 6, 7],
  [0, 3, 7, 4],
  [1, 5, 6, 2],
];

function pushBoxTriangles(
  triangles: AudioReverbTriangle[],
  component: SerializedTransform,
  actor: SerializedTransform,
): void {
  const corners = BOX_CORNERS.map((corner) =>
    worldPoint(corner, component, actor),
  );
  for (const face of BOX_FACES) {
    const a = corners[face[0]]!;
    const b = corners[face[1]]!;
    const c = corners[face[2]]!;
    const d = corners[face[3]]!;
    triangles.push({
      ax: a[0],
      ay: a[1],
      az: a[2],
      bx: b[0],
      by: b[1],
      bz: b[2],
      cx: c[0],
      cy: c[1],
      cz: c[2],
    });
    triangles.push({
      ax: a[0],
      ay: a[1],
      az: a[2],
      bx: c[0],
      by: c[1],
      bz: c[2],
      cx: d[0],
      cy: d[1],
      cz: d[2],
    });
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

export async function collectStaticAudioGeometry(options: {
  actors: readonly SerializedActor[];
  yieldSlice?: () => Promise<void>;
}): Promise<AudioReverbGeometry> {
  const triangles: AudioReverbTriangle[] = [];
  let processed = 0;
  for (const actor of options.actors) {
    if (isDynamicRigidBody(actor)) continue;
    if (!hasMeshComponent(actor)) continue;
    const actorT = actorTransform(actor);
    for (const component of actor.components) {
      if (component.classId !== "MeshComponent") continue;
      pushBoxTriangles(triangles, componentTransform(component), actorT);
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
  const markRange = (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ) => {
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
          occupied[indexOf(ix, iy, iz)] = 1;
        }
      }
    }
  };
  for (const triangle of geometry.triangles) {
    markRange(
      Math.min(triangle.ax, triangle.bx, triangle.cx),
      Math.min(triangle.ay, triangle.by, triangle.cy),
      Math.min(triangle.az, triangle.bz, triangle.cz),
      Math.max(triangle.ax, triangle.bx, triangle.cx),
      Math.max(triangle.ay, triangle.by, triangle.cy),
      Math.max(triangle.az, triangle.bz, triangle.cz),
    );
  }
  return grid;
}

export function occupancyGridForAudioBake(
  geometry: AudioReverbGeometry,
): AudioReverbOccupancyGrid {
  const grid = buildOccupancy(geometry);
  return { sizeX: grid.sizeX, sizeY: grid.sizeY, sizeZ: grid.sizeZ };
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
  });
}

/** Inverse-distance blend of at most two nearest probes. */
export function interpolateAudioReverb(
  listener: { x: number; y: number; z: number },
  probes: readonly AudioReverbProbe[],
): number {
  if (probes.length === 0) return 0;
  if (probes.length === 1) return probes[0]!.wet;
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
  if (!first) return 0;
  if (!second || firstDist === 0) return first.wet;
  const w1 = 1 / firstDist;
  const w2 = 1 / secondDist;
  return (first.wet * w1 + second.wet * w2) / (w1 + w2);
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
