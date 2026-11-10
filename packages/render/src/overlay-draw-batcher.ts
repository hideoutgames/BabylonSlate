import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Material } from "@babylonjs/core/Materials/material";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { FloatArray, IndicesArray } from "@babylonjs/core/types";
import type { OverlayLayoutRect } from "@haptic/core";
import { sceneDrawBatcher, setSceneDrawBatcher, type SceneDrawBatcher } from "./draw-batching";
import { hasMeshLatticeDeformer } from "./lattice-deformer-binding";
import { disableOverlayClipScissor, enableOverlayClipScissor, overlayDrawClip } from "./overlay-layout-render";
import { overlayVisualStyle, shareOverlayVisualStyle } from "./overlay-visual-style";
import { hasStockOrPlannedVertexStage } from "./shadow-material-policy";
import { isUnlitMaterial } from "./unlit-material";
import { setUnlitBinding, unlitBinding, type UnlitBinding } from "./unlit-material-blocks";

/**
 * Draw batching for a Scene's sorted passes (Scene Layers): consecutive-in-effect draws of the unlit Material that bind
 * the same values draw as one, with output identical to drawing them one by one.
 *
 * - **Order.** A pass's list is drawn in Babylon's sorted order, except that a draw may join an earlier batch when it
 *   overlaps no draw between that batch and itself (projected bounds, with a margin of two pixels). Draws that cover
 *   no common pixel blend and depth-test the same in either order, so only non-overlapping draws move. A draw whose
 *   bounds cannot be trusted (skinning, morphs, a lattice, instances, a vertex stage that moves vertices) overlaps
 *   everything.
 * - **Values.** A batch's members draw the same Material and Effect and bind the same values: the unlit binding,
 *   visibility, overlay style, side orientation and clip (one scissor). The batch mesh binds them as its first member.
 * - **Vertices.** Members' vertices are written in the eye-relative world space the GPU computes (the floating
 *   origin's offset world matrix, rounded to 32 bits as uploaded), and the batch draws them with an offset world of
 *   zero, so each vertex's position is the same 32-bit value. Only members whose world matrix scales and translates
 *   (no rotation or mirroring) and whose products and sums are exact in 32 bits join; the rest draw on their own.
 * - **Readiness.** A batch draws only when every member's own draw would draw now (Babylon's readiness gate) and its
 *   mesh is ready with their Effect; otherwise its members draw one by one, each through its own gate.
 *
 * Batch meshes stay out of `scene.meshes` (never culled, picked, probed or counted) and keep their buffers between
 * frames. Each is used at most once per Engine frame (WebGPU queues buffer writes ahead of the frame's draws) and
 * uploads only when what it holds changed. Every cache compares contents, not array identity: owners rewrite vertex
 * arrays in place (sprite quads).
 */

/** Babylon 9.29 per-mesh render state `Mesh.render` resets for a drawn mesh. */
type ActiveFlags = { _isActiveIntermediate: boolean; _isActive: boolean };
type MeshInternals = {
  _internalAbstractMeshDataInfo: ActiveFlags;
  _userInstancedBuffersStorage?: unknown;
  _occlusionDataStorage?: { occlusionType: number } | null;
  renderOutline?: boolean;
  renderOverlay?: boolean;
};

/** A member's vertices in eye-relative world space, recomputed when its world matrix, positions or the eye change. */
interface Bake {
  flag: number;
  source: FloatArray;
  /** `source` as baked (32-bit): compared each frame, as an owner may rewrite the array in place. */
  copy: Float32Array;
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  /** Null when a vertex is not exact in 32 bits (or the matrix rotates): the mesh draws on its own. */
  positions: Float32Array | null;
  /** Bounds of `positions`, eye-relative. */
  min: [number, number, number];
  max: [number, number, number];
}

/** A draw of the pass: its submesh, what it binds when it may batch, and its projected bounds. */
interface Entry {
  subMesh: SubMesh;
  /** Set when the draw may join a batch. */
  mesh: Mesh | null;
  material: Material | null;
  binding: UnlitBinding | null;
  clip: OverlayLayoutRect | null;
  bake: Bake | null;
  uvs: FloatArray | null;
  indices: IndicesArray | null;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  batch: number;
}

