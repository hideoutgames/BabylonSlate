import { Buffer, VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { Material } from "@babylonjs/core/Materials/material";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { FloatArray, IndicesArray } from "@babylonjs/core/types";
import type { OverlayLayoutRect } from "@haptic/core";
import {
  DRAW_BATCH_COLOR_KIND, DRAW_BATCH_TEXEL_KIND, DRAW_BATCH_TEXT_KINDS, DRAW_BATCH_TINT_KIND, DRAW_BATCH_WORLD_KINDS, isBoundedMaterial, isDrawBatchMaterial,
  isDrawBatchTextMaterial, markDrawBatchMesh,
} from "./draw-batch-world-block";
import { sceneDrawBatcher, setSceneDrawBatcher, type SceneDrawBatcher } from "./draw-batching";
import { hasMeshLatticeDeformer } from "./lattice-deformer-binding";
import { LayerImageAtlas, type LayerImageCell } from "./layer-image-atlas";
import { disableOverlayClipScissor, enableOverlayClipScissor, overlayDrawClip } from "./overlay-layout-render";
import { overlayVisualStyle, shareOverlayVisualStyle } from "./overlay-visual-style";
import { hasStockOrPlannedVertexStage } from "./shadow-material-policy";
import { bindTextMaterialGlyph, textMaterialGlyphBinding, type TextMaterialBinding } from "./text-material-block";
import { isUnlitMaterial } from "./unlit-material";
import { setUnlitBinding, UNLIT_TEXEL_WHOLE, unlitBinding, unlitTexelGrid, type UnlitBinding } from "./unlit-material-blocks";

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
 * - **Images.** Members whose small images sit on the Scene's shared page (`layer-image-atlas.ts`) sample the page in
 *   place of their own textures, so they share a draw whatever their images. Each vertex carries its member's texel
 *   grid (`unlitTexelGrid`, with the size of its image's cell and where the cell starts on the page): the unlit graph
 *   finds the texel a member's own UV falls in and samples that texel's centre, on the page as on the image's own
 *   texture, so both read the same texel of the same values.
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
 *
 * - **Retention.** Each pass of an Engine frame (by its place among the frame's passes) keeps its entries, batches and
 *   the slots they filled. Every frame still classifies every member and asks Babylon's readiness gate; what grouping
 *   reads (the sorted list, each member's draw values at full precision, its bounds' inputs, the Scene's transform,
 *   the viewport's margins and the eye) is compared by value with what the kept grouping was made from, and any
 *   difference regroups the whole pass. What a batch's fill writes for each member is compared with 32-bit copies of
 *   what it last wrote; a batch refills (whole, as without retention) when one differs or its slot no longer holds its
 *   data. `verifyRetainedOverlayBatches` checks every retained pass against the full path.
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
  /** Where the binding's image is on the Scene's shared page, when a batch may sample it there. */
  cell: LayerImageCell | null;
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
  /** Why the draw goes on its own, as classified this frame; null when it may batch. */
  alone: Exclude<OverlayAloneReason, "single" | "unmatched"> | null;
  /** What grouping read for this draw when the pass's batches were last made or kept (`stampGroup`). */
  group: Stamp;
  /** What the member's own draw binds that a batch carries per vertex: colour with alpha, tint, texel grid (`styleOf`). */
  style: Float32Array;
  /** A glyph's own values a batch carries per vertex (`styleOf`). */
  glyph: Float32Array;
  /**
   * What the last fill of the member's batch wrote for it, in 32 bits: its vertices, world rows, style, glyph and
   * extra kinds (`keepWritten`), with its layout then and its indices.
   */
  written: Float32Array;
  writtenLayout: number;
  writtenIndices: Float64Array;
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
  /** The slot it last drew from. */
  slot: Slot | null;
  /** The fill its members' `written` values come from; -1 when none since its pass was grouped. */
  serial: number;
  /** The pass (`passSerial`) that last filled it, and the last that gave it a slot. */
  filledPass: number;
  heldPass: number;
}

/**
 * A pass's work kept between frames: the sorted list it was made for, its entries and batches, and what grouping read
 * for the whole pass.
 */
interface PassRecord {
  transparent: boolean;
  sorted: SubMesh[];
  entries: Entry[];
  batches: Batch[];
  batchCount: number;
  /** Whether `batches` were made from the entries' group stamps (false: regroup). */
  grouped: boolean;
  pass: Stamp;
}

/**
 * Values compared with those kept from the last time, each kept as it is put: `put` notes a difference, by `!==` (so
 * at full precision, and NaN always differs).
 */
class Stamp {
  private readonly values: unknown[] = [];
  private at = 0;
  private changed = false;

  begin(): void {
    this.at = 0;
    this.changed = false;
  }

  put(value: unknown): void {
    const at = this.at++;
    if (at < this.values.length && this.values[at] === value) return;
    this.values[at] = value;
    this.changed = true;
  }

  /** Whether any value differed from the last time (or there were another number of them). */
  end(): boolean {
    if (this.values.length !== this.at) {
      this.values.length = this.at;
      this.changed = true;
    }
    return this.changed;
  }

  clear(): void {
    this.values.length = 0;
  }
}

/**
 * How a Scene's batcher drew its passes since it was made: draws of passes that reached grouping (two or more that may
 * batch) that took the kept work (`retainedMembers`: grouping kept, and no refill of their batch, or no batch) or
 * did that work again (`fullMembers`), and, while `verifyRetainedOverlayBatches` is on, the retained passes checked
 * against the full path and those that differed, with the first few differences described.
 */
export interface OverlayBatchWork {
  retainedMembers: number;
  fullMembers: number;
  verifiedPasses: number;
  mismatches: number;
  mismatchDetails: string[];
}

/** Differences `OverlayBatchWork.mismatchDetails` describes. */
const MAX_MISMATCH_DETAILS = 4;

let verifies = false;

/**
 * Debugging aid: every pass that takes the retained path is followed by the full path's work, on its own entries,
 * batches and vertex caches, which must give the same batches in the same order with the same members, each from a
 * slot of its own that holds what the full path would write (`OverlayBatchWork.mismatches`).
 */
export function verifyRetainedOverlayBatches(enabled: boolean): void {
  verifies = enabled;
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
  /** Each vertex's colour with alpha, its tint, then its texel grid: twelve floats, in `styleBuffer` (the three style attributes). */
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
  /** The binding a batch that samples the shared page draws: its first member's, with the page for its texture. */
  pageBinding: UnlitBinding | null;
  /** The batch whose fill (`serial`) the buffers hold; null while they hold no batch's whole fill. */
  owner: Batch | null;
  serial: number;
  /** The Engine frame that last drew from it: it draws once per Engine frame. */
  usedFrame: number;
}

/** The arrays a batch's values are written to: a slot's, or the verifier's. */
interface BatchArrays {
  positions: Float32Array;
  extras: Array<Float32Array | null>;
  worlds: Float32Array;
  styles: Float32Array;
  texts: Float32Array;
  indices: Uint16Array | Uint32Array | Float64Array;
}

/** Which of a batch's arrays a write changed, as bits (`writeMembers`). */
const CHANGED_POSITIONS = 1, CHANGED_WORLDS = 2, CHANGED_STYLES = 4, CHANGED_TEXTS = 8, CHANGED_INDICES = 16;
function changedExtra(kind: number): number {
  return 32 << kind;
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
function bakeOf(mesh: Mesh, eye: { x: number; y: number; z: number }, store: WeakMap<Mesh, Bake>): Bake | null {
  const source = packedFloats(mesh, VertexBuffer.PositionKind, 3);
  if (!source) return null;
  let bake = store.get(mesh);
  if (!bake)
    store.set(mesh, (bake = {
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
/** Floats of a member's own values a batch carries per vertex: its colour with alpha, its tint, then its texel grid. */
const STYLE_FLOATS = 12;
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
 * the colour and the texel grid for the unlit Material).
 */
function vertexBuffers(layout: number, unlit: boolean): number {
  let extras = 0;
  for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1) if (layout & (1 << kind)) extras += 1;
  return 1 + extras + DRAW_BATCH_WORLD_KINDS.length + (unlit ? 3 : 1) + (layout & TEXT_LAYOUT ? DRAW_BATCH_TEXT_KINDS.length : 0);
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

/** The texture a batch of `entry` samples: the shared page its image is on, else its binding's own. */
function sampled(entry: Entry): BaseTexture | null {
  return entry.cell?.page ?? entry.binding!.texture;
}

/**
 * Whether two unlit draws bind the same values (`bindUnlitUniforms`) but for the colour and alpha, which a batch
 * carries per vertex.
 */
function sameBinding(entryA: Entry, entryB: Entry): boolean {
  const a = entryA.binding!, b = entryB.binding!;
  if (a === b) return true;
  if (sampled(entryA) !== sampled(entryB) || a.cutoff !== b.cutoff || a.blend !== b.blend || a.textureAlpha !== b.textureAlpha || a.twoSided !== b.twoSided)
    return false;
  if (!a.msdf || !b.msdf) return !a.msdf && !b.msdf;
  return sameColor(a.msdf.strokeColor, b.msdf.strokeColor) && a.msdf.strokeWidth === b.msdf.strokeWidth;
}

/** `binding` with `page` for its texture, in the slot's own object. */
function pageBinding(slot: Slot, binding: UnlitBinding, page: BaseTexture): UnlitBinding {
  const own = (slot.pageBinding ??= { ...binding });
  own.texture = page; own.color = binding.color; own.alpha = binding.alpha; own.cutoff = binding.cutoff; own.blend = binding.blend;
  own.textureAlpha = binding.textureAlpha; own.twoSided = binding.twoSided; own.msdf = binding.msdf;
  return own;
}

/**
 * Whether `texture`'s matrix gives the unlit graph the UVs it was given (`UnlitUvBlock`): a `Texture`'s unmoved one,
 * which Babylon builds with its translation in the third row, or the identity of any other texture.
 */
function keepsUvs(texture: BaseTexture): boolean {
  const matrix = texture.getTextureMatrix();
  return matrix.isIdentityAs3x2() || matrix.isIdentity();
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
  if (a.binding && b.binding) return sameBinding(a, b);
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
  return entry.cell?.page ?? entry.binding?.texture ?? entry.text?.atlas ?? entry.material!;
}

function createEntry(subMesh: SubMesh): Entry {
  return {
    subMesh, mesh: null, material: null, binding: null, cell: null, text: null, clip: null, bake: null, extras: EXTRA_KINDS.map(() => null), layout: 0, indices: null,
    minX: 0, minY: 0, maxX: 0, maxY: 0, batch: -1, alone: null, group: new Stamp(), style: new Float32Array(STYLE_FLOATS), glyph: new Float32Array(TEXT_FLOATS),
    written: new Float32Array(0), writtenLayout: -1, writtenIndices: new Float64Array(0),
  };
}

function createBatch(): Batch {
  return { entries: [], minX: 0, minY: 0, maxX: 0, maxY: 0, previousOfKey: -1, slot: null, serial: -1, filledPass: 0, heldPass: 0 };
}

/** Whether `kept` lists the first `count` of `sorted`, in order. */
function sameList(kept: readonly SubMesh[], sorted: readonly SubMesh[], count: number): boolean {
  if (kept.length !== count) return false;
  for (let index = 0; index < count; index += 1) if (kept[index] !== sorted[index]) return false;
  return true;
}

/**
 * Puts what grouping reads for `entry` into its stamp and says whether any of it changed: whether it may batch, what
 * `sameDraw` and `drawKey` compare (at full precision), and what `bound` projects (its own box and world matrix, or
 * whether its bounding box holds and that box).
 */
function stampGroup(entry: Entry): boolean {
  const stamp = entry.group;
  stamp.begin();
  const mesh = entry.mesh;
  stamp.put(mesh);
  if (mesh) {
    stamp.put(entry.material);
    const clip = entry.clip;
    stamp.put(clip !== null);
    if (clip) { stamp.put(clip.x); stamp.put(clip.y); stamp.put(clip.width); stamp.put(clip.height); }
    stamp.put(entry.layout);
    stamp.put(mesh.sideOrientation);
    const text = entry.text;
    stamp.put(text !== null);
    if (text) {
      stamp.put(text.atlas); stamp.put(text.mode); stamp.put(text.outline);
      stamp.put(text.outlineColor[0]); stamp.put(text.outlineColor[1]); stamp.put(text.outlineColor[2]);
    } else {
      stamp.put(mesh.visibility);
    }
    const binding = entry.binding;
    stamp.put(binding !== null);
    if (binding) {
      stamp.put(sampled(entry)); stamp.put(binding.cutoff); stamp.put(binding.blend); stamp.put(binding.textureAlpha); stamp.put(binding.twoSided);
      const msdf = binding.msdf;
      stamp.put(!!msdf);
      if (msdf) { stamp.put(msdf.strokeColor[0]); stamp.put(msdf.strokeColor[1]); stamp.put(msdf.strokeColor[2]); stamp.put(msdf.strokeWidth); }
    } else {
      stamp.put(mesh.receiveShadows);
    }
    stamp.put(drawKey(entry));
  }
  // What `bound` reads.
  const bake = entry.bake;
  stamp.put(bake !== null);
  if (bake) {
    for (let axis = 0; axis < 3; axis += 1) { stamp.put(bake.min[axis]); stamp.put(bake.max[axis]); }
    const world = entry.subMesh.getMesh().getWorldMatrix().asArray();
    for (let index = 0; index < 16; index += 1) stamp.put(world[index]);
  } else {
    const holds = boundsHold(entry.subMesh.getMesh(), entry.subMesh.getMaterial());
    stamp.put(holds);
    if (holds) {
      const box = entry.subMesh.getBoundingInfo().boundingBox;
      const min = box.minimumWorld, max = box.maximumWorld;
      stamp.put(min.x); stamp.put(min.y); stamp.put(min.z); stamp.put(max.x); stamp.put(max.y); stamp.put(max.z);
    }
  }
  return stamp.end();
}

/**
 * Writes what the member's own draw binds and a batch carries per vertex (`bindUnlitUniforms`, `TextMaterialBlock.bind`),
 * rounded to 32 bits as an upload rounds it, into `entry.style` and, for a glyph, `entry.glyph`.
 */
function styleOf(entry: Entry): void {
  const style = entry.style;
  // An authored Material reads the tint alone.
  const binding = entry.binding, { opacity, tint } = overlayVisualStyle(entry.mesh!);
  style[0] = binding?.color[0] ?? 1; style[1] = binding?.color[1] ?? 1; style[2] = binding?.color[2] ?? 1; style[3] = binding?.alpha ?? 1;
  style[4] = tint[0]; style[5] = tint[1]; style[6] = tint[2]; style[7] = tint[3] * opacity;
  // The texel grid the member's own draw binds: over the whole of the texture, or over its image's cell where this
  // batch samples the page.
  unlitTexelGrid(binding?.texture ?? null, style, 8);
  const cell = entry.cell;
  if (cell) { style[8]! *= cell.width; style[9]! *= cell.height; }
  style[10] = cell?.x ?? UNLIT_TEXEL_WHOLE; style[11] = cell?.y ?? UNLIT_TEXEL_WHOLE;
  if (entry.text) {
    const glyph = entry.glyph;
    glyph.set(entry.text.atlasRect, 0);
    glyph.set(entry.text.materialRect, 4);
    glyph.set(entry.text.color, 8);
    glyph[11] = entry.mesh!.visibility;
  }
}

/** How many values `keepWritten` keeps for `entry`. */
function writtenLength(entry: Entry): number {
  const vertices = entry.bake!.copy.length / 3;
  let length = vertices * 3 + WORLD_FLOATS + STYLE_FLOATS + (entry.text ? TEXT_FLOATS : 0);
  for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1) if (entry.layout & (1 << kind)) length += vertices * EXTRA_SIZES[kind]!;
  return length;
}

/** Compares `count` of `values`, rounded to 32 bits, with `kept` from `at`: the place after them, or -1 at a difference. */
function sameRun(kept: Float32Array, at: number, values: ArrayLike<number>, count: number): number {
  if (at < 0) return -1;
  for (let index = 0; index < count; index += 1) if (kept[at + index] !== Math.fround(values[index]!)) return -1;
  return at + count;
}

function keepRun(kept: Float32Array, at: number, values: ArrayLike<number>, count: number): number {
  for (let index = 0; index < count; index += 1) kept[at + index] = values[index]!;
  return at + count;
}

/**
 * Whether what `fill` would write for `entry`'s member now (with `styleOf` written) is what its batch's last fill
 * wrote for it (`keepWritten`): the same values, in 32 bits as the slot holds them, and the same indices.
 */
function holdsWritten(entry: Entry): boolean {
  const kept = entry.written, indices = entry.indices!, bake = entry.bake!;
  if (entry.writtenLayout !== entry.layout || kept.length !== writtenLength(entry) || entry.writtenIndices.length !== indices.length) return false;
  const vertices = bake.copy.length / 3;
  let at = sameRun(kept, 0, bake.copy, bake.copy.length);
  at = sameRun(kept, at, bake.world!, WORLD_FLOATS);
  at = sameRun(kept, at, entry.style, STYLE_FLOATS);
  if (entry.text) at = sameRun(kept, at, entry.glyph, TEXT_FLOATS);
  for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1)
    if (entry.layout & (1 << kind)) at = sameRun(kept, at, entry.extras[kind]!, vertices * EXTRA_SIZES[kind]!);
  if (at < 0) return false;
  const keptIndices = entry.writtenIndices;
  for (let index = 0; index < indices.length; index += 1) if (keptIndices[index] !== indices[index]) return false;
  return true;
}

/** Keeps what a fill wrote for `entry`'s member (`holdsWritten`). */
function keepWritten(entry: Entry): void {
  const length = writtenLength(entry), indices = entry.indices!, bake = entry.bake!;
  if (entry.written.length !== length) entry.written = new Float32Array(length);
  if (entry.writtenIndices.length !== indices.length) entry.writtenIndices = new Float64Array(indices.length);
  const kept = entry.written, vertices = bake.copy.length / 3;
  let at = keepRun(kept, 0, bake.copy, bake.copy.length);
  at = keepRun(kept, at, bake.world!, WORLD_FLOATS);
  at = keepRun(kept, at, entry.style, STYLE_FLOATS);
  if (entry.text) at = keepRun(kept, at, entry.glyph, TEXT_FLOATS);
  for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1)
    if (entry.layout & (1 << kind)) at = keepRun(kept, at, entry.extras[kind]!, vertices * EXTRA_SIZES[kind]!);
  for (let index = 0; index < indices.length; index += 1) entry.writtenIndices[index] = indices[index]!;
  entry.writtenLayout = entry.layout;
}

/**
 * Writes the members' vertices, world matrices, styles, glyph values, extra kinds and indices into `into` from its
 * start, as one batch holds them (`styleOf` written first); returns which arrays it changed (`CHANGED_*`).
 */
function writeMembers(into: BatchArrays, members: readonly Entry[]): number {
  const { positions, extras, worlds, styles, texts, indices } = into;
  let changed = 0;
  let vertex = 0, index = 0;
  for (const entry of members) {
    const own = entry.bake!.copy, world = entry.bake!.world!;
    const memberVertices = own.length / 3;
    for (let offset = 0, at = vertex * 3; offset < own.length; offset += 1, at += 1) {
      const value = own[offset]!;
      if (positions[at] !== value) { positions[at] = value; changed |= CHANGED_POSITIONS; }
    }
    for (let offset = 0, at = vertex * WORLD_FLOATS; offset < memberVertices * WORLD_FLOATS; offset += 1, at += 1) {
      const value = world[offset % WORLD_FLOATS]!;
      if (worlds[at] !== value) { worlds[at] = value; changed |= CHANGED_WORLDS; }
    }
    const style = entry.style;
    for (let offset = 0, at = vertex * STYLE_FLOATS; offset < memberVertices * STYLE_FLOATS; offset += 1, at += 1) {
      const value = style[offset % STYLE_FLOATS]!;
      if (styles[at] !== value) { styles[at] = value; changed |= CHANGED_STYLES; }
    }
    if (entry.text) {
      const glyph = entry.glyph;
      for (let offset = 0, at = vertex * TEXT_FLOATS; offset < memberVertices * TEXT_FLOATS; offset += 1, at += 1) {
        const value = glyph[offset % TEXT_FLOATS]!;
        if (texts[at] !== value) { texts[at] = value; changed |= CHANGED_TEXTS; }
      }
    }
    for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1) {
      const target = extras[kind];
      if (!target) continue;
      const data = entry.extras[kind]!, size = EXTRA_SIZES[kind]!;
      for (let offset = 0, at = vertex * size; offset < memberVertices * size; offset += 1, at += 1) {
        const value = Math.fround(data[offset]!);
        if (target[at] !== value) { target[at] = value; changed |= changedExtra(kind); }
      }
    }
    const source = entry.indices!;
    for (let offset = 0, at = index; offset < source.length; offset += 1, at += 1) {
      const value = source[offset]! + vertex;
      if (indices[at] !== value) { indices[at] = value; changed |= CHANGED_INDICES; }
    }
    vertex += memberVertices;
    index += source.length;
  }
  return changed;
}

/** A batch's vertex and index counts. */
function batchCounts(members: readonly Entry[]): { vertices: number; indices: number } {
  let vertices = 0, indices = 0;
  for (const entry of members) {
    vertices += entry.bake!.copy.length / 3;
    indices += entry.indices!.length;
  }
  return { vertices, indices };
}

/**
 * Draws a Scene's sorted passes in batches (see the module comment). One per Scene, from `setSceneDrawBatching`.
 */
class OverlayDrawBatcher implements SceneDrawBatcher {
  private readonly scene: Scene;
  /** Each pass of an Engine frame's kept work, by the pass's place among the frame's passes. */
  private readonly records: PassRecord[] = [];
  /** The Engine frame whose passes took the first `passCount` records. */
  private passFrame = -1;
  private passCount = 0;
  /** Numbers each pass drawn, and each fill. */
  private passSerial = 0;
  private fillSerial = 0;
  /** Per draw key, the pass's last batch of it (empty between `group` calls). */
  private readonly lastOfKey = new Map<object, number>();
  private readonly slots: Slot[] = [];
  private disposed = false;
  /** The pass's Scene transform and two of its viewport's pixels in NDC (`measurePass`). */
  private transform: Matrix | null = null;
  private marginX = 0;
  private marginY = 0;
  private readonly work: OverlayBatchWork = { retainedMembers: 0, fullMembers: 0, verifiedPasses: 0, mismatches: 0, mismatchDetails: [] };
  /** The verifier's own entries, batches, vertex caches and arrays: it never reads or writes the retained path's. */
  private readonly verifyEntries: Entry[] = [];
  private readonly verifyBatches: Batch[] = [];
  private readonly verifyBakes = new WeakMap<Mesh, Bake>();
  private verifyArrays: BatchArrays = {
    positions: new Float32Array(0), extras: EXTRA_KINDS.map(() => null), worlds: new Float32Array(0), styles: new Float32Array(0), texts: new Float32Array(0),
    indices: new Float64Array(0),
  };
  private readonly scratchCorner = { x: 0, y: 0, z: 0 };
  private readonly scratchGrid = [0, 0];
  private readonly scratchViewport = new Viewport(0, 0, 1, 1);
  /** The Scene's shared page of small images, which its batches sample; null while they sample their own textures. */
  private atlas: LayerImageAtlas | null;

  constructor(scene: Scene) {
    this.scene = scene;
    this.atlas = new LayerImageAtlas(scene);
  }

  /** Whether batches sample the Scene's shared page of small images (they do unless turned off, as a proof does). */
  setImagePages(enabled: boolean): void {
    if (enabled === !!this.atlas || this.disposed) return;
    this.atlas?.dispose();
    this.atlas = enabled ? new LayerImageAtlas(this.scene) : null;
  }

  /** The shared page's images and those drawn there. */
  get imagePages(): { images: number; drawn: number } {
    return this.atlas?.counts ?? { images: 0, drawn: 0 };
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
    const record = this.passRecord();
    if (record.transparent !== transparent || !sameList(record.sorted, sorted, count)) {
      record.transparent = transparent;
      record.sorted.length = count;
      for (let index = 0; index < count; index += 1) record.sorted[index] = sorted[index]!;
      record.grouped = false;
    }
    const entries = record.entries;
    if (entries.length > count) entries.length = count;
    const eye = scene.floatingOriginOffset;
    let candidates = 0;
    for (let index = 0; index < count; index += 1) {
      const entry = (entries[index] ??= createEntry(sorted[index]!));
      entry.subMesh = sorted[index]!;
      const alone = (entry.alone = this.classify(entry, eye, bakes));
      if (alone) stats.alone[alone] += 1;
      else candidates += 1;
    }
    try {
      if (candidates < 2) {
        // A lone candidate has nothing to batch with.
        record.grouped = false;
        stats.alone.unmatched += candidates;
        stats.draws += count;
        for (let index = 0; index < count; index += 1) drawOne(sorted[index]!);
        return;
      }
      this.measurePass();
      // Every stamp is put, so each holds this frame's values.
      let regroup = !record.grouped;
      if (this.stampPass(record.pass, eye)) regroup = true;
      for (let index = 0; index < count; index += 1) if (stampGroup(entries[index]!)) regroup = true;
      if (regroup) {
        for (let index = 0; index < record.batchCount; index += 1) record.batches[index]!.entries.length = 0;
        record.batchCount = this.group(entries, count, record.batches);
        // No batch's members were written as these batches hold them.
        for (const batch of record.batches) batch.serial = -1;
        record.grouped = true;
      }
      const pass = ++this.passSerial;
      const refilled = this.drawBatches(record, transparent, drawOne, stats, pass);
      if (regroup) {
        this.work.fullMembers += count;
      } else {
        this.work.fullMembers += refilled;
        this.work.retainedMembers += count - refilled;
        if (verifies) this.verify(record, count, eye, pass);
      }
    } catch (error) {
      record.grouped = false;
      throw error;
    }
  }

  /** What the batcher has done since it was made (`OverlayBatchWork`), as a copy. */
  get batchWork(): OverlayBatchWork {
    return { ...this.work, mismatchDetails: [...this.work.mismatchDetails] };
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
    for (const record of this.records) this.dropRecord(record);
    this.records.length = 0;
    this.verifyEntries.length = 0;
    this.verifyBatches.length = 0;
    this.atlas?.dispose();
    this.atlas = null;
  }

  /**
   * The kept work of the frame's next pass. A new Engine frame starts from the first record, and records the last frame
   * drew no pass with let their members go.
   */
  private passRecord(): PassRecord {
    const frame = this.scene.getEngine().frameId;
    if (frame !== this.passFrame) {
      for (let index = this.passCount; index < this.records.length; index += 1) this.dropRecord(this.records[index]!);
      this.records.length = Math.min(this.records.length, this.passCount);
      this.passFrame = frame;
      this.passCount = 0;
    }
    const index = this.passCount++;
    return (this.records[index] ??= { transparent: false, sorted: [], entries: [], batches: [], batchCount: 0, grouped: false, pass: new Stamp() });
  }

  private dropRecord(record: PassRecord): void {
    for (const batch of record.batches) {
      if (batch.slot?.owner === batch) batch.slot.owner = null;
      batch.slot = null;
      batch.entries.length = 0;
    }
    record.batches.length = 0;
    record.batchCount = 0;
    record.entries.length = 0;
    record.sorted.length = 0;
    record.grouped = false;
    record.pass.clear();
  }

  private release(entry: Entry): void {
    entry.mesh = null; entry.material = null; entry.binding = null; entry.cell = null; entry.text = null; entry.clip = null; entry.bake = null; entry.indices = null;
    entry.extras.fill(null);
    entry.layout = 0;
    entry.batch = -1;
  }

  /**
   * The pass's Scene transform and margins: two of the camera viewport's pixels in NDC (`toGlobalToRef` fills the ref
   * but returns the camera's normalised viewport).
   */
  private measurePass(): void {
    const scene = this.scene, engine = scene.getEngine();
    this.transform = scene.getTransformMatrix();
    const width = engine.getRenderWidth(), height = engine.getRenderHeight();
    const viewport = this.scratchViewport;
    if (scene.activeCamera) scene.activeCamera.viewport.toGlobalToRef(width, height, viewport);
    else { viewport.width = width; viewport.height = height; }
    // NDC spans 2 across the camera's viewport: two of its pixels.
    this.marginX = 4 / Math.max(1, viewport.width);
    this.marginY = 4 / Math.max(1, viewport.height);
  }

  /** Puts what grouping reads for the whole pass (its transform, margins and eye) and says whether any changed. */
  private stampPass(stamp: Stamp, eye: { x: number; y: number; z: number }): boolean {
    stamp.begin();
    const m = this.transform!.asArray();
    for (let index = 0; index < 16; index += 1) stamp.put(m[index]);
    stamp.put(this.marginX); stamp.put(this.marginY);
    stamp.put(eye.x); stamp.put(eye.y); stamp.put(eye.z);
    return stamp.end();
  }

  /** Fills `entry` for a draw that may batch and returns null; otherwise why it draws on its own. */
  private classify(entry: Entry, eye: { x: number; y: number; z: number }, store: WeakMap<Mesh, Bake>): Exclude<OverlayAloneReason, "single" | "unmatched"> | null {
    const subMesh = entry.subMesh;
    const mesh = subMesh.getMesh();
    const material = subMesh.getMaterial();
    // What the last frame found goes: a draw that goes on its own carries none of it.
    this.release(entry);
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
    const bake = bakeOf(mesh, eye, store);
    if (!bake) return "other";
    // A pose that mirrors, or is not affine.
    if (!bake.world) return "transform";
    if (bake.copy.length !== vertices * 3) return "other";
    entry.mesh = mesh;
    entry.material = material;
    entry.binding = unlit ? unlitBinding(mesh) : null;
    entry.cell = this.cellOf(entry.binding?.texture);
    entry.text = text;
    entry.clip = clip ?? null;
    entry.bake = bake;
    entry.layout = layout;
    entry.indices = indices;
    return null;
  }

  /**
   * Where a draw's image is on the shared page, when a batch may sample it there in place of `texture`: the texture's
   * matrix leaves the UVs as they are (the page's does), its lookups are taken on its texel grid (so a texel's centre
   * is all a lookup reads, on either texture), and the page holds it.
   */
  private cellOf(texture: BaseTexture | null | undefined): LayerImageCell | null {
    if (!texture || !this.atlas || !keepsUvs(texture)) return null;
    unlitTexelGrid(texture, this.scratchGrid);
    return this.scratchGrid[0] !== 0 ? this.atlas.cell(texture) : null;
  }

  /** Projected bounds of every draw, two of the viewport's pixels wider on each side; unbounded when not known. */
  private bound(entry: Entry, transform: Matrix, marginX: number, marginY: number): void {
    entry.minX = entry.minY = Number.POSITIVE_INFINITY;
    entry.maxX = entry.maxY = Number.NEGATIVE_INFINITY;
    // What `stampGroup` stamps.
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
  private group(entries: readonly Entry[], count: number, batches: Batch[]): number {
    const transform = this.transform!, marginX = this.marginX, marginY = this.marginY;
    const lastOfKey = this.lastOfKey;
    lastOfKey.clear();
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
        const batch = (batches[target] ??= createBatch());
        batch.entries.length = 0;
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
    lastOfKey.clear();
    return used;
  }

  /** Draws the record's batches; returns how many members a fill wrote. */
  private drawBatches(record: PassRecord, transparent: boolean, drawOne: (subMesh: SubMesh) => void, stats: OverlayBatchStats, pass: number): number {
    let filled = 0;
    for (let index = 0; index < record.batchCount; index += 1) {
      const batch = record.batches[index]!;
      const members = batch.entries;
      // A member whose own draw would not draw now (Babylon's readiness gate) leaves its batch's members to their own.
      if (members.length > 1 && members.every(drawsNow)) {
        const drawn = this.drawBatch(batch, transparent, pass);
        if (batch.filledPass === pass) filled += members.length;
        if (drawn) {
          stats.draws += 1;
          stats.batches += 1;
          stats.batched += members.length;
          continue;
        }
      }
      stats.draws += members.length;
      // A candidate nothing matched, or whose batch could not draw as one now; the others were counted as classified.
      for (const entry of members) if (entry.mesh) stats.alone.unmatched += 1;
      for (const entry of members) drawOne(entry.subMesh);
    }
    return filled;
  }

  /** Draws `batch` as one; false (nothing drawn) when its mesh is not ready with its members' program's batch variant. */
  private drawBatch(batch: Batch, transparent: boolean, pass: number): boolean {
    const scene = this.scene;
    const members = batch.entries;
    const first = members[0]!;
    const member = first.mesh!;
    for (const entry of members) styleOf(entry);
    const slot = this.slotFor(batch, first.layout);
    batch.slot = slot;
    batch.heldPass = pass;
    const mesh = slot.mesh;
    if (mesh.material !== first.material) mesh.material = first.material;
    if (first.binding) setUnlitBinding(mesh, first.cell ? pageBinding(slot, first.binding, first.cell.page) : first.binding);
    else {
      if (first.text) bindTextMaterialGlyph(mesh, first.text);
      mesh.receiveShadows = member.receiveShadows;
    }
    shareOverlayVisualStyle(mesh, member);
    mesh.visibility = member.visibility;
    mesh.sideOrientation = member.sideOrientation;
    // The slot still holds this batch's last fill, and every member would be written as it was then: nothing to write.
    let holds = slot.owner === batch && slot.serial === batch.serial;
    for (let index = 0; holds && index < members.length; index += 1) holds = holdsWritten(members[index]!);
    if (!holds) {
      // Owned by no batch until the fill is whole.
      slot.owner = null;
      this.fill(slot, members);
      for (const entry of members) keepWritten(entry);
      slot.owner = batch;
      slot.serial = batch.serial = ++this.fillSerial;
      batch.filledPass = pass;
    }
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
   * A batch mesh for `batch` not yet drawn from in this Engine frame: the one it drew from last, else one no batch holds
   * a fill in, else any, else a new one (out of the Scene's lists). A batch mesh draws once per Engine frame: WebGPU
   * writes buffers ahead of the frame's draws, so a second write would show in both.
   */
  private slotFor(batch: Batch, layout: number): Slot {
    const frame = this.scene.getEngine().frameId;
    let slot = batch.slot;
    if (!slot || slot.usedFrame === frame) {
      slot = null;
      let spare: Slot | null = null;
      for (const candidate of this.slots) {
        if (candidate.usedFrame === frame) continue;
        const owner = candidate.owner;
        if (!owner || owner.slot !== candidate || owner.serial !== candidate.serial) {
          slot = candidate;
          break;
        }
        spare ??= candidate;
      }
      slot ??= spare;
    }
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
        pageBinding: null, owner: null, serial: -1, usedFrame: -1,
      };
      this.slots.push(slot);
    }
    slot.usedFrame = frame;
    if (slot.layout !== layout) {
      // Rebuilt with this layout's vertex data at the next fill.
      slot.layout = layout;
      slot.vertexCapacity = 0;
      slot.owner = null;
    }
    return slot;
  }

  /**
   * Writes the members' vertices, world matrices, colours and tints, UVs and indices into the slot's buffers, uploading
   * only the buffers whose contents changed: a member that moves uploads the world matrices alone, a tint the styles.
   * Each member's `styleOf` is written first.
   */
  private fill(slot: Slot, members: readonly Entry[]): void {
    const { vertices: vertexCount, indices: indexCount } = batchCounts(members);
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
    const changed = writeMembers(slot, members) | (resized ? -1 : 0);
    const vertex = vertexCount, index = indexCount;
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
        [DRAW_BATCH_COLOR_KIND, DRAW_BATCH_TINT_KIND, DRAW_BATCH_TEXEL_KIND].forEach((kind, part) => mesh.setVerticesBuffer(styled.createVertexBuffer(kind, part * 4, 4)));
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
      if (changed & CHANGED_POSITIONS) mesh.getVertexBuffer(VertexBuffer.PositionKind)!.updateDirectly(positions, 0);
      for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1) {
        const data = extras[kind];
        if (data && changed & changedExtra(kind)) mesh.getVertexBuffer(EXTRA_KINDS[kind]!)!.updateDirectly(data, 0);
      }
      if (changed & CHANGED_WORLDS) slot.worldBuffer!.updateDirectly(worlds, 0);
      if (changed & CHANGED_STYLES) slot.styleBuffer!.updateDirectly(styles, 0);
      if (slot.textBuffer && changed & CHANGED_TEXTS) slot.textBuffer.updateDirectly(texts, 0);
      if (changed & CHANGED_INDICES) mesh.updateIndices(indices, 0, true);
    }
    const subMesh = mesh.subMeshes[0]!;
    subMesh.verticesStart = 0;
    subMesh.verticesCount = vertex;
    subMesh.indexStart = 0;
    subMesh.indexCount = index;
  }

  /**
   * Checks a pass that took the retained path against the full path, worked out on the verifier's own entries,
   * batches, vertex caches and arrays (`verifyRetainedOverlayBatches`): the same classification, bounds and batches, in
   * the same order, and every batch given a slot this pass holding, in a slot of its own, what a fill would write now.
   */
  private verify(record: PassRecord, count: number, eye: { x: number; y: number; z: number }, pass: number): void {
    const work = this.work;
    work.verifiedPasses += 1;
    const kept = record.entries, shadow = this.verifyEntries, batches = this.verifyBatches;
    let detail: string | null = null;
    try {
      let candidates = 0;
      for (let index = 0; index < count; index += 1) {
        const entry = (shadow[index] ??= createEntry(record.sorted[index]!));
        entry.subMesh = record.sorted[index]!;
        entry.alone = this.classify(entry, eye, this.verifyBakes);
        if (!entry.alone) candidates += 1;
        if (!detail && entry.alone !== kept[index]!.alone) detail = `member ${index}: ${entry.alone ?? "batchable"}, kept ${kept[index]!.alone ?? "batchable"}`;
      }
      if (!detail && candidates < 2) detail = `${candidates} batchable members`;
      if (!detail) {
        this.measurePass();
        const used = this.group(shadow, count, batches);
        detail = compareGrouping(kept, shadow, count, record.batches, record.batchCount, batches, used);
      }
      const frame = this.scene.getEngine().frameId;
      const seen = new Set<Slot>();
      for (let index = 0; !detail && index < record.batchCount; index += 1) {
        const batch = record.batches[index]!;
        if (batch.heldPass !== pass) continue;
        const slot = batch.slot!;
        if (slot.owner !== batch || slot.serial !== batch.serial || slot.usedFrame !== frame || seen.has(slot)) {
          detail = `batch ${index}: its slot is not its own this frame`;
          break;
        }
        seen.add(slot);
        detail = this.compareSlot(index, slot, batches[index]!.entries);
      }
    } finally {
      for (let index = 0; index < count; index += 1) this.release(shadow[index]!);
      for (const batch of batches) batch.entries.length = 0;
    }
    if (!detail) return;
    work.mismatches += 1;
    if (work.mismatchDetails.length < MAX_MISMATCH_DETAILS) work.mismatchDetails.push(detail);
  }

  /** How `slot` differs from what a fill of `members` would write now, or null when it holds just that. */
  private compareSlot(batch: number, slot: Slot, members: readonly Entry[]): string | null {
    const { vertices, indices } = batchCounts(members);
    const layout = members[0]!.layout;
    const arrays = this.verifyArrays;
    const grown = (array: Float32Array, length: number) => (array.length >= length ? array : new Float32Array(length));
    arrays.positions = grown(arrays.positions, vertices * 3);
    arrays.worlds = grown(arrays.worlds, vertices * WORLD_FLOATS);
    arrays.styles = grown(arrays.styles, vertices * STYLE_FLOATS);
    arrays.texts = grown(arrays.texts, layout & TEXT_LAYOUT ? vertices * TEXT_FLOATS : 0);
    for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1)
      arrays.extras[kind] = layout & (1 << kind) ? grown(arrays.extras[kind] ?? new Float32Array(0), vertices * EXTRA_SIZES[kind]!) : null;
    if (arrays.indices.length < indices) arrays.indices = new Float64Array(indices);
    for (const entry of members) styleOf(entry);
    writeMembers(arrays, members);
    const subMesh = slot.mesh.subMeshes[0];
    if (slot.layout !== layout || slot.vertexCount !== vertices || slot.indexCount !== indices || subMesh?.verticesCount !== vertices || subMesh.indexCount !== indices)
      return `batch ${batch}: ${slot.vertexCount} vertices and ${slot.indexCount} indices, not ${vertices} and ${indices}`;
    const differs = (name: string, held: ArrayLike<number>, expected: ArrayLike<number>, length: number): string | null => {
      for (let index = 0; index < length; index += 1) if (held[index] !== expected[index]) return `batch ${batch}: ${name}[${index}] is ${held[index]}, not ${expected[index]}`;
      return null;
    };
    let found = differs("position", slot.positions, arrays.positions, vertices * 3) ?? differs("world", slot.worlds, arrays.worlds, vertices * WORLD_FLOATS) ??
      differs("style", slot.styles, arrays.styles, vertices * STYLE_FLOATS) ?? differs("index", slot.indices, arrays.indices, indices);
    if (!found && layout & TEXT_LAYOUT) found = differs("glyph", slot.texts, arrays.texts, vertices * TEXT_FLOATS);
    for (let kind = 0; !found && kind < EXTRA_KINDS.length; kind += 1)
      if (layout & (1 << kind)) found = differs(EXTRA_KINDS[kind]!, slot.extras[kind]!, arrays.extras[kind]!, vertices * EXTRA_SIZES[kind]!);
    return found;
  }
}

/** How the kept classification's bounds and batches differ from the full path's (`verify`), or null when they agree. */
function compareGrouping(
  kept: readonly Entry[], full: readonly Entry[], count: number, keptBatches: readonly Batch[], keptCount: number, fullBatches: readonly Batch[], fullCount: number,
): string | null {
  for (let index = 0; index < count; index += 1) {
    const a = kept[index]!, b = full[index]!;
    if (!(a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY))
      return `member ${index}: bounds ${[a.minX, a.minY, a.maxX, a.maxY].join()}, not ${[b.minX, b.minY, b.maxX, b.maxY].join()}`;
  }
  if (keptCount !== fullCount) return `${keptCount} batches, not ${fullCount}`;
  for (let index = 0; index < keptCount; index += 1) {
    const a = keptBatches[index]!.entries, b = fullBatches[index]!.entries;
    if (a.length !== b.length) return `batch ${index}: ${a.length} members, not ${b.length}`;
    for (let member = 0; member < a.length; member += 1)
      if (a[member]!.subMesh !== b[member]!.subMesh) return `batch ${index}: member ${member} is ${a[member]!.subMesh.getMesh().name}, not ${b[member]!.subMesh.getMesh().name}`;
  }
  return null;
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
 * Whether `scene`'s batches sample its shared page of small images (`layer-image-atlas.ts`); on with batching. A proof
 * turns it off to draw each batch from its members' own textures.
 */
export function setSceneImagePages(scene: Scene, enabled: boolean): void {
  const batcher = sceneDrawBatcher(scene);
  if (batcher instanceof OverlayDrawBatcher) batcher.setImagePages(enabled);
}

/** The images on `scene`'s shared page and those drawn there; zeros for a Scene that does not batch. */
export function sceneImagePages(scene: Scene): { images: number; drawn: number } {
  const batcher = sceneDrawBatcher(scene);
  return batcher instanceof OverlayDrawBatcher ? batcher.imagePages : { images: 0, drawn: 0 };
}

/** What `scene`'s batcher has done since it was made (`OverlayBatchWork`); null for a Scene that does not batch. */
export function sceneDrawBatchWork(scene: Scene): OverlayBatchWork | null {
  const batcher = sceneDrawBatcher(scene);
  return batcher instanceof OverlayDrawBatcher ? batcher.batchWork : null;
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
