import { Buffer, VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { Material } from "@babylonjs/core/Materials/material";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Matrix } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";
import type { FloatArray, IndicesArray } from "@babylonjs/core/types";
import type { OverlayLayoutRect } from "@haptic/core";
import {
  DRAW_BATCH_COLOR_KIND, DRAW_BATCH_TEXEL_KIND, DRAW_BATCH_TEXT_KINDS, DRAW_BATCH_TINT_KIND, DRAW_BATCH_WORLD_KINDS, isBoundedMaterial, isDrawBatchMaterial,
  isDrawBatchTextMaterial, markDrawBatchMesh,
} from "./draw-batch-world-block";
import { sceneDrawBatcher, setSceneDrawBatcher, type SceneDrawBatcher } from "./draw-batching";
import { hasMeshLatticeDeformer, latticeMarksRevision } from "./lattice-deformer-binding";
import { LayerImageAtlas, type LayerImageCell } from "./layer-image-atlas";
import { disableOverlayClipScissor, enableOverlayClipScissor, overlayDrawClip } from "./overlay-layout-render";
import { overlayVisualStyle, shareOverlayVisualStyle } from "./overlay-visual-style";
import { journalFollows, openRenderChangeReader, type RenderChangeReader } from "./render-change-journal";
import { sceneReadinessRevision } from "./scene-readiness-signal";
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
 * - **Retention.** Each pass of an Engine frame (by its place among the frame's passes) keeps its members' readings,
 *   its batches and the batch meshes they filled. What changed is heard, not compared: the Scene's render change
 *   journal (`render-change-journal.ts`, with the notes Haptic's own writers add) names the members to read again, and
 *   the rest cost nothing but the list compare. Pass-wide inputs (the list, the transform, the margins, the eye, the
 *   image page's, lattice and readiness revisions) and each distinct Material and texture are polled once a pass or
 *   frame. Every `FULL_CHECK_INTERVAL`th pass, and each while verifying, the full path is worked out beside it, and a
 *   difference is healed and counted (`OverlayBatchWork`).
 *
 * Batch meshes stay out of `scene.meshes` (never culled, picked, probed or counted) and keep their buffers between
 * frames. Each is used at most once per Engine frame (WebGPU queues buffer writes ahead of the frame's draws) and
 * uploads only the buffers whose contents changed.
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

type Eye = { x: number; y: number; z: number };
type ClassifiedReason = Exclude<OverlayAloneReason, "single" | "unmatched">;

/** A member's own vertices, as its vertex buffer holds them, and its world matrix as its draw uploads it. */
interface Bake {
  copy: Float32Array;
  /** Storage for `world`. */
  rows: Float32Array;
  /** The world matrix's first three rows as the member's draw uploads them; null when it mirrors or is not affine. */
  world: Float32Array | null;
  /** Bounds of `copy`, in the member's own space. */
  min: [number, number, number];
  max: [number, number, number];
}

/** A draw of the pass: what its last reading found, its projected bounds, and where it stands with the journal. */
interface Entry {
  subMesh: SubMesh;
  /** The record whose list holds it; null for the verifier's own entries. */
  record: PassRecord | null;
  /** The mesh the journal names it by (`subMesh.getMesh()`). */
  node: AbstractMesh | null;
  /** Set when the draw may join a batch. */
  mesh: Mesh | null;
  material: Material | null;
  binding: UnlitBinding | null;
  /** Where the binding's image is on the Scene's shared page, when a batch may sample it there. */
  cell: LayerImageCell | null;
  /** A text Material's glyph: what it binds for itself. */
  text: TextMaterialBinding | null;
  clip: OverlayLayoutRect | null;
  /** `ownBake` while the draw may batch. */
  bake: Bake | null;
  ownBake: Bake;
  /** The member's vertex data of each of `EXTRA_KINDS` the batch carries, and which those are, as bits. */
  extras: Array<FloatArray | null>;
  layout: number;
  indices: IndicesArray | null;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Its batch's place in its record's batches; -1 before grouping. */
  batch: number;
  /** Why the draw goes on its own, as last read; null when it may batch. */
  alone: ClassifiedReason | null;
  /** What `sameDraw` and `drawKey` compare, as last read (`stampDraw`): a re-read that changes it regroups. */
  drawStamp: Stamp;
  /** Babylon's readiness gate's last answer for it (`drawsNow`), and whether that answer is still good. */
  ready: boolean;
  readyKnown: boolean;
  /** Whether it waits in its record's re-read list (`markDirty`). */
  queued: boolean;
  /** Whether the journal cannot hear its writes (`journalFollows`): read again every pass. */
  polled: boolean;
  /** The Material and texture it is polled through (`track`). */
  trackedMaterial: object | null;
  trackedTexture: object | null;
  /** What the member's own draw binds that a batch carries per vertex: colour with alpha, tint, texel grid (`styleOf`). */
  style: Float32Array;
  /** A glyph's own values a batch carries per vertex (`styleOf`). */
  glyph: Float32Array;
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
  /** The fill its slot holds for it; -1 when a member changed since, or its pass was grouped anew. */
  serial: number;
}

/** A pass's work kept between frames, and what it was made from pass-wide. */
interface PassRecord {
  transparent: boolean;
  sorted: SubMesh[];
  entries: Entry[];
  batches: Batch[];
  batchCount: number;
  /** Whether its entries' readings and batches hold (false: the full path). */
  grouped: boolean;
  /** Whether its list changed since its batches were made: it groups again. */
  listChanged: boolean;
  /** Members the journal named since the pass last drew. */
  dirty: Entry[];
  /** Members the journal cannot hear (`Entry.polled`). */
  polled: Entry[];
  /** Its members by why they draw on their own, and those that may batch. */
  tally: Record<ClassifiedReason, number>;
  transform: Float64Array;
  marginX: number;
  marginY: number;
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  atlas: LayerImageAtlas | null;
  atlasRevision: number;
  latticeRevision: number;
  readinessRevision: number;
  renderPassId: number;
  /** Passes since its last full check. */
  sinceCheck: number;
}

/** Values compared with those kept from the last time, each kept as it is put (`!==`: full precision, NaN differs). */
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

  /** Whether `other` holds the same values. */
  equals(other: Stamp): boolean {
    const a = this.values, b = other.values;
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
    return true;
  }
}

/**
 * How a Scene's batcher drew its passes since it was made. Members of passes that reached its retained work were
 * skipped outright (`skippedMembers`: nothing read) or read again because the journal or a poll named them
 * (`rereadMembers`); members of passes on the full path (a new list, a lost journal, a heal) count in `fullMembers`.
 * Passes kept their batches (`retainedPasses`), grouped again (`regroupedPasses`) or took the full path
 * (`fullPasses`). Every `FULL_CHECK_INTERVAL`th retained pass, and each while `verifyRetainedOverlayBatches` is on, is
 * checked against the full path (`checkedPasses`); a difference is healed and counted in `heals`, or while verifying in
 * `mismatches`, with the kinds of input missed (`missedKinds`) and the first few differences described.
 */
export interface OverlayBatchWork {
  skippedMembers: number;
  rereadMembers: number;
  fullMembers: number;
  retainedPasses: number;
  regroupedPasses: number;
  fullPasses: number;
  checkedPasses: number;
  heals: number;
  mismatches: number;
  missedKinds: string[];
  mismatchDetails: string[];
}

/** Every this many retained passes, the full path is worked out beside one and a difference healed. */
const FULL_CHECK_INTERVAL = 32;
/** Differences `OverlayBatchWork.mismatchDetails` describes, and kinds `missedKinds` names. */
const MAX_MISMATCH_DETAILS = 4;
const MAX_MISSED_KINDS = 8;

let verifies = false;

/**
 * Debugging aid: every retained pass of every frame is checked against the full path, worked out on the verifier's
 * own entries and vertex copies, before it draws: classification, readings, bounds, batches in order, readiness, and
 * what each batch mesh it would draw from without refilling holds (`OverlayBatchWork.mismatches`, healed as found).
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
  pageBinding: { -readonly [K in keyof UnlitBinding]: UnlitBinding[K] } | null;
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

const CLASSIFIED_REASONS: readonly ClassifiedReason[] = ["material", "transform", "vertexColor", "other"];

function emptyTally(): Record<ClassifiedReason, number> {
  return { material: 0, transform: 0, vertexColor: 0, other: 0 };
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
 * Reads the member's vertices and world matrix as its own draw gives them to the vertex stage into `bake`: the
 * positions its vertex buffer holds, in 32 bits, and the world matrix the floating origin uploads (translation minus the
 * eye, then 32-bit); false when it has no such positions.
 */
function bakeInto(bake: Bake, mesh: Mesh, eye: Eye): boolean {
  const source = packedFloats(mesh, VertexBuffer.PositionKind, 3);
  if (!source) return false;
  if (bake.copy.length !== source.length) bake.copy = new Float32Array(source.length);
  bake.copy.set(source);
  const { copy, min, max } = bake;
  min[0] = min[1] = min[2] = Number.POSITIVE_INFINITY;
  max[0] = max[1] = max[2] = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 2 < copy.length; index += 3) {
    const x = copy[index]!, y = copy[index + 1]!, z = copy[index + 2]!;
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }
  bake.world = worldRows(mesh.getWorldMatrix(), eye, bake.rows);
  return true;
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
function worldRows(world: Matrix, eye: Eye, rows: Float32Array): Float32Array | null {
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

function sameBounds(a: Bounds, b: Bounds): boolean {
  return a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;
}

/** What batches of one draw share, to find them quickly: the texture they sample or, untextured, their Material. */
function drawKey(entry: Entry): object {
  return entry.cell?.page ?? entry.binding?.texture ?? entry.text?.atlas ?? entry.material!;
}

function createBake(): Bake {
  return { copy: new Float32Array(0), rows: new Float32Array(WORLD_FLOATS), world: null, min: [0, 0, 0], max: [0, 0, 0] };
}

function createEntry(subMesh: SubMesh, record: PassRecord | null): Entry {
  return {
    subMesh, record, node: null, mesh: null, material: null, binding: null, cell: null, text: null, clip: null, bake: null, ownBake: createBake(),
    extras: EXTRA_KINDS.map(() => null), layout: 0, indices: null, minX: 0, minY: 0, maxX: 0, maxY: 0, batch: -1, alone: null, drawStamp: new Stamp(),
    ready: false, readyKnown: false, queued: false, polled: false, trackedMaterial: null, trackedTexture: null,
    style: new Float32Array(STYLE_FLOATS), glyph: new Float32Array(TEXT_FLOATS),
  };
}

function createBatch(): Batch {
  return { entries: [], minX: 0, minY: 0, maxX: 0, maxY: 0, previousOfKey: -1, slot: null, serial: -1 };
}

function createRecord(): PassRecord {
  return {
    transparent: false, sorted: [], entries: [], batches: [], batchCount: 0, grouped: false, listChanged: false, dirty: [], polled: [], tally: emptyTally(),
    transform: new Float64Array(16), marginX: 0, marginY: 0, eyeX: 0, eyeY: 0, eyeZ: 0, atlas: null, atlasRevision: -1, latticeRevision: -1,
    readinessRevision: -1, renderPassId: -1, sinceCheck: 0,
  };
}

/** Whether `kept` lists the first `count` of `sorted`, in order. */
function sameList(kept: readonly SubMesh[], sorted: readonly SubMesh[], count: number): boolean {
  if (kept.length !== count) return false;
  for (let index = 0; index < count; index += 1) if (kept[index] !== sorted[index]) return false;
  return true;
}

/**
 * Puts what grouping compares for `entry` into its draw stamp and says whether any of it changed since its last reading:
 * whether it may batch, and what `sameDraw` and `drawKey` compare (at full precision).
 */
function stampDraw(entry: Entry): boolean {
  const stamp = entry.drawStamp;
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

/** Whether `batch` may draw from `slot` in `frame`: not drawn from yet, and holding its fill or no kept batch's. */
function slotFree(slot: Slot, batch: Batch, frame: number): boolean {
  if (slot.usedFrame === frame) return false;
  const owner = slot.owner;
  return owner === batch || !owner || owner.slot !== slot || owner.serial !== slot.serial;
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

/** A Material or texture the batcher polls once a frame: the members reading it, and what it read of it last. */
interface Poll {
  texture: boolean;
  stamp: Stamp;
  users: Set<Entry>;
}

/** Puts what the batcher reads of a Material or texture that has no write point the journal hears. */
function pollValues(stamp: Stamp, object: object, texture: boolean): boolean {
  stamp.begin();
  if (texture) {
    const value = object as BaseTexture;
    const internal = value.getInternalTexture();
    stamp.put(value.samplingMode); stamp.put(value.wrapU); stamp.put(value.wrapV); stamp.put(value.hasAlpha);
    stamp.put(internal); stamp.put(internal?.isReady ?? false); stamp.put(keepsUvs(value));
  } else {
    const material = object as Material;
    stamp.put(material.needDepthPrePass); stamp.put(material.separateCullingPass); stamp.put(isUnlitMaterial(material));
    stamp.put(isDrawBatchMaterial(material)); stamp.put(isDrawBatchTextMaterial(material)); stamp.put(isBoundedMaterial(material));
    stamp.put(hasStockOrPlannedVertexStage(material));
  }
  return stamp.end();
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
  private fillSerial = 0;
  /** Per draw key, the pass's last batch of it (empty between `group` calls). */
  private readonly lastOfKey = new Map<object, number>();
  private readonly slots: Slot[] = [];
  private disposed = false;
  /** The Scene's render changes, and the kept entries by the mesh the journal names them by. */
  private reader: RenderChangeReader | null;
  private readonly entriesByNode = new Map<AbstractMesh, Entry[]>();
  /** A record's entries by submesh while its list changes (`setList`). */
  private readonly heldEntries = new Map<SubMesh, Entry>();
  /** Materials and textures read by kept entries, polled once an Engine frame (`pollShared`). */
  private readonly polls = new Map<object, Poll>();
  private pollFrame = -1;
  /** The pass's Scene transform and two of its viewport's pixels in NDC (`measurePass`). */
  private transform: Matrix | null = null;
  private marginX = 0;
  private marginY = 0;
  private readonly work: OverlayBatchWork = {
    skippedMembers: 0, rereadMembers: 0, fullMembers: 0, retainedPasses: 0, regroupedPasses: 0, fullPasses: 0, checkedPasses: 0, heals: 0,
    mismatches: 0, missedKinds: [], mismatchDetails: [],
  };
  /** Before a regroup, each batch whose slot holds its fill, by its first member (`regroup`). */
  private readonly keptFills = new Map<Entry, { members: Entry[]; slot: Slot; serial: number }>();
  /** The full check's own entries, batches and arrays: it never reads or writes the retained path's. */
  private readonly checkEntries: Entry[] = [];
  private readonly checkBatches: Batch[] = [];
  private checkArrays: BatchArrays = {
    positions: new Float32Array(0), extras: EXTRA_KINDS.map(() => null), worlds: new Float32Array(0), styles: new Float32Array(0), texts: new Float32Array(0),
    indices: new Float64Array(0),
  };
  private readonly scratchBounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly scratchCorner = { x: 0, y: 0, z: 0 };
  private readonly scratchGrid = [0, 0];
  private readonly scratchViewport = new Viewport(0, 0, 1, 1);
  /** The Scene's shared page of small images, which its batches sample; null while they sample their own textures. */
  private atlas: LayerImageAtlas | null;

  constructor(scene: Scene) {
    this.scene = scene;
    this.atlas = new LayerImageAtlas(scene);
    this.reader = openRenderChangeReader(scene);
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

  /** What the batcher has done since it was made (`OverlayBatchWork`), as a copy. */
  get batchWork(): OverlayBatchWork {
    return { ...this.work, missedKinds: [...this.work.missedKinds], mismatchDetails: [...this.work.mismatchDetails] };
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
    this.readChanges();
    const record = this.passRecord();
    if (record.transparent !== transparent || !sameList(record.sorted, sorted, count)) this.setList(record, sorted, count, transparent);
    const eye = scene.floatingOriginOffset;
    this.measurePass();
    try {
      if (!record.grouped) this.fullPath(record, eye);
      else {
        this.retainedPath(record, eye);
        if (verifies || ++record.sinceCheck >= FULL_CHECK_INTERVAL) {
          record.sinceCheck = 0;
          this.check(record, eye);
        }
      }
      for (const reason of CLASSIFIED_REASONS) stats.alone[reason] += record.tally[reason];
      this.drawBatches(record, transparent, drawOne, stats);
    } catch (error) {
      record.grouped = false;
      throw error;
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
    for (const record of this.records) this.dropRecord(record);
    this.records.length = 0;
    this.entriesByNode.clear();
    this.polls.clear();
    this.reader?.dispose();
    this.reader = null;
    this.checkEntries.length = 0;
    this.checkBatches.length = 0;
    this.atlas?.dispose();
    this.atlas = null;
  }

  /**
   * Reads the Scene's render changes since the last pass into the re-read lists of the records whose lists hold the
   * meshes named (a journal this reader fell behind on sends every record down the full path), and polls the Materials
   * and textures in use once an Engine frame.
   */
  private readChanges(): void {
    if (this.reader && !this.reader.drain(this.visitChange)) for (const record of this.records) record.grouped = false;
    const frame = this.scene.getEngine().frameId;
    if (frame === this.pollFrame) return;
    this.pollFrame = frame;
    for (const [object, poll] of this.polls)
      if (pollValues(poll.stamp, object, poll.texture)) for (const entry of poll.users) markDirty(entry);
  }

  private readonly visitChange = (node: Node): void => {
    const entries = this.entriesByNode.get(node as AbstractMesh);
    if (entries) for (const entry of entries) markDirty(entry);
  };

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
    return (this.records[index] ??= createRecord());
  }

  /**
   * Gives `record` another list. Members it already held keep their entries and readings (the journal kept following
   * them); new members get entries read at the pass, and the pass groups again. Another blend mode starts over.
   */
  private setList(record: PassRecord, sorted: readonly SubMesh[], count: number, transparent: boolean): void {
    const held = this.heldEntries;
    if (record.transparent === transparent) for (const entry of record.entries) held.set(entry.subMesh, entry);
    else {
      for (const entry of record.entries) this.forget(entry);
      record.grouped = false;
    }
    record.transparent = transparent;
    record.sorted.length = count;
    record.entries.length = count;
    record.polled.length = 0;
    for (let index = 0; index < count; index += 1) {
      const subMesh = sorted[index]!;
      record.sorted[index] = subMesh;
      let entry = held.get(subMesh);
      if (entry) held.delete(subMesh);
      else {
        entry = createEntry(subMesh, record);
        const node = (entry.node = subMesh.getMesh());
        let list = this.entriesByNode.get(node);
        if (!list) this.entriesByNode.set(node, (list = []));
        list.push(entry);
        entry.polled = !journalFollows(node);
        markDirty(entry);
      }
      record.entries[index] = entry;
      if (entry.polled) record.polled.push(entry);
    }
    // Members the list no longer holds.
    for (const entry of held.values()) {
      if (entry.alone) record.tally[entry.alone] -= 1;
      this.forget(entry);
    }
    held.clear();
    record.listChanged = true;
  }

  /** Takes `entry` out of the journal's index and the polls. */
  private forget(entry: Entry): void {
    const node = entry.node;
    if (node) {
      const list = this.entriesByNode.get(node);
      const at = list ? list.indexOf(entry) : -1;
      if (at >= 0) {
        list!.splice(at, 1);
        if (list!.length === 0) this.entriesByNode.delete(node);
      }
    }
    this.track(entry, null, null);
    entry.node = null;
    entry.record = null;
  }

  private dropRecord(record: PassRecord): void {
    for (const batch of record.batches) {
      if (batch.slot?.owner === batch) batch.slot.owner = null;
      batch.slot = null;
      batch.entries.length = 0;
    }
    for (const entry of record.entries) this.forget(entry);
    record.batches.length = 0;
    record.batchCount = 0;
    record.entries.length = 0;
    record.sorted.length = 0;
    record.dirty.length = 0;
    record.polled.length = 0;
    record.grouped = false;
  }

  /** Polls `material` and `texture` for `entry` from now on, in place of what it was polled through. */
  private track(entry: Entry, material: object | null, texture: object | null): void {
    if (entry.trackedMaterial !== material) {
      this.untrack(entry, entry.trackedMaterial);
      entry.trackedMaterial = material;
      this.trackOne(entry, material, false);
    }
    if (entry.trackedTexture !== texture) {
      this.untrack(entry, entry.trackedTexture);
      entry.trackedTexture = texture;
      this.trackOne(entry, texture, true);
    }
  }

  private trackOne(entry: Entry, object: object | null, texture: boolean): void {
    if (!object) return;
    let poll = this.polls.get(object);
    if (!poll) {
      poll = { texture, stamp: new Stamp(), users: new Set() };
      pollValues(poll.stamp, object, texture);
      this.polls.set(object, poll);
    }
    poll.users.add(entry);
  }

  private untrack(entry: Entry, object: object | null): void {
    if (!object) return;
    const poll = this.polls.get(object);
    if (!poll) return;
    poll.users.delete(entry);
    if (poll.users.size === 0) this.polls.delete(object);
  }

  private release(entry: Entry): void {
    entry.mesh = null; entry.material = null; entry.binding = null; entry.cell = null; entry.text = null; entry.clip = null; entry.bake = null; entry.indices = null;
    entry.extras.fill(null);
    entry.layout = 0;
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

  /** Reads `entry` anew for the record (classification, polls, readiness to ask) and keeps its tally. */
  private reread(record: PassRecord, entry: Entry, eye: Eye): void {
    const was = entry.alone;
    const alone = (entry.alone = this.classify(entry, eye));
    if (was) record.tally[was] -= 1;
    if (alone) record.tally[alone] += 1;
    this.track(entry, entry.subMesh.getMaterial(), entry.binding?.texture ?? entry.text?.atlas ?? null);
    entry.readyKnown = false;
  }

  /** Reads every member anew and groups the pass: what a new list, a lost journal or a heal takes. */
  private fullPath(record: PassRecord, eye: Eye): void {
    const entries = record.entries, count = entries.length;
    record.tally = emptyTally();
    for (const entry of entries) {
      entry.alone = null;
      this.reread(record, entry, eye);
      stampDraw(entry);
      entry.queued = false;
    }
    record.dirty.length = 0;
    record.listChanged = false;
    for (let index = 0; index < record.batchCount; index += 1) record.batches[index]!.entries.length = 0;
    record.batchCount = this.group(entries, count, record.batches, true);
    for (const batch of record.batches) batch.serial = -1;
    this.keepPassInputs(record, eye);
    record.grouped = true;
    record.sinceCheck = 0;
    this.work.fullPasses += 1;
    this.work.fullMembers += count;
  }

  /** What the pass's grouping and readings were made from pass-wide, kept to tell a change. */
  private keepPassInputs(record: PassRecord, eye: Eye): void {
    record.transform.set(this.transform!.asArray());
    record.marginX = this.marginX; record.marginY = this.marginY;
    record.eyeX = eye.x; record.eyeY = eye.y; record.eyeZ = eye.z;
    record.atlas = this.atlas;
    record.atlasRevision = this.atlas?.revision ?? -1;
    record.latticeRevision = latticeMarksRevision();
    record.readinessRevision = sceneReadinessRevision(this.scene);
    record.renderPassId = this.scene.getEngine().currentRenderPassId;
  }

  /**
   * The retained path: members nothing named keep everything they had. A pass-wide change reads what it touches for
   * every member (the eye or the image page's or lattice state: every reading; the transform or margins: every bound;
   * the readiness revision: every readiness answer). Each member the journal or a poll named is read anew: a change in
   * what grouping compares, or in its bounds, groups the pass again; anything else refills its batch alone.
   */
  private retainedPath(record: PassRecord, eye: Eye): void {
    const entries = record.entries, count = entries.length, batches = record.batches;
    const transform = this.transform!.asArray();
    let moved = this.marginX !== record.marginX || this.marginY !== record.marginY;
    for (let index = 0; !moved && index < 16; index += 1) if (transform[index] !== record.transform[index]) moved = true;
    const all = eye.x !== record.eyeX || eye.y !== record.eyeY || eye.z !== record.eyeZ || this.atlas !== record.atlas ||
      (this.atlas?.revision ?? -1) !== record.atlasRevision || latticeMarksRevision() !== record.latticeRevision;
    // A readiness answer, and the Effect it leaves on the submesh, is the render pass's own.
    if (sceneReadinessRevision(this.scene) !== record.readinessRevision || this.scene.getEngine().currentRenderPassId !== record.renderPassId)
      for (const entry of entries) entry.readyKnown = false;
    for (const entry of record.polled) markDirty(entry);
    const reread = all ? entries : record.dirty;
    let regroup = moved || record.listChanged;
    record.listChanged = false;
    let rereadCount = 0;
    for (const entry of reread) {
      entry.queued = false;
      // One the list let go of since it was named.
      if (entry.record !== record) continue;
      rereadCount += 1;
      // Its batch's slot no longer holds what a fill would write for it.
      if (entry.batch >= 0 && entry.batch < record.batchCount) batches[entry.batch]!.serial = -1;
      this.reread(record, entry, eye);
      if (stampDraw(entry)) regroup = true;
      if (!moved) {
        const before = this.scratchBounds;
        before.minX = entry.minX; before.minY = entry.minY; before.maxX = entry.maxX; before.maxY = entry.maxY;
        this.bound(entry, this.transform!, this.marginX, this.marginY);
        if (!sameBounds(before, entry)) regroup = true;
      }
    }
    if (!all) record.dirty.length = 0;
    else {
      for (const entry of entries) entry.queued = false;
      record.dirty.length = 0;
    }
    if (regroup) this.regroup(record, count, moved);
    this.keepPassInputs(record, eye);
    this.work.rereadMembers += rereadCount;
    this.work.skippedMembers += count - rereadCount;
    if (regroup) this.work.regroupedPasses += 1;
    else this.work.retainedPasses += 1;
  }

  /**
   * Groups the record's pass anew (with every bound anew when `bound`, else with the bounds its members have, which
   * re-read members have just had made). A new batch of exactly a kept batch's members, in order, whose slot still holds
   * their fill takes that slot over: what a slot holds is a function of its members' values in order alone.
   */
  private regroup(record: PassRecord, count: number, bound: boolean): void {
    const kept = this.keptFills;
    const batches = record.batches;
    for (let index = 0; index < record.batchCount; index += 1) {
      const batch = batches[index]!, slot = batch.slot;
      if (slot && batch.serial >= 0 && slot.owner === batch && slot.serial === batch.serial)
        kept.set(batch.entries[0]!, { members: [...batch.entries], slot, serial: batch.serial });
    }
    try {
      for (let index = 0; index < record.batchCount; index += 1) batches[index]!.entries.length = 0;
      record.batchCount = this.group(record.entries, count, batches, bound);
      for (const batch of batches) batch.serial = -1;
      for (let index = 0; kept.size > 0 && index < record.batchCount; index += 1) {
        const batch = batches[index]!, members = batch.entries;
        const fill = kept.get(members[0]!);
        if (!fill || fill.members.length !== members.length || fill.members.some((entry, at) => entry !== members[at])) continue;
        batch.slot = fill.slot;
        batch.serial = fill.serial;
        fill.slot.owner = batch;
      }
    } finally {
      kept.clear();
    }
  }

  /** Fills `entry` for a draw that may batch and returns null; otherwise why it draws on its own. */
  private classify(entry: Entry, eye: Eye): ClassifiedReason | null {
    const subMesh = entry.subMesh;
    const mesh = subMesh.getMesh();
    const material = subMesh.getMaterial();
    // What the last reading found goes: a draw that goes on its own carries none of it.
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
    const bake = entry.ownBake;
    if (!bakeInto(bake, mesh, eye)) return "other";
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
   * overlaps (so it still draws after every draw it covers), else a new batch at the end. Bounds every draw first when
   * `bound`, else uses the bounds each has.
   */
  private group(entries: readonly Entry[], count: number, batches: Batch[], bound: boolean): number {
    const transform = this.transform!, marginX = this.marginX, marginY = this.marginY;
    const lastOfKey = this.lastOfKey;
    lastOfKey.clear();
    let used = 0;
    for (let index = 0; index < count; index += 1) {
      const entry = entries[index]!;
      if (bound) this.bound(entry, transform, marginX, marginY);
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

  /** Babylon's readiness gate's answer for `entry`, kept while nothing named it and the readiness revision stands. */
  private ready(entry: Entry): boolean {
    if (!entry.readyKnown || !entry.ready) {
      entry.ready = drawsNow(entry);
      entry.readyKnown = true;
    }
    return entry.ready;
  }

  private drawBatches(record: PassRecord, transparent: boolean, drawOne: (subMesh: SubMesh) => void, stats: OverlayBatchStats): void {
    for (let index = 0; index < record.batchCount; index += 1) {
      const batch = record.batches[index]!;
      const members = batch.entries;
      // A member whose own draw would not draw now (Babylon's readiness gate) leaves its batch's members to their own.
      if (members.length > 1 && this.allReady(members) && this.drawBatch(batch, transparent)) {
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

  private allReady(members: readonly Entry[]): boolean {
    for (let index = 0; index < members.length; index += 1) if (!this.ready(members[index]!)) return false;
    return true;
  }

  /** Draws `batch` as one; false (nothing drawn) when its mesh is not ready with its members' program's batch variant. */
  private drawBatch(batch: Batch, transparent: boolean): boolean {
    const scene = this.scene;
    const members = batch.entries;
    const first = members[0]!;
    const member = first.mesh!;
    const slot = this.slotFor(batch, first.layout);
    batch.slot = slot;
    const mesh = slot.mesh;
    // Set only where they differ: the batch mesh's own writes note it in the Scene's journal.
    if (mesh.material !== first.material) mesh.material = first.material;
    if (first.binding) {
      const binding = first.cell ? pageBinding(slot, first.binding, first.cell.page) : first.binding;
      if (unlitBinding(mesh) !== binding) setUnlitBinding(mesh, binding);
    } else {
      if (first.text && textMaterialGlyphBinding(mesh) !== first.text) bindTextMaterialGlyph(mesh, first.text);
      if (mesh.receiveShadows !== member.receiveShadows) mesh.receiveShadows = member.receiveShadows;
    }
    shareOverlayVisualStyle(mesh, member);
    if (mesh.visibility !== member.visibility) mesh.visibility = member.visibility;
    if (mesh.sideOrientation !== member.sideOrientation) mesh.sideOrientation = member.sideOrientation;
    if (!(slot.owner === batch && slot.serial === batch.serial)) {
      // Owned by no batch until the fill is whole.
      slot.owner = null;
      for (const entry of members) styleOf(entry);
      this.fill(slot, members);
      slot.owner = batch;
      slot.serial = batch.serial = ++this.fillSerial;
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
   * A batch mesh for `batch` not yet drawn from in this Engine frame: the one it drew from last, else one that holds no
   * kept batch's fill, else a new one (out of the Scene's lists), so the pool grows to the batches kept. A batch mesh
   * draws once per Engine frame: WebGPU writes buffers ahead of the frame's draws, so a second write would show in both.
   */
  private slotFor(batch: Batch, layout: number): Slot {
    const frame = this.scene.getEngine().frameId;
    let slot = batch.slot;
    if (!slot || !slotFree(slot, batch, frame)) {
      slot = null;
      for (const candidate of this.slots) {
        if (slotFree(candidate, batch, frame)) {
          slot = candidate;
          break;
        }
      }
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
    slot.vertexCount = vertexCount;
    slot.indexCount = indexCount;
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
    subMesh.verticesCount = vertexCount;
    subMesh.indexStart = 0;
    subMesh.indexCount = indexCount;
  }

  /**
   * Works the full path out beside the retained pass about to draw, on the check's own entries and arrays: the same
   * classification and readings, bounds, batches in order, readiness answers, and, for each batch about to draw from a
   * slot without refilling it, what the slot holds. A difference is counted (in `mismatches` while verifying, else in
   * `heals`) with the kind of input missed, and healed: the pass takes the full path before it draws.
   */
  private check(record: PassRecord, eye: Eye): void {
    const work = this.work;
    work.checkedPasses += 1;
    let kind: string | null = null, detail = "";
    const miss = (found: string, described: string) => {
      if (kind) return;
      kind = found;
      detail = described;
    };
    const kept = record.entries, count = kept.length, shadow = this.checkEntries, batches = this.checkBatches;
    try {
      for (let index = 0; index < count; index += 1) {
        const entry = (shadow[index] ??= createEntry(record.sorted[index]!, null));
        entry.subMesh = record.sorted[index]!;
        entry.alone = this.classify(entry, eye);
        if (!kind) {
          const found = differs(kept[index]!, entry);
          if (found) miss(found, `member ${index} (${entry.subMesh.getMesh().name}): ${found}`);
        }
      }
      if (!kind) {
        const used = this.group(shadow, count, batches, true);
        for (let index = 0; !kind && index < count; index += 1)
          if (!sameBounds(kept[index]!, shadow[index]!)) miss("bounds", `member ${index} (${kept[index]!.subMesh.getMesh().name}): bounds`);
        if (!kind && used !== record.batchCount) miss("batches", `${record.batchCount} batches, not ${used}`);
        for (let index = 0; !kind && index < used; index += 1) {
          const a = record.batches[index]!.entries, b = batches[index]!.entries;
          if (a.length !== b.length || a.some((entry, at) => entry.subMesh !== b[at]!.subMesh)) miss("batches", `batch ${index}: other members`);
        }
      }
      for (let index = 0; !kind && index < record.batchCount; index += 1) {
        const batch = record.batches[index]!, members = batch.entries;
        if (members.length < 2) continue;
        // Asking the gate rewrites the submesh's Effect: an answer that changes, or an Effect that does, was missed.
        // A member found not ready is asked again every pass anyway.
        for (const entry of members) {
          if (!entry.readyKnown || !entry.ready) continue;
          const effect = entry.subMesh.effect, answer = entry.ready;
          const now = drawsNow(entry);
          if (now !== answer || entry.subMesh.effect !== effect) {
            miss("readiness", `member ${entry.subMesh.getMesh().name}: readiness`);
            break;
          }
        }
        const slot = batch.slot;
        if (!kind && slot && batch.serial >= 0 && slot.owner === batch && slot.serial === batch.serial) {
          const found = this.compareSlot(slot, batches[index]!.entries);
          if (found) miss(found, `batch ${index}: ${found}`);
        }
      }
    } finally {
      for (let index = 0; index < count; index += 1) this.release(shadow[index]!);
      for (const batch of batches) batch.entries.length = 0;
    }
    if (!kind) return;
    if (verifies) work.mismatches += 1;
    else work.heals += 1;
    if (!work.missedKinds.includes(kind) && work.missedKinds.length < MAX_MISSED_KINDS) work.missedKinds.push(kind);
    if (work.mismatchDetails.length < MAX_MISMATCH_DETAILS) work.mismatchDetails.push(detail);
    this.fullPath(record, eye);
  }

  /** Which of `slot`'s arrays differ from what a fill of `members` would write now, or null when it holds just that. */
  private compareSlot(slot: Slot, members: readonly Entry[]): string | null {
    const { vertices, indices } = batchCounts(members);
    const layout = members[0]!.layout;
    const arrays = this.checkArrays;
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
      return "counts";
    const differ = (held: ArrayLike<number>, expected: ArrayLike<number>, length: number): boolean => {
      for (let index = 0; index < length; index += 1) if (held[index] !== expected[index]) return true;
      return false;
    };
    if (differ(slot.positions, arrays.positions, vertices * 3)) return "positions";
    if (differ(slot.worlds, arrays.worlds, vertices * WORLD_FLOATS)) return "world";
    if (differ(slot.styles, arrays.styles, vertices * STYLE_FLOATS)) return "style";
    if (differ(slot.indices, arrays.indices, indices)) return "indices";
    if (layout & TEXT_LAYOUT && differ(slot.texts, arrays.texts, vertices * TEXT_FLOATS)) return "glyph";
    for (let kind = 0; kind < EXTRA_KINDS.length; kind += 1)
      if (layout & (1 << kind) && differ(slot.extras[kind]!, arrays.extras[kind]!, vertices * EXTRA_SIZES[kind]!)) return EXTRA_KINDS[kind]!;
    return null;
  }
}

/** Marks `entry` to be read again at its record's next pass. */
function markDirty(entry: Entry): void {
  const record = entry.record;
  if (!record || entry.queued) return;
  entry.queued = true;
  record.dirty.push(entry);
}

/** Which reading of a kept member differs from the full path's (`fresh`), or null when none does. */
function differs(kept: Entry, fresh: Entry): string | null {
  if (kept.alone !== fresh.alone || kept.mesh !== fresh.mesh) return "classification";
  if (!fresh.mesh) return null;
  if (kept.material !== fresh.material) return "material";
  if (kept.binding !== fresh.binding) return "binding";
  if (kept.cell !== fresh.cell) return "cell";
  if (kept.text !== fresh.text) return "glyphBinding";
  if (!sameClip(kept.clip, fresh.clip)) return "clip";
  if (kept.layout !== fresh.layout || kept.indices !== fresh.indices || kept.extras.some((data, kind) => data !== fresh.extras[kind])) return "vertexData";
  const a = kept.bake!, b = fresh.bake!;
  if (a.copy.length !== b.copy.length || a.copy.some((value, index) => value !== b.copy[index])) return "positions";
  for (let index = 0; index < WORLD_FLOATS; index += 1) if (a.world![index] !== b.world![index]) return "transform";
  // What `sameDraw` compares now, against what the kept grouping compared.
  stampDraw(fresh);
  if (!kept.drawStamp.equals(fresh.drawStamp)) return "drawValues";
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
