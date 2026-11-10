import { Buffer, VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { Material } from "@babylonjs/core/Materials/material";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { FloatArray, IndicesArray } from "@babylonjs/core/types";
import type { OverlayLayoutRect } from "@haptic/core";
import {
  DRAW_BATCH_COLOR_KIND, DRAW_BATCH_TEXT_KINDS, DRAW_BATCH_TINT_KIND, DRAW_BATCH_WORLD_KINDS, isBoundedMaterial, isDrawBatchMaterial,
  isDrawBatchTextMaterial, markDrawBatchMesh,
} from "./draw-batch-world-block";
import { sceneDrawBatcher, setSceneDrawBatcher, type SceneDrawBatcher } from "./draw-batching";
import { hasMeshLatticeDeformer } from "./lattice-deformer-binding";
import { disableOverlayClipScissor, enableOverlayClipScissor, overlayDrawClip } from "./overlay-layout-render";
import { overlayVisualStyle, shareOverlayVisualStyle } from "./overlay-visual-style";
import { hasStockOrPlannedVertexStage } from "./shadow-material-policy";
import { bindTextMaterialGlyph, textMaterialGlyphBinding, type TextMaterialBinding } from "./text-material-block";
import { isUnlitMaterial } from "./unlit-material";
import { setUnlitBinding, unlitBinding, type UnlitBinding } from "./unlit-material-blocks";

/**
 * Draw batching for a Scene's sorted passes (Scene Layers): consecutive-in-effect draws of the unlit Material, or of an
 * authored Scene Layer Material the compiler marked (`markDrawBatchMaterial`), that bind the same values draw as one,
 * with output identical to drawing them one by one.
 *
 * - **Order.** A pass's list is drawn in Babylon's sorted order, except that a draw may join an earlier batch when it
 *   overlaps no draw between that batch and itself (projected bounds, with a margin of two pixels). Draws that cover
 *   no common pixel blend and depth-test the same in either order, so only non-overlapping draws move. A draw whose
 *   bounds cannot be trusted (skinning, morphs, a lattice, instances, a vertex stage that moves vertices) overlaps
 *   everything.
 * - **Values.** A batch's members draw the same Material and Effect and bind the same values: the unlit binding's
 *   texture and alpha rules, visibility, side orientation and clip (one scissor), which the batch mesh binds as its
 *   first member. Each member's own colour, alpha and overlay tint go with its vertices (`drawBatchValue`), so members
 *   that differ in those alone still share a draw. An authored Material's members share Receive Shadows, the one
 *   other value its lighting binds per mesh, and the batch carries their normals, tangents and second UVs too.
 * - **Vertices.** A batch holds its members' own vertices and, for each vertex, the rows of its member's world
 *   matrix as the member's draw uploads them (the floating origin's translation minus the eye, then 32-bit). The
 *   Material's vertex stage builds the world matrix from those for a batch's mesh (`DrawBatchWorldBlock`), so every
 *   vertex is transformed by the same expression on the same values as in its member's draw, whatever its pose. A
 *   mirrored member, whose faces Babylon draws the other way round, draws on its own.
 * - **Readiness.** A batch draws only when every member's own draw would draw now (Babylon's readiness gate) and its
 *   mesh is ready with their program's batch variant (the same defines and `HAPTIC_BATCH`); otherwise its members draw
 *   one by one, each through its own gate.
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

/** A member's own vertices and its world matrix as its draw uploads it, kept while neither changes. */
interface Bake {
  flag: number;
  source: FloatArray;
  /** `source` in 32 bits, as its vertex buffer holds it: compared each frame, as an owner may rewrite the array in place. */
  copy: Float32Array;
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  /** Storage for `world`. */
  rows: Float32Array;
  /**
   * The world matrix's first three rows as the member's draw uploads them; null when it mirrors or is not affine: the
   * mesh draws on its own.
   */
  world: Float32Array | null;
  /** Bounds of `copy`, in the member's own space. */
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
  /** A text Material's glyph: what it binds for itself. */
  text: TextMaterialBinding | null;
  clip: OverlayLayoutRect | null;
  bake: Bake | null;
  /** The member's vertex data of each of `EXTRA_KINDS` the batch carries, and which those are, as bits. */
  extras: Array<FloatArray | null>;
  layout: number;
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
  /** Which of `EXTRA_KINDS` its buffers hold, as bits. */
  layout: number;
  vertexCapacity: number;
  indexCapacity: number;
  /** What the buffers hold (`vertexCount` and `indexCount` of them in use). */
  positions: Float32Array;
  extras: Array<Float32Array | null>;
  /** Each vertex's world matrix, three rows of four floats, in `worldBuffer` (the `DRAW_BATCH_WORLD_KINDS` attributes). */
  worlds: Float32Array;
  worldBuffer: Buffer | null;
  /** Each vertex's colour with alpha, then its tint: eight floats, in `styleBuffer` (the two style attributes). */
  styles: Float32Array;
  styleBuffer: Buffer | null;
  /** A batch of glyphs: each vertex's atlas rectangle, Material rectangle, and colour with visibility (`textBuffer`). */
  texts: Float32Array;
  textBuffer: Buffer | null;
  indices: Uint16Array | Uint32Array;
  vertexCount: number;
  indexCount: number;
  /** The members' Effect and the batch's last found to differ by the batch's define alone. */
  memberEffect: Effect | null;
  batchEffect: Effect | null;
}

const bakes = new WeakMap<Mesh, Bake>();

/**
 * Why a draw goes on its own: it is its pass's only draw, what it draws with or how it is posed cannot join a batch, or
 * no other draw of its pass draws the same.
 */
export type OverlayAloneReason = "single" | "material" | "transform" | "vertexColor" | "other" | "unmatched";
/**
 * Batched passes counted (`countOverlayBatches`): the draws asked for (`visuals`), the draws made, the batches among
 * them with the visuals they drew, and the visuals drawn on their own by reason: a pass's only draw, a Material no
 * batch draws (a 3D-lit sprite, an authored one the compiler did not mark), a mirrored pose (or one that is not affine), vertex
 * colours, anything else a batch cannot reproduce, and batchable visuals no other draw matched (or whose batch could
 * not draw as one then). `visuals` is `batched` plus every `alone` count.
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

/**
 * The member's vertices and world matrix as its own draw gives them to the vertex stage: the positions its vertex buffer
 * holds, and the world matrix the floating origin uploads (translation minus the eye, then 32-bit).
 */
function bakeOf(mesh: Mesh, eye: { x: number; y: number; z: number }): Bake | null {
  const source = packedFloats(mesh, VertexBuffer.PositionKind, 3);
  if (!source) return null;
  let bake = bakes.get(mesh);
  if (!bake)
    bakes.set(mesh, (bake = {
      flag: -1, source, copy: new Float32Array(0), eyeX: Number.NaN, eyeY: Number.NaN, eyeZ: Number.NaN, rows: new Float32Array(WORLD_FLOATS), world: null,
      min: [0, 0, 0], max: [0, 0, 0],
    }));
  if (bake.source !== source || !holds(bake.copy, source)) {
    bake.source = source;
    if (bake.copy.length !== source.length) bake.copy = new Float32Array(source.length);
    bake.copy.set(source);
    boundPositions(bake);
  }
  const world = mesh.getWorldMatrix();
  if (bake.flag !== world.updateFlag || bake.eyeX !== eye.x || bake.eyeY !== eye.y || bake.eyeZ !== eye.z) {
    bake.flag = world.updateFlag;
    bake.eyeX = eye.x; bake.eyeY = eye.y; bake.eyeZ = eye.z;
    bake.world = worldRows(world, eye, bake.rows);
  }
  return bake;
}

/** Whether `copy` holds `source`'s values as 32-bit floats. */
function holds(copy: Float32Array, source: FloatArray): boolean {
  const count = source.length;
  if (copy.length !== count) return false;
  for (let index = 0; index < count; index += 1) if (copy[index] !== Math.fround(source[index]!)) return false;
  return true;
}

function boundPositions(bake: Bake): void {
  const { copy, min, max } = bake;
  min[0] = min[1] = min[2] = Number.POSITIVE_INFINITY;
  max[0] = max[1] = max[2] = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 2 < copy.length; index += 3) {
    const x = copy[index]!, y = copy[index + 1]!, z = copy[index + 2]!;
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }
}