/** A pass's batch: its draws in order, the union of their projected bounds and the previous batch of the same key. */
interface Batch {
  entries: Entry[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** The previous batch whose draws sample the same texture (or, untextured, draw the same Material); -1: none. */
  previousOfKey: number;
}

/** A batch mesh kept between frames, with what its buffers hold. */
interface Slot {
  mesh: Mesh;
  textured: boolean;
  vertexCapacity: number;
  indexCapacity: number;
  /** What the buffers hold (`vertexCount` and `indexCount` of them in use). */
  positions: Float32Array;
  uvs: Float32Array | null;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  indexCount: number;
}

const bakes = new WeakMap<Mesh, Bake>();

/**
 * Why a draw goes on its own: it is its pass's only draw, what it draws with or how it is posed cannot join a batch, or
 * no other draw of its pass draws the same.
 */
export type OverlayAloneReason = "single" | "material" | "transform" | "vertexColor" | "other" | "unmatched";
/**
 * Batched passes counted (`countOverlayBatches`): the draws asked for (`visuals`), the draws made, the batches among
 * them with the visuals they drew, and the visuals drawn on their own by reason: a pass's only draw, a Material other
 * than the unlit one (an authored 2D Material, a 3D-lit sprite), a rotated or mirrored pose (or one not exact in 32
 * bits), vertex colours, anything else a batch cannot reproduce, and batchable visuals no other draw matched (or whose
 * batch could not draw as one then). `visuals` is `batched` plus every `alone` count.
 */
export interface OverlayBatchStats {
  visuals: number;
  draws: number;
  batches: number;
  batched: number;
  alone: Record<OverlayAloneReason, number>;
}

export function emptyOverlayBatchStats(): OverlayBatchStats {
  return { visuals: 0, draws: 0, batches: 0, batched: 0, alone: { single: 0, material: 0, transform: 0, vertexColor: 0, other: 0, unmatched: 0 } };
}

/** Copies `from`'s counts into `to` (a new one when not given) and returns it. */
export function copyOverlayBatchStats(from: OverlayBatchStats, to: OverlayBatchStats = emptyOverlayBatchStats()): OverlayBatchStats {
  to.visuals = from.visuals; to.draws = from.draws; to.batches = from.batches; to.batched = from.batched;
  Object.assign(to.alone, from.alone);
  return to;
}

/** The counts being added to, and where passes drawn while nothing counts go (never read). */
let counting: OverlayBatchStats | undefined;
const uncounted = emptyOverlayBatchStats();

/**
 * Adds the batched passes drawn while `draw` runs to `stats`: a view counts its frame's Scene Layers this way
 * (`RenderDiagnostics.layerBatches`). Passes drawn outside any such call are not counted.
 */
export function countOverlayBatches<T>(stats: OverlayBatchStats, draw: () => T): T {
  const previous = counting;
  counting = stats;
  try {
    return draw();
  } finally {
    counting = previous;
  }
}

/** The float data of a tightly packed 32-bit float vertex buffer of `size` components, or null. */
function packedFloats(mesh: Mesh, kind: string, size: number): FloatArray | null {
  const buffer = mesh.getVertexBuffer(kind);
  if (!buffer || buffer.type !== VertexBuffer.FLOAT || buffer.normalized || buffer.getSize() !== size) return null;
  if (buffer.byteOffset !== 0 || buffer.byteStride !== size * 4 || buffer.getIsInstanced()) return null;
  const data = buffer.getData();
  return data instanceof Float32Array || Array.isArray(data) ? data : null;
}

/** `scale × value + offset` as the GPU computes it in 32 bits, or NaN when the product or sum would round there. */
function exactAffine(scale: number, value: number, offset: number): number {
  const product = scale * value;
  if (Math.fround(product) !== product) return Number.NaN;
  const sum = product + offset;
  if (sum - offset !== product || sum - product !== offset) return Number.NaN;
  return Math.fround(sum);
}

/**
 * The member's eye-relative vertices: the world matrix the floating origin uploads (translation minus the eye, then
 * 32-bit) applied as the vertex stage applies it. Exact only for a scale and translation: every other entry of the
 * upper 3 × 4 is zero and the diagonal positive (a mirrored member draws with flipped faces).
 */
function bakeOf(mesh: Mesh, eye: { x: number; y: number; z: number }): Bake | null {
  const source = packedFloats(mesh, VertexBuffer.PositionKind, 3);
  if (!source) return null;
  const world = mesh.getWorldMatrix();
  const cached = bakes.get(mesh);
  if (cached && cached.flag === world.updateFlag && cached.source === source && cached.eyeX === eye.x && cached.eyeY === eye.y &&
    cached.eyeZ === eye.z && holds(cached.copy, source))
    return cached;
  const bake: Bake = cached ?? {
    flag: 0, source, copy: new Float32Array(0), eyeX: 0, eyeY: 0, eyeZ: 0, positions: null, min: [0, 0, 0], max: [0, 0, 0],
  };
  bake.flag = world.updateFlag;
  bake.source = source;
  if (bake.copy.length !== source.length) bake.copy = new Float32Array(source.length);
  bake.copy.set(source);
  bake.eyeX = eye.x; bake.eyeY = eye.y; bake.eyeZ = eye.z;
  bake.positions = bakePositions(world, bake.copy, eye, bake);
  bakes.set(mesh, bake);
  return bake;
}

/** Whether `copy` holds `source`'s values as 32-bit floats. */
function holds(copy: Float32Array, source: FloatArray): boolean {
  const count = source.length;
  if (copy.length !== count) return false;
  for (let index = 0; index < count; index += 1) if (copy[index] !== Math.fround(source[index]!)) return false;
  return true;
}

function bakePositions(world: Matrix, source: Float32Array, eye: { x: number; y: number; z: number }, bake: Bake): Float32Array | null {
  const m = world.asArray();
  if (m[1] !== 0 || m[2] !== 0 || m[3] !== 0 || m[4] !== 0 || m[6] !== 0 || m[7] !== 0 || m[8] !== 0 || m[9] !== 0 || m[11] !== 0 || m[15] !== 1)
    return null;
  const sx = Math.fround(m[0]!), sy = Math.fround(m[5]!), sz = Math.fround(m[10]!);
  if (!(sx > 0 && sy > 0 && sz > 0)) return null;
  const tx = Math.fround(m[12]! - eye.x), ty = Math.fround(m[13]! - eye.y), tz = Math.fround(m[14]! - eye.z);
  const count = source.length - (source.length % 3);
  const positions = bake.positions?.length === count ? bake.positions : new Float32Array(count);
  const { min, max } = bake;
  min[0] = min[1] = min[2] = Number.POSITIVE_INFINITY;
  max[0] = max[1] = max[2] = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < count; index += 3) {
    const x = exactAffine(sx, source[index]!, tx), y = exactAffine(sy, source[index + 1]!, ty), z = exactAffine(sz, source[index + 2]!, tz);
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return null;
    positions[index] = x; positions[index + 1] = y; positions[index + 2] = z;
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }
  return positions;
}

function sameColor(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Whether two unlit bindings bind the same values (`bindUnlitUniforms`). */
function sameBinding(a: UnlitBinding, b: UnlitBinding): boolean {
  if (a === b) return true;
  if (a.texture !== b.texture || !sameColor(a.color, b.color) || a.alpha !== b.alpha || a.cutoff !== b.cutoff || a.blend !== b.blend ||
    a.textureAlpha !== b.textureAlpha || a.twoSided !== b.twoSided) return false;
  if (!a.msdf || !b.msdf) return !a.msdf && !b.msdf;
  return sameColor(a.msdf.strokeColor, b.msdf.strokeColor) && a.msdf.strokeWidth === b.msdf.strokeWidth;
}

/** Whether two clips scissor the same: their rectangles (each layout entry carries its own copy). */
function sameClip(a: OverlayLayoutRect | null, b: OverlayLayoutRect | null): boolean {
  if (a === b) return true;
  return !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Whether `a` and `b` (both batchable) bind and draw the same: one draw can draw both. */
function sameDraw(a: Entry, b: Entry): boolean {
  if (a.material !== b.material || !sameClip(a.clip, b.clip) || (a.uvs === null) !== (b.uvs === null)) return false;
  const meshA = a.mesh!, meshB = b.mesh!;
  if (meshA.visibility !== meshB.visibility || meshA.sideOrientation !== meshB.sideOrientation) return false;
  if (!sameBinding(a.binding!, b.binding!)) return false;
  const styleA = overlayVisualStyle(meshA), styleB = overlayVisualStyle(meshB);
  return styleA === styleB || (styleA.opacity === styleB.opacity && styleA.tint[0] === styleB.tint[0] && styleA.tint[1] === styleB.tint[1] &&
    styleA.tint[2] === styleB.tint[2] && styleA.tint[3] === styleB.tint[3]);
}

/** Whether `mesh`'s bounding box contains what it draws: no skinning, morphs, lattice, instances or moving vertex stage. */
function boundsHold(mesh: AbstractMesh, material: Material | null): boolean {
  if (!(mesh instanceof Mesh) || mesh.hasInstances || mesh.hasThinInstances || mesh.skeleton || mesh.morphTargetManager) return false;
  if (mesh.doNotSyncBoundingInfo || hasMeshLatticeDeformer(mesh)) return false;
  return !material || hasStockOrPlannedVertexStage(material);
}

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

function overlapsAny(bounds: Bounds, others: readonly Bounds[]): boolean {
  for (let index = 0; index < others.length; index += 1) if (overlaps(bounds, others[index]!)) return true;
  return false;
}

/** What batches of one draw share, to find them quickly: the texture they sample or, untextured, their Material. */
function drawKey(entry: Entry): object {
  return entry.binding!.texture ?? entry.material!;
}

/**
 * Draws a Scene's sorted passes in batches (see the module comment). One per Scene, from `setSceneDrawBatching`.
 */
class OverlayDrawBatcher implements SceneDrawBatcher {
  private readonly scene: Scene;
  private readonly entries: Entry[] = [];
  /** The pass's batches in draw order; reused objects, `batchCount` of them in use. */
  private readonly batches: Batch[] = [];
  private batchCount = 0;
  /** Per draw key, the pass's last batch of it. */
  private readonly lastOfKey = new Map<object, number>();
  private readonly slots: Slot[] = [];
  private slotCursor = 0;
  /** The Engine frame whose draws took the first `slotCursor` slots. */
  private cursorFrame = -1;
  private disposed = false;
  private readonly scratchCorner = { x: 0, y: 0, z: 0 };
  private readonly scratchViewport = new Viewport(0, 0, 1, 1);

  constructor(scene: Scene) {
    this.scene = scene;
  }

  draw(sorted: readonly SubMesh[], count: number, transparent: boolean, drawOne: (subMesh: SubMesh) => void): void {
    const scene = this.scene;
    if (this.disposed || scene.prePassRenderer) {
      for (let index = 0; index < count; index += 1) drawOne(sorted[index]!);
      return;
    }
    const stats = counting ?? uncounted;
    stats.visuals += count;
    if (count < 2) {
      stats.alone.single += count;
      stats.draws += count;
      for (let index = 0; index < count; index += 1) drawOne(sorted[index]!);
      return;
    }
    const entries = this.entries;
    const eye = scene.floatingOriginOffset;
    let candidates = 0;
    for (let index = 0; index < count; index += 1) {
      const entry = (entries[index] ??= {
        subMesh: sorted[index]!, mesh: null, material: null, binding: null, clip: null, bake: null, uvs: null, indices: null,
        minX: 0, minY: 0, maxX: 0, maxY: 0, batch: -1,
      });
      entry.subMesh = sorted[index]!;
      const alone = this.classify(entry, eye);
      if (alone) stats.alone[alone] += 1;
      else candidates += 1;
    }
    try {
      if (candidates < 2) {
        // A lone candidate has nothing to batch with.
        stats.alone.unmatched += candidates;
        stats.draws += count;
        for (let index = 0; index < count; index += 1) drawOne(sorted[index]!);
        return;
      }
      this.group(count, eye);
      this.drawBatches(transparent, drawOne, stats);
    } finally {
      for (let index = 0; index < count; index += 1) this.release(entries[index]!);
      for (let index = 0; index < this.batchCount; index += 1) this.batches[index]!.entries.length = 0;
      this.batchCount = 0;
      this.lastOfKey.clear();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) slot.mesh.dispose(false, false);
    this.slots.length = 0;
    this.entries.length = 0;
    this.batches.length = 0;
  }

  private release(entry: Entry): void {
    entry.mesh = null; entry.material = null; entry.binding = null; entry.clip = null; entry.bake = null; entry.uvs = null; entry.indices = null;
    entry.batch = -1;
  }

  /** Fills `entry` for a draw that may batch and returns null; otherwise why it draws on its own. */
  private classify(entry: Entry, eye: { x: number; y: number; z: number }): Exclude<OverlayAloneReason, "single" | "unmatched"> | null {
    const subMesh = entry.subMesh;
    const mesh = subMesh.getMesh();
    const material = subMesh.getMaterial();
    entry.mesh = null;
    if (!(mesh instanceof Mesh) || subMesh.getRenderingMesh() !== mesh) return "other";
    if (!material || !isUnlitMaterial(material)) return "material";
    if (material.needDepthPrePass || material.separateCullingPass) return "other";
    if (mesh.subMeshes.length !== 1 || !boundsHold(mesh, material)) return "other";
    const internals = mesh as unknown as MeshInternals;
    if (internals._userInstancedBuffersStorage || internals._occlusionDataStorage?.occlusionType || internals.renderOutline || internals.renderOverlay)
      return "other";
    if (mesh.ignoreCameraMaxZ || mesh.overrideRenderingFillMode !== null || mesh._instanceDataStorage.isFrozen) return "other";
    if (mesh.isVerticesDataPresent(VertexBuffer.ColorKind)) return "vertexColor";
    // Draw hooks: none but a clip's scissor, which the batch sets itself.
    const clip = overlayDrawClip(mesh);
    const hooks = clip === undefined ? 0 : 1;
    if (mesh.onBeforeRenderObservable.hasObservers() || mesh.onBeforeDrawObservable.hasObservers() ||
      mesh.onBeforeBindObservable.observers.length !== hooks || mesh.onAfterRenderObservable.observers.length !== hooks) return "other";
    const indices = mesh.getIndices(false, false);
    const vertices = mesh.getTotalVertices();
    if (!indices || subMesh.indexStart !== 0 || subMesh.indexCount !== indices.length || subMesh.verticesStart !== 0 || subMesh.verticesCount !== vertices)
      return "other";
    const uvs = mesh.isVerticesDataPresent(VertexBuffer.UVKind) ? packedFloats(mesh, VertexBuffer.UVKind, 2) : null;
    if (mesh.isVerticesDataPresent(VertexBuffer.UVKind) && !uvs) return "other";
    const bake = bakeOf(mesh, eye);
    // No baked positions: the pose rotates, mirrors or is not exact in 32 bits.
    if (!bake?.positions) return bake ? "transform" : "other";
    if (bake.positions.length !== vertices * 3 || (uvs && uvs.length < vertices * 2)) return "other";
    entry.mesh = mesh;
    entry.material = material;
    entry.binding = unlitBinding(mesh);
    entry.clip = clip ?? null;
    entry.bake = bake;
    entry.uvs = uvs;
    entry.indices = indices;
    return null;
  }

  /** Projected bounds of every draw, two of the viewport's pixels wider on each side; unbounded when not known. */
  private bound(entry: Entry, eye: { x: number; y: number; z: number }, transform: Matrix, marginX: number, marginY: number): void {
    entry.minX = entry.minY = Number.POSITIVE_INFINITY;
    entry.maxX = entry.maxY = Number.NEGATIVE_INFINITY;
    const mesh = entry.subMesh.getMesh();
    let min: readonly number[], max: readonly number[];
    let offsetX = 0, offsetY = 0, offsetZ = 0;
    if (entry.bake) {
      ({ min, max } = entry.bake);
      offsetX = eye.x; offsetY = eye.y; offsetZ = eye.z;
    } else if (boundsHold(mesh, entry.subMesh.getMaterial())) {
      const box = entry.subMesh.getBoundingInfo().boundingBox;
      min = box.minimumWorld.asArray(); max = box.maximumWorld.asArray();
    } else {
      unbounded(entry);
      return;
    }
    const m = transform.asArray();
    const corner = this.scratchCorner;
    for (let index = 0; index < 8; index += 1) {
      corner.x = (index & 1 ? max[0]! : min[0]!) + offsetX;
      corner.y = (index & 2 ? max[1]! : min[1]!) + offsetY;
      corner.z = (index & 4 ? max[2]! : min[2]!) + offsetZ;
      const w = corner.x * m[3]! + corner.y * m[7]! + corner.z * m[11]! + m[15]!;
      if (!(w > 0)) {
        unbounded(entry);
        return;
      }
      const x = (corner.x * m[0]! + corner.y * m[4]! + corner.z * m[8]! + m[12]!) / w;
      const y = (corner.x * m[1]! + corner.y * m[5]! + corner.z * m[9]! + m[13]!) / w;
      if (x < entry.minX) entry.minX = x;
      if (x > entry.maxX) entry.maxX = x;
      if (y < entry.minY) entry.minY = y;
      if (y > entry.maxY) entry.maxY = y;
    }
    // A non-finite corner (or none) leaves bounds that would overlap nothing.
    if (!(entry.minX <= entry.maxX && entry.minY <= entry.maxY)) {
      unbounded(entry);
      return;
    }
    entry.minX -= marginX; entry.maxX += marginX;
    entry.minY -= marginY; entry.maxY += marginY;
  }

  /**
   * Puts each draw in the first batch it can join: one of the same draw at or after the last batch holding a draw it
   * overlaps (so it still draws after every draw it covers), else a new batch at the end.
   */
  private group(count: number, eye: { x: number; y: number; z: number }): void {
    const scene = this.scene, engine = scene.getEngine();
    const transform = scene.getTransformMatrix();
    const width = engine.getRenderWidth(), height = engine.getRenderHeight();
    // The camera's viewport in pixels (`toGlobalToRef` fills the ref but returns the camera's normalised viewport).
    const viewport = this.scratchViewport;
    if (scene.activeCamera) scene.activeCamera.viewport.toGlobalToRef(width, height, viewport);
    else { viewport.width = width; viewport.height = height; }
    // NDC spans 2 across the camera's viewport: two of its pixels.
    const marginX = 4 / Math.max(1, viewport.width), marginY = 4 / Math.max(1, viewport.height);
    const entries = this.entries, batches = this.batches, lastOfKey = this.lastOfKey;
    let used = 0;
    for (let index = 0; index < count; index += 1) {
      const entry = entries[index]!;
      this.bound(entry, eye, transform, marginX, marginY);
      let last = used - 1;
      for (; last >= 0; last -= 1) {
        const batch = batches[last]!;
        if (overlaps(entry, batch) && overlapsAny(entry, batch.entries)) break;
      }
      let target = -1;
      const key = entry.mesh ? drawKey(entry) : null;
      if (key) {
        // The earliest batch of the same draw at or after `last`.
        const floor = Math.max(last, 0);
        for (let candidate = lastOfKey.get(key) ?? -1; candidate >= floor; candidate = batches[candidate]!.previousOfKey)
          if (sameDraw(batches[candidate]!.entries[0]!, entry)) target = candidate;
      }
      if (target < 0) {
        target = used++;
        const batch = (batches[target] ??= { entries: [], minX: 0, minY: 0, maxX: 0, maxY: 0, previousOfKey: -1 });
        batch.minX = batch.minY = Number.POSITIVE_INFINITY;
        batch.maxX = batch.maxY = Number.NEGATIVE_INFINITY;
        batch.previousOfKey = key ? lastOfKey.get(key) ?? -1 : -1;
        if (key) lastOfKey.set(key, target);
      }
      const batch = batches[target]!;
      batch.entries.push(entry);
      if (entry.minX < batch.minX) batch.minX = entry.minX;
      if (entry.minY < batch.minY) batch.minY = entry.minY;
      if (entry.maxX > batch.maxX) batch.maxX = entry.maxX;
      if (entry.maxY > batch.maxY) batch.maxY = entry.maxY;
      entry.batch = target;
    }
    this.batchCount = used;
  }

  private drawBatches(transparent: boolean, drawOne: (subMesh: SubMesh) => void, stats: OverlayBatchStats): void {
    for (let index = 0; index < this.batchCount; index += 1) {
      const members = this.batches[index]!.entries;
      // A member whose own draw would not draw now (Babylon's readiness gate) leaves its batch's members to their own.
      if (members.length > 1 && members.every(drawsNow) && this.drawBatch(members, transparent)) {
        stats.draws += 1;
        stats.batches += 1;
        stats.batched += members.length;
        continue;
      }
      stats.draws += members.length;
      // A candidate nothing matched, or whose batch could not draw as one now; the others were counted as classified.
      for (const entry of members) if (entry.mesh) stats.alone.unmatched += 1;
      for (const entry of members) drawOne(entry.subMesh);
    }
  }

  /** Draws `members` as one batch; false (nothing drawn) when its mesh is not ready with their Effect. */
  private drawBatch(members: readonly Entry[], transparent: boolean): boolean {
    const scene = this.scene;
    const first = members[0]!;
    const member = first.mesh!;
    const slot = this.slotFor(first.uvs !== null);
    const mesh = slot.mesh;
    if (mesh.material !== first.material) mesh.material = first.material;
    setUnlitBinding(mesh, first.binding!);
    shareOverlayVisualStyle(mesh, member);
    mesh.visibility = member.visibility;
    mesh.sideOrientation = member.sideOrientation;
    // A translation by the eye, which the floating origin uploads as zero: the baked vertices are already eye-relative.
    const eye = scene.floatingOriginOffset;
    if (!mesh.position.equals(eye)) mesh.position.copyFrom(eye);
    const world = mesh.computeWorldMatrix(true).asArray();
    if (world[12] !== eye.x || world[13] !== eye.y || world[14] !== eye.z) return false;
    this.fill(slot, members);
    const subMesh = mesh.subMeshes[0]!;
    if (!first.material!.isReadyForSubMesh(mesh, subMesh, false)) return false;
    const effect = subMesh.effect;
    if (!effect) return false;
    for (const entry of members) if (entry.subMesh.effect !== effect) return false;
    const engine = scene.getEngine();
    const scissored = first.clip !== null && enableOverlayClipScissor(scene, first.clip);
    try {
      mesh.render(subMesh, transparent, mesh);
    } finally {
      if (scissored) disableOverlayClipScissor(engine);
    }
    // As each member's own render would have.
    for (const entry of members) {
      const flags = (entry.mesh as unknown as MeshInternals)._internalAbstractMeshDataInfo;
      if (flags._isActiveIntermediate) flags._isActiveIntermediate = false;
      else flags._isActive = false;
    }
    return true;
  }

  /**
   * The next batch mesh of this Engine frame, created (out of the Scene's lists) when the pool runs out. A batch mesh
   * draws once per Engine frame: WebGPU writes buffers ahead of the frame's draws, so a second write would show in both.
   */
  private slotFor(textured: boolean): Slot {
    const frame = this.scene.getEngine().frameId;
    if (frame !== this.cursorFrame) {
      this.cursorFrame = frame;
      this.slotCursor = 0;
    }
    let slot = this.slots[this.slotCursor];
    if (!slot) {
      const scene = this.scene;
      const blocked = scene._blockEntityCollection;
      scene._blockEntityCollection = true;
      let mesh: Mesh;
      try {
        mesh = new Mesh(`drawBatch:${this.slots.length}`, scene);
      } finally {
        scene._blockEntityCollection = blocked;
      }
      mesh.isPickable = false;
      mesh.isVisible = false;
      mesh.doNotSyncBoundingInfo = true;
      slot = {
        mesh, textured, vertexCapacity: 0, indexCapacity: 0, positions: new Float32Array(0), uvs: null, indices: new Uint16Array(0),
        vertexCount: 0, indexCount: 0,
      };
      this.slots.push(slot);
    }
    this.slotCursor += 1;
    if (slot.textured !== textured) {
      // Rebuilt with or without UVs at the next fill.
      slot.textured = textured;
      slot.vertexCapacity = 0;
    }
    return slot;
  }

  /** Writes the members' vertices, UVs and indices into the slot's buffers, uploading only what changed. */
  private fill(slot: Slot, members: readonly Entry[]): void {
    let vertexCount = 0, indexCount = 0;
    for (const entry of members) {
      vertexCount += entry.bake!.positions!.length / 3;
      indexCount += entry.indices!.length;
    }
    const mesh = slot.mesh;
    const grow = vertexCount > slot.vertexCapacity || indexCount > slot.indexCapacity;
    if (grow) {
      slot.vertexCapacity = Math.max(64, 2 ** Math.ceil(Math.log2(vertexCount)));
      slot.indexCapacity = Math.max(96, 2 ** Math.ceil(Math.log2(indexCount)));
      slot.positions = new Float32Array(slot.vertexCapacity * 3);
      slot.uvs = slot.textured ? new Float32Array(slot.vertexCapacity * 2) : null;
      slot.indices = slot.vertexCapacity > 65536 ? new Uint32Array(slot.indexCapacity) : new Uint16Array(slot.indexCapacity);
    }
    const { positions, uvs, indices } = slot;
    let changed = grow || vertexCount !== slot.vertexCount || indexCount !== slot.indexCount;
    let vertex = 0, index = 0;
    for (const entry of members) {
      const baked = entry.bake!.positions!;
      const memberVertices = baked.length / 3;
      for (let offset = 0, at = vertex * 3; offset < baked.length; offset += 1, at += 1) {
        const value = baked[offset]!;
        if (positions[at] !== value) { positions[at] = value; changed = true; }
      }
      if (uvs) {
        const source = entry.uvs!;
        for (let offset = 0, at = vertex * 2; offset < memberVertices * 2; offset += 1, at += 1) {
          const value = Math.fround(source[offset]!);
          if (uvs[at] !== value) { uvs[at] = value; changed = true; }
        }
      }
      const source = entry.indices!;
      for (let offset = 0, at = index; offset < source.length; offset += 1, at += 1) {
        const value = source[offset]! + vertex;
        if (indices[at] !== value) { indices[at] = value; changed = true; }
      }
      vertex += memberVertices;
      index += source.length;
    }
    slot.vertexCount = vertex;
    slot.indexCount = index;
    if (!changed) return;
    if (grow) {
      const blocked = mesh.getScene()._blockEntityCollection;
      mesh.getScene()._blockEntityCollection = true;
      try {
        mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
        if (uvs) mesh.setVerticesData(VertexBuffer.UVKind, uvs, true);
        else if (mesh.isVerticesDataPresent(VertexBuffer.UVKind)) mesh.removeVerticesData(VertexBuffer.UVKind);
        mesh.setIndices(indices, slot.vertexCapacity, true);
      } finally {
        mesh.getScene()._blockEntityCollection = blocked;
      }
    } else {
      // In place: the buffers (and their vertex array objects) stay. Whole arrays, which the buffers keep for a rebuild.
      mesh.getVertexBuffer(VertexBuffer.PositionKind)!.updateDirectly(positions, 0);
      if (uvs) mesh.getVertexBuffer(VertexBuffer.UVKind)!.updateDirectly(uvs, 0);
      mesh.updateIndices(indices, 0, true);
    }
    const subMesh = mesh.subMeshes[0]!;
    subMesh.verticesStart = 0;
    subMesh.verticesCount = vertex;
    subMesh.indexStart = 0;
    subMesh.indexCount = index;
  }
}

function unbounded(entry: Bounds): void {
  entry.minX = entry.minY = Number.NEGATIVE_INFINITY;
  entry.maxX = entry.maxY = Number.POSITIVE_INFINITY;
}

/** Babylon's gate in `Mesh.render` for a regular mesh: it draws itself now, with its Material ready for the submesh. */
function drawsNow(entry: Entry): boolean {
  const mesh = entry.mesh!;
  const instances = mesh._getInstancesRenderList(entry.subMesh._id, false);
  if (instances.mustReturn || !instances.renderSelf[entry.subMesh._id] || instances.hardwareInstancedRendering[entry.subMesh._id]) return false;
  return entry.material!.isReadyForSubMesh(mesh, entry.subMesh, false);
}

/**
 * Turns draw batching on or off for `scene`'s sorted passes (Scene Layers turn it on). The batcher and its batch
 * meshes are disposed with the Scene.
 */
export function setSceneDrawBatching(scene: Scene, enabled: boolean): void {
  if (!enabled) {
    setSceneDrawBatcher(scene, null);
    return;
  }
  if (sceneDrawBatcher(scene)) return;
  setSceneDrawBatcher(scene, new OverlayDrawBatcher(scene));
  scene.onDisposeObservable.addOnce(() => setSceneDrawBatcher(scene, null));
}