/** Floats of a world matrix a batch carries per vertex: three rows. */
const WORLD_FLOATS = 12;
/** Floats of a member's own values a batch carries per vertex: its colour with alpha, then its tint. */
const STYLE_FLOATS = 8;
/**
 * The vertex data a batch carries besides positions, where its members have it: UVs for any Material, and for an
 * authored one, whose graph may read them, normals, tangents and second UVs.
 */
const EXTRA_KINDS = [VertexBuffer.UVKind, VertexBuffer.NormalKind, VertexBuffer.TangentKind, VertexBuffer.UV2Kind] as const;
const EXTRA_SIZES = [2, 3, 4, 2] as const;
/** The layout bit of a batch of a text Material's glyphs, which carries `DRAW_BATCH_TEXT_KINDS` too. */
const TEXT_LAYOUT = 1 << EXTRA_KINDS.length;
/** Floats of a glyph's own values a batch carries per vertex. */
const TEXT_FLOATS = DRAW_BATCH_TEXT_KINDS.length * 4;
/** The vertex buffers WebGPU guarantees a draw. */
const WEBGPU_VERTEX_BUFFERS = 8;

/**
 * The vertex buffers a batch of `layout` binds: positions, each extra kind, the three world rows, and the tint (with
 * the colour for the unlit Material).
 */
function vertexBuffers(layout: number, unlit: boolean): number {
  let extras = 0;
  for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1) if (layout & (1 << kind)) extras += 1;
  return 1 + extras + DRAW_BATCH_WORLD_KINDS.length + (unlit ? 2 : 1) + (layout & TEXT_LAYOUT ? DRAW_BATCH_TEXT_KINDS.length : 0);
}

/**
 * The first three rows of `world` as a draw uploads it (`OffsetWorldToRef`, then 32 bits), into `rows`; null for a
 * matrix that is not affine or that mirrors: Babylon draws a mesh of negative determinant with its faces the other
 * way round.
 */
function worldRows(world: Matrix, eye: { x: number; y: number; z: number }, rows: Float32Array): Float32Array | null {
  const m = world.asArray();
  if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1 || world.determinant() < 0) return null;
  for (let row = 0; row < 3; row += 1) {
    rows[row * 4] = m[row]!;
    rows[row * 4 + 1] = m[row + 4]!;
    rows[row * 4 + 2] = m[row + 8]!;
  }
  rows[3] = m[12]! - eye.x;
  rows[7] = m[13]! - eye.y;
  rows[11] = m[14]! - eye.z;
  return rows;
}

function sameColor(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Whether two unlit bindings bind the same values (`bindUnlitUniforms`) but for the colour and alpha, which a batch
 * carries per vertex.
 */
function sameBinding(a: UnlitBinding, b: UnlitBinding): boolean {
  if (a === b) return true;
  if (a.texture !== b.texture || a.cutoff !== b.cutoff || a.blend !== b.blend || a.textureAlpha !== b.textureAlpha || a.twoSided !== b.twoSided)
    return false;
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
  if (a.material !== b.material || !sameClip(a.clip, b.clip) || a.layout !== b.layout) return false;
  const meshA = a.mesh!, meshB = b.mesh!;
  if (meshA.sideOrientation !== meshB.sideOrientation) return false;
  // A glyph's visibility goes with its vertices; what its text binds once for a draw is its atlas, mode and outline.
  if (a.text && b.text) {
    if (a.text.atlas !== b.text.atlas || a.text.mode !== b.text.mode || a.text.outline !== b.text.outline ||
      !sameColor(a.text.outlineColor, b.text.outlineColor)) return false;
  } else if (meshA.visibility !== meshB.visibility) return false;
  // What else a draw binds per mesh: the unlit binding, or an authored Material's lighting term, Receive Shadows.
  if (a.binding && b.binding) return sameBinding(a.binding, b.binding);
  return meshA.receiveShadows === meshB.receiveShadows;
}

/** Whether `mesh`'s bounding box contains what it draws: no skinning, morphs, lattice, instances or moving vertex stage. */
function boundsHold(mesh: AbstractMesh, material: Material | null): boolean {
  if (!(mesh instanceof Mesh) || mesh.hasInstances || mesh.hasThinInstances || mesh.skeleton || mesh.morphTargetManager) return false;
  if (mesh.doNotSyncBoundingInfo || hasMeshLatticeDeformer(mesh)) return false;
  return !material || isBoundedMaterial(material) || hasStockOrPlannedVertexStage(material);
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
  return entry.binding?.texture ?? entry.text?.atlas ?? entry.material!;
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
  private readonly scratchStyle = new Float32Array(STYLE_FLOATS);
  private readonly scratchGlyph = new Float32Array(TEXT_FLOATS);
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
        subMesh: sorted[index]!, mesh: null, material: null, binding: null, text: null, clip: null, bake: null, extras: EXTRA_KINDS.map(() => null), layout: 0, indices: null,
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
      this.group(count);
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
    for (const slot of this.slots) {
      slot.mesh.dispose(false, false);
      slot.worldBuffer?.dispose();
      slot.styleBuffer?.dispose();
      slot.textBuffer?.dispose();
    }
    this.slots.length = 0;
    this.entries.length = 0;
    this.batches.length = 0;
  }

  private release(entry: Entry): void {
    entry.mesh = null; entry.material = null; entry.binding = null; entry.text = null; entry.clip = null; entry.bake = null; entry.indices = null;
    entry.extras.fill(null);
    entry.layout = 0;
    entry.batch = -1;
  }

  /** Fills `entry` for a draw that may batch and returns null; otherwise why it draws on its own. */
  private classify(entry: Entry, eye: { x: number; y: number; z: number }): Exclude<OverlayAloneReason, "single" | "unmatched"> | null {
    const subMesh = entry.subMesh;
    const mesh = subMesh.getMesh();
    const material = subMesh.getMaterial();
    entry.mesh = null;
    if (!(mesh instanceof Mesh) || subMesh.getRenderingMesh() !== mesh) return "other";
    // The unlit Material, or an authored one a batch draws as each of its members would (`markDrawBatchMaterial`).
    const unlit = isUnlitMaterial(material);
    if (!material || !(unlit || isDrawBatchMaterial(material))) return "material";
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
    let layout = 0;
    for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1) {
      // The unlit graph reads UVs alone.
      if ((unlit && kind > 0) || !mesh.isVerticesDataPresent(EXTRA_KINDS[kind]!)) continue;
      const data = packedFloats(mesh, EXTRA_KINDS[kind]!, EXTRA_SIZES[kind]!);
      if (!data || data.length < vertices * EXTRA_SIZES[kind]!) return "other";
      entry.extras[kind] = data;
      layout |= 1 << kind;
    }
    // A text Material draws glyphs, each with a binding of its own, which a batch of them carries.
    const text = !unlit && isDrawBatchTextMaterial(material) ? textMaterialGlyphBinding(mesh) ?? null : null;
    if (!unlit && !text && isDrawBatchTextMaterial(material)) return "other";
    if (text) layout |= TEXT_LAYOUT;
    if (vertexBuffers(layout, unlit) > WEBGPU_VERTEX_BUFFERS && mesh.getEngine().isWebGPU) return "other";
    const bake = bakeOf(mesh, eye);
    if (!bake) return "other";
    // A pose that mirrors, or is not affine.
    if (!bake.world) return "transform";
    if (bake.copy.length !== vertices * 3) return "other";
    entry.mesh = mesh;
    entry.material = material;
    entry.binding = unlit ? unlitBinding(mesh) : null;
    entry.text = text;
    entry.clip = clip ?? null;
    entry.bake = bake;
    entry.layout = layout;
    entry.indices = indices;
    return null;
  }

  /** Projected bounds of every draw, two of the viewport's pixels wider on each side; unbounded when not known. */
  private bound(entry: Entry, transform: Matrix, marginX: number, marginY: number): void {
    entry.minX = entry.minY = Number.POSITIVE_INFINITY;
    entry.maxX = entry.maxY = Number.NEGATIVE_INFINITY;
    const mesh = entry.subMesh.getMesh();
    let min: readonly number[], max: readonly number[];
    // A batchable draw's own box, posed: tighter than its world box when it is turned.
    let world: ArrayLike<number> | null = null;
    if (entry.bake) {
      ({ min, max } = entry.bake);
      world = mesh.getWorldMatrix().asArray();
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
      const x = index & 1 ? max[0]! : min[0]!, y = index & 2 ? max[1]! : min[1]!, z = index & 4 ? max[2]! : min[2]!;
      if (world) {
        corner.x = x * world[0]! + y * world[4]! + z * world[8]! + world[12]!;
        corner.y = x * world[1]! + y * world[5]! + z * world[9]! + world[13]!;
        corner.z = x * world[2]! + y * world[6]! + z * world[10]! + world[14]!;
      } else {
        corner.x = x; corner.y = y; corner.z = z;
      }
      const w = corner.x * m[3]! + corner.y * m[7]! + corner.z * m[11]! + m[15]!;
      if (!(w > 0)) {
        unbounded(entry);
        return;
      }
      const projectedX = (corner.x * m[0]! + corner.y * m[4]! + corner.z * m[8]! + m[12]!) / w;
      const projectedY = (corner.x * m[1]! + corner.y * m[5]! + corner.z * m[9]! + m[13]!) / w;
      if (projectedX < entry.minX) entry.minX = projectedX;
      if (projectedX > entry.maxX) entry.maxX = projectedX;
      if (projectedY < entry.minY) entry.minY = projectedY;
      if (projectedY > entry.maxY) entry.maxY = projectedY;
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
  private group(count: number): void {
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
      this.bound(entry, transform, marginX, marginY);
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

  /** Draws `members` as one batch; false (nothing drawn) when its mesh is not ready with their program's batch variant. */
  private drawBatch(members: readonly Entry[], transparent: boolean): boolean {
    const scene = this.scene;
    const first = members[0]!;
    const member = first.mesh!;
    const slot = this.slotFor(first.layout);
    const mesh = slot.mesh;
    if (mesh.material !== first.material) mesh.material = first.material;
    if (first.binding) setUnlitBinding(mesh, first.binding);
    else {
      if (first.text) bindTextMaterialGlyph(mesh, first.text);
      mesh.receiveShadows = member.receiveShadows;
    }
    shareOverlayVisualStyle(mesh, member);
    mesh.visibility = member.visibility;
    mesh.sideOrientation = member.sideOrientation;
    this.fill(slot, members);
    const subMesh = mesh.subMeshes[0]!;
    if (!first.material!.isReadyForSubMesh(mesh, subMesh, false)) return false;
    const effect = subMesh.effect;
    if (!effect || !sameProgram(slot, effect, members)) return false;
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
  private slotFor(layout: number): Slot {
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
      // At the identity for good: every vertex carries its member's world matrix.
      mesh.freezeWorldMatrix();
      markDrawBatchMesh(mesh);
      slot = {
        mesh, layout, vertexCapacity: 0, indexCapacity: 0, positions: new Float32Array(0), extras: EXTRA_KINDS.map(() => null), worlds: new Float32Array(0),
        worldBuffer: null, styles: new Float32Array(0), styleBuffer: null, texts: new Float32Array(0), textBuffer: null, indices: new Uint16Array(0), vertexCount: 0, indexCount: 0, memberEffect: null, batchEffect: null,
      };
      this.slots.push(slot);
    }
    this.slotCursor += 1;
    if (slot.layout !== layout) {
      // Rebuilt with this layout's vertex data at the next fill.
      slot.layout = layout;
      slot.vertexCapacity = 0;
    }
    return slot;
  }

  /**
   * Writes the members' vertices, world matrices, colours and tints, UVs and indices into the slot's buffers, uploading
   * only the buffers whose contents changed: a member that moves uploads the world matrices alone, a tint the styles.
   */
  private fill(slot: Slot, members: readonly Entry[]): void {
    let vertexCount = 0, indexCount = 0;
    for (const entry of members) {
      vertexCount += entry.bake!.copy.length / 3;
      indexCount += entry.indices!.length;
    }
    const mesh = slot.mesh;
    const grow = vertexCount > slot.vertexCapacity || indexCount > slot.indexCapacity;
    if (grow) {
      slot.vertexCapacity = Math.max(64, 2 ** Math.ceil(Math.log2(vertexCount)));
      slot.indexCapacity = Math.max(96, 2 ** Math.ceil(Math.log2(indexCount)));
      slot.positions = new Float32Array(slot.vertexCapacity * 3);
      for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1)
        slot.extras[kind] = slot.layout & (1 << kind) ? new Float32Array(slot.vertexCapacity * EXTRA_SIZES[kind]!) : null;
      slot.worlds = new Float32Array(slot.vertexCapacity * WORLD_FLOATS);
      slot.styles = new Float32Array(slot.vertexCapacity * STYLE_FLOATS);
      slot.texts = new Float32Array(slot.layout & TEXT_LAYOUT ? slot.vertexCapacity * TEXT_FLOATS : 0);
      slot.indices = slot.vertexCapacity > 65536 ? new Uint32Array(slot.indexCapacity) : new Uint16Array(slot.indexCapacity);
    }
    const { positions, extras, worlds, styles, texts, indices } = slot;
    // Another count of vertices or indices is drawn from every buffer anew.
    const resized = grow || vertexCount !== slot.vertexCount || indexCount !== slot.indexCount;
    let positionsChanged = resized, worldsChanged = resized, stylesChanged = resized, textsChanged = resized, indicesChanged = resized;
    /** The extra kinds whose buffers changed, as bits. */
    let extrasChanged = resized ? -1 : 0;
    const style = this.scratchStyle, glyph = this.scratchGlyph;
    let vertex = 0, index = 0;
    for (const entry of members) {
      const own = entry.bake!.copy, world = entry.bake!.world!;
      const memberVertices = own.length / 3;
      for (let offset = 0, at = vertex * 3; offset < own.length; offset += 1, at += 1) {
        const value = own[offset]!;
        if (positions[at] !== value) { positions[at] = value; positionsChanged = true; }
      }
      for (let offset = 0, at = vertex * WORLD_FLOATS; offset < memberVertices * WORLD_FLOATS; offset += 1, at += 1) {
        const value = world[offset % WORLD_FLOATS]!;
        if (worlds[at] !== value) { worlds[at] = value; worldsChanged = true; }
      }
      // What the member's own draw binds (`bindUnlitUniforms`), rounded to 32 bits as an upload rounds it.
      // An authored Material reads the tint alone.
      const binding = entry.binding, { opacity, tint } = overlayVisualStyle(entry.mesh!);
      style[0] = binding?.color[0] ?? 1; style[1] = binding?.color[1] ?? 1; style[2] = binding?.color[2] ?? 1; style[3] = binding?.alpha ?? 1;
      style[4] = tint[0]; style[5] = tint[1]; style[6] = tint[2]; style[7] = tint[3] * opacity;
      for (let offset = 0, at = vertex * STYLE_FLOATS; offset < memberVertices * STYLE_FLOATS; offset += 1, at += 1) {
        const value = style[offset % STYLE_FLOATS]!;
        if (styles[at] !== value) { styles[at] = value; stylesChanged = true; }
      }
      if (entry.text) {
        // What the glyph's own draw binds (`TextMaterialBlock.bind`).
        glyph.set(entry.text.atlasRect, 0);
        glyph.set(entry.text.materialRect, 4);
        glyph.set(entry.text.color, 8);
        glyph[11] = entry.mesh!.visibility;
        for (let offset = 0, at = vertex * TEXT_FLOATS; offset < memberVertices * TEXT_FLOATS; offset += 1, at += 1) {
          const value = glyph[offset % TEXT_FLOATS]!;
          if (texts[at] !== value) { texts[at] = value; textsChanged = true; }
        }
      }
      for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1) {
        const target = extras[kind];
        if (!target) continue;
        const data = entry.extras[kind]!, size = EXTRA_SIZES[kind]!;
        for (let offset = 0, at = vertex * size; offset < memberVertices * size; offset += 1, at += 1) {
          const value = Math.fround(data[offset]!);
          if (target[at] !== value) { target[at] = value; extrasChanged |= 1 << kind; }
        }
      }
      const source = entry.indices!;
      for (let offset = 0, at = index; offset < source.length; offset += 1, at += 1) {
        const value = source[offset]! + vertex;
        if (indices[at] !== value) { indices[at] = value; indicesChanged = true; }
      }
      vertex += memberVertices;
      index += source.length;
    }
    slot.vertexCount = vertex;
    slot.indexCount = index;
    if (grow) {
      const blocked = mesh.getScene()._blockEntityCollection;
      mesh.getScene()._blockEntityCollection = true;
      try {
        mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
        for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1) {
          const data = extras[kind];
          if (data) mesh.setVerticesData(EXTRA_KINDS[kind]!, data, true);
          else if (mesh.isVerticesDataPresent(EXTRA_KINDS[kind]!)) mesh.removeVerticesData(EXTRA_KINDS[kind]!);
        }
        // One buffer for the world rows, one for the colour and tint and, for glyphs, one for theirs; their views do
        // not own them.
        const previous = [slot.worldBuffer, slot.styleBuffer, slot.textBuffer];
        const world = slot.worldBuffer = new Buffer(mesh.getEngine(), worlds, true, WORLD_FLOATS);
        DRAW_BATCH_WORLD_KINDS.forEach((kind, row) => mesh.setVerticesBuffer(world.createVertexBuffer(kind, row * 4, 4)));
        const styled = slot.styleBuffer = new Buffer(mesh.getEngine(), styles, true, STYLE_FLOATS);
        [DRAW_BATCH_COLOR_KIND, DRAW_BATCH_TINT_KIND].forEach((kind, part) => mesh.setVerticesBuffer(styled.createVertexBuffer(kind, part * 4, 4)));
        slot.textBuffer = null;
        if (slot.layout & TEXT_LAYOUT) {
          const glyphs = slot.textBuffer = new Buffer(mesh.getEngine(), texts, true, TEXT_FLOATS);
          DRAW_BATCH_TEXT_KINDS.forEach((kind, part) => mesh.setVerticesBuffer(glyphs.createVertexBuffer(kind, part * 4, 4)));
        } else {
          for (const kind of DRAW_BATCH_TEXT_KINDS) if (mesh.isVerticesDataPresent(kind)) mesh.removeVerticesData(kind);
        }
        for (const buffer of previous) buffer?.dispose();
        mesh.setIndices(indices, slot.vertexCapacity, true);
      } finally {
        mesh.getScene()._blockEntityCollection = blocked;
      }
    } else {
      // In place: the buffers (and their vertex array objects) stay. Whole arrays, which the buffers keep for a rebuild.
      if (positionsChanged) mesh.getVertexBuffer(VertexBuffer.PositionKind)!.updateDirectly(positions, 0);
      for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1) {
        const data = extras[kind];
        if (data && extrasChanged & (1 << kind)) mesh.getVertexBuffer(EXTRA_KINDS[kind]!)!.updateDirectly(data, 0);
      }
      if (worldsChanged) slot.worldBuffer!.updateDirectly(worlds, 0);
      if (stylesChanged) slot.styleBuffer!.updateDirectly(styles, 0);
      if (slot.textBuffer && textsChanged) slot.textBuffer.updateDirectly(texts, 0);
      if (indicesChanged) mesh.updateIndices(indices, 0, true);
    }
    const subMesh = mesh.subMeshes[0]!;
    subMesh.verticesStart = 0;
    subMesh.verticesCount = vertex;
    subMesh.indexStart = 0;
    subMesh.indexCount = index;
  }
}

const BATCH_DEFINE = "#define HAPTIC_BATCH\n";

/**
 * Whether the batch's `effect` is its members' program but for the batch's own define: every member draws with one
 * Effect, and the batch mesh, set up as its first member, compiled with the same defines and `HAPTIC_BATCH`.
 */
function sameProgram(slot: Slot, effect: Effect, members: readonly Entry[]): boolean {
  const memberEffect = members[0]!.subMesh.effect;
  if (!memberEffect) return false;
  for (const entry of members) if (entry.subMesh.effect !== memberEffect) return false;
  if (slot.batchEffect === effect && slot.memberEffect === memberEffect) return true;
  const defines = effect.defines.replace(BATCH_DEFINE, "");
  if (defines === effect.defines || defines !== memberEffect.defines) return false;
  slot.batchEffect = effect;
  slot.memberEffect = memberEffect;
  return true;
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
