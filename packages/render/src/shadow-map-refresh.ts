import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { Material } from "@babylonjs/core/Materials/material";
import { Matrix, type Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Geometry } from "@babylonjs/core/Meshes/geometry";
import { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { AtlasCascadedShadowGenerator, shadowTileSize } from "./shadow-atlas";
import { castsIntoCascade } from "./shadow-caster-size";
import { canCacheShadowMaterial, canCacheShadowMaterialFor, canCacheShadowMesh } from "./shadow-material-policy";
import { hasRevisionTrackedCableGeometry } from "./cable-mesh";
import { hasRevisionTrackedDynamicMesh } from "./dynamic-runtime-mesh";
import { hasRevisionTrackedLandscapeGeometry } from "./landscape-mesh";
import { geometryRevision, unwatchGeometry, watchGeometry } from "./geometry-revision";
import { hasMeshLatticeDeformer } from "./lattice-deformer-binding";
import { isAutoLodMaster, peekAutoLodLevel } from "./model-lod";
import { geometryBufferLayout, journalFollows, openRenderChangeReader, RenderChange, verifiesRenderChangeJournal, type RenderChangeReader } from "./render-change-journal";
import { shadowMapChanges, type ShadowChangeRegion } from "./shadow-change-journal";
import { casterWithinShadowRange, hasDeformingShadowBounds } from "./shadow-mesh-policy";

/** Reused scalar/object snapshot; unchanged frames allocate no signature arrays. */
class Snapshot {
  private readonly values: unknown[] = [];
  private cursor = 0;
  changed = false;
  /** The index of the first value that changed, or -1. */
  first = -1;
  begin(): void {
    this.cursor = 0;
    this.changed = false;
    this.first = -1;
  }
  value(value: unknown): void {
    if (!Object.is(this.values[this.cursor], value) && !this.changed) {
      this.changed = true;
      this.first = this.cursor;
    }
    this.values[this.cursor++] = value;
  }
  /** Replaces one value of the last read, as a read that found only it changed would have left it. */
  rewrite(index: number, value: unknown): void {
    this.values[index] = value;
  }
  end(): void {
    if (this.values.length !== this.cursor && !this.changed) {
      this.changed = true;
      this.first = Math.min(this.values.length, this.cursor);
    }
    this.values.length = this.cursor;
  }
}

/** What each value of a caster's own snapshot is (`ShadowMapRefresh.walkCaster`), to name what a journal walk missed. */
const CASTER_VALUES = ["transform", "enabled", "isVisible", "visibility", "source", "material", "materialState", "safeMaterial", "safeMesh"];

/**
 * Every this many frames the full walk follows the journal's: a change the journal missed is found within that many
 * frames and counted (`ShadowJournalDiagnostics.heals`), never kept for good.
 */
const FULL_WALK_INTERVAL = 32;

/** At most this many names of missed kinds are kept (`ShadowJournalDiagnostics.missedKinds`). */
const MAX_MISSED_KINDS = 8;

/** How the caster walks went, counted since the refresh was made (`ShadowMapRefresh.journalDiagnostics`). */
export interface ShadowJournalDiagnostics {
  /** Journal walks: one per caster walk. */
  walks: number;
  /** Casters those walks held, summed: what the full scan would have walked. */
  casters: number;
  /** Casters those walks walked in full (`walkCaster`), summed. */
  visited: number;
  /** Casters whose only change those walks found was their world matrix, which they read alone (`moveCaster`), summed. */
  moved: number;
  /** Source meshes and Materials those walks polled (once each per walk), summed. */
  polledSources: number;
  polledMaterials: number;
  /** Source polls that found a change (their casters walked in full), summed. */
  sourceChanges: number;
  /** Reads of a Material's part of `canCacheShadowMaterial` (at most two per Material and walk), summed. */
  cacheChecks: number;
  /** Reads of which of a geometry's buffers are updatable (only after its buffers were replaced), summed. */
  bufferChecks: number;
  /** Full walks run after a journal walk: every `FULL_WALK_INTERVAL`th one, or each while verifying. */
  fullWalks: number;
  /** Casters a periodic full walk found changed after the journal walk: a missed change, healed. */
  heals: number;
  /** The same, found while verifying (`verifyRenderChangeJournal`): every frame is checked. */
  mismatches: number;
  /** The first distinct kinds of state missed (a caster snapshot value, `flags` or `lodLevel`). */
  missedKinds: string[];
}

/** Cascade transform matrices (4 x 16) of a cascaded map's last actual pass. */
type DrawnFit = { matrices: Float64Array; valid: boolean };

type Caster = {
  readonly mesh: AbstractMesh;
  /**
   * The mesh whose geometry, parts and Material it draws, as its last walk found it: itself, or an instance's source
   * (which an instance pool can reassign).
   */
  source: AbstractMesh;
  readonly instance: boolean;
  /**
   * Whether the change journal hears its visibility, enabled and Material writes (`journalFollows`): one whose class
   * redefines them is walked every frame.
   */
  readonly followed: boolean;
  snapshot: Snapshot;
  /** What its last walk read of what it shares, and of what a journal walk polls for it each frame. */
  sourceShared: SourceState | null;
  materialShared: MaterialState | null;
  billboard: number;
  infinite: boolean;
  autoLod: boolean;
  lattice: boolean;
  /** Visible with automatic levels of detail: the level the camera draws is read every walk (`lodLevels`). */
  lod: boolean;
  /**
   * The walk that found it among the casters, the walk that must walk it, and the walk that found only its world
   * matrix changed (`moveCaster`).
   */
  seen: number;
  dirty: number;
  moved: number;
  geometry: Geometry | null;
  world: Matrix | null;
  worldFlag: number;
  worldValue: Matrix;
  transformRevision: number;
  /** Bumped whenever this caster's shadow-relevant state changes. */
  revision: number;
  /** Its mesh and Material draw what its static geometry holds, so a tracked state change is the only way its shadow changes. */
  safe: boolean;
  /** Visible content whose shadow can change without a tracked state change: shown, and not `safe`. */
  unsafe: boolean;
  /** Its geometry draws within its bounds (twice its radius when it deforms): `safeMesh`, its thin instances aside. */
  bounded: boolean;
  /** As the walk found it: enabled and visible, so a map layer may list it (`ShadowCasterList.prepare`). */
  shown: boolean;
};

/**
 * What casters share, read once per walk however many of them share it: a revision that moves with any value the walk
 * follows there (never one another record held), and the walk that last read it.
 */
type Shared = {
  snapshot: Snapshot; revision: number; walk: number;
  /** The walk whose poll found it changed (its casters are walked then), and the last walk a caster used it. */
  changed: number; used: number;
};

/** A source mesh's part of its casters' state: its own, and each instance's. */
type SourceState = {
  /** As `Shared`: a revision no other record held, moved by any change of what its read compares. */
  revision: number; walk: number; changed: number; used: number;
  /** Whether it was read yet: the first read is a change. */
  read: boolean;
  /** What its last read found, compared field by field (`ShadowMapRefresh.sourceState`). */
  geometry: Geometry | null;
  watchRevision: number | undefined;
  sideOrientation: number | undefined;
  skeleton: unknown;
  morphTargetManager: unknown;
  /** Its thin-instance count, or -1 without thin instances; then its buffers and its user buffers in key order. */
  thinCount: number;
  thinMatrix: unknown;
  thinPrevious: unknown;
  readonly thinUser: unknown[];
  parts: unknown;
  /** Each part, and its five ranges and Material index. */
  readonly partObjects: unknown[];
  readonly partNumbers: number[];
  /** Its geometry is static and it has no render hook: a caster's `safeMesh`, what the caster itself decides aside. */
  rigid: boolean;
  levels: boolean;
  thin: boolean;
  /** `canCacheShadowMaterial(material, source)`. */
  material: Material;
  safeMaterial: boolean;
};

/** A Material's record: its depth and culling read, and its part of `canCacheShadowMaterial` for the walk. */
type MaterialState = Shared & {
  /** The walk `opaque` and `vertexAlpha` were found in: `canCacheShadowMaterialFor`, without and with vertex alpha. */
  gateWalk: number;
  opaque: boolean | undefined;
  vertexAlpha: boolean | undefined;
};

/** Which of a geometry's buffers can be rewritten in place, as found at its buffer layout `layout`. */
type GeometryState = { layout: number; indices: boolean; vertices: boolean; verticesBesidesPose: boolean };

/** A caster as a map last saw it: what it drew and where (`ShadowMapRefresh.note`). */
type SeenCaster = { revision: number; level: number | undefined; stamp: number; bounded: boolean; readonly box: Float64Array };

/**
 * Whether a world sphere may touch the light-space rectangle of one cascade (its transform matrix, with the world
 * scales of its x and y axes at `2 * cascade` of `scales`). Depth is ignored: casters toward the light are clamped
 * into the map.
 */
function reachesCascadeRectangle(
  m: ArrayLike<number>,
  scales: Float64Array,
  cascade: number,
  center: Vector3,
  radius: number,
): boolean {
  const x = center.x * m[0]! + center.y * m[4]! + center.z * m[8]! + m[12]!;
  const y = center.x * m[1]! + center.y * m[5]! + center.z * m[9]! + m[13]!;
  // Negated so a non-finite value stays inside, never wrongly outside.
  return !(Math.abs(x) > 1 + radius * scales[2 * cascade]! || Math.abs(y) > 1 + radius * scales[2 * cascade + 1]!);
}

/**
 * Whether a world sphere may touch the light-space rectangle of any cascade
 * (given as transform matrices with the world scale of their x and y axes).
 */
function reachesCascade(
  matrices: readonly ArrayLike<number>[],
  scales: Float64Array,
  center: Vector3,
  radius: number,
): boolean {
  for (let cascade = 0; cascade < matrices.length; cascade++)
    if (reachesCascadeRectangle(matrices[cascade]!, scales, cascade, center, radius)) return true;
  return false;
}

/**
 * Whether a caster's bounding sphere reaches a cascade that draws it: the first whatever its size, a later one when it
 * is not too small for its texels (`castsIntoCascade`, the caster list's own test). Run per caster and cascade each
 * frame, so it allocates nothing.
 */
function drawnIntoCascade(
  matrices: readonly ArrayLike<number>[],
  scales: Float64Array,
  center: Vector3,
  radius: number,
  sizes: readonly number[],
  minTexels: number,
): boolean {
  if (!minTexels) return reachesCascade(matrices, scales, center, radius);
  for (let cascade = 0; cascade < matrices.length; cascade++)
    if (reachesCascadeRectangle(matrices[cascade]!, scales, cascade, center, radius) &&
      (cascade === 0 || castsIntoCascade(matrices[cascade]!, radius, sizes[cascade]!, minTexels))) return true;
  return false;
}

function addSeen(entry: SeenCaster, region: ShadowChangeRegion): void {
  const box = entry.box;
  if (entry.bounded) region.addBox(box[0]!, box[1]!, box[2]!, box[3]!, box[4]!, box[5]!);
  else region.addAll();
}

/**
 * Per-map invalidation for shadow maps with static opaque content. A local map
 * tracks only casters within its light's range: elsewhere a caster cannot
 * reach the map, whose depth range ends at that range. A cascaded sun map
 * tracks the camera, the light and its own cascade settings, and only the
 * casters that can reach a cascade's light-space rectangle. A single-map sun
 * (custom projection) is always drawn.
 */
export class ShadowMapRefresh {
  private readonly casters = new Map<AbstractMesh, Caster>();
  /** Per source mesh, Material and geometry a caster of the last walk used (`Shared`). */
  private readonly sources = new Map<AbstractMesh, SourceState>();
  private readonly materials = new Map<Material, MaterialState>();
  private readonly geometries = new WeakMap<Geometry, GeometryState>();
  private walk = 0;
  /** The casters of the walk running, in the order the controller lists them. */
  private readonly order: Caster[] = [];
  /** The Scene's change journal, as this refresh reads it (`render-change-journal.ts`). */
  private reader: RenderChangeReader | null = null;
  private readerScene: Scene | null = null;
  /** The Scene's default Material the last walk gave a caster without one; a replacement walks every caster. */
  private defaultMaterial: Material | null = null;
  /** Journal walks since the last full walk. */
  private sinceFull = 0;
  /** Scratch for a full walk after a journal walk: each automatic-LOD caster's level as the journal walk found it. */
  private readonly lodCheck = new Map<AbstractMesh, number>();
  private readonly stats: ShadowJournalDiagnostics = {
    walks: 0, casters: 0, visited: 0, moved: 0, polledSources: 0, polledMaterials: 0, sourceChanges: 0, cacheChecks: 0,
    bufferChecks: 0, fullWalks: 0, heals: 0, mismatches: 0, missedKinds: [],
  };
  private sharedRevision = 0;
  /** Scratch for the cascaded map being applied: transform matrices, then x/y axis scales per cascade. */
  private readonly cascadeMatrices: ArrayLike<number>[] = [];
  private readonly cascadeScales = new Float64Array(8);
  /** Scratch for the cascaded map being applied: each cascade's tile edge in texels. */
  private readonly cascadeSizes: number[] = [];
  private readonly drawnFits = new WeakMap<RenderTargetTexture, DrawnFit>();
  private readonly maps = new WeakMap<ShadowGenerator, Snapshot>();
  /** Per map, its casters as last applied, for the change journal's regions (`shadowMapChanges`). */
  private readonly seen = new WeakMap<RenderTargetTexture, Map<AbstractMesh, SeenCaster>>();
  private stamp = 0;
  private readonly box = new Float64Array(6);
  /** Drawn level of each visible automatic-LOD caster for the scene camera. */
  private readonly lodLevels = new Map<AbstractMesh, number>();
  private readonly sceneState = new Snapshot();
  private revision = 0;
  private continuous = false;

  private readonly casterChanged: ((mesh: AbstractMesh) => void) | undefined;

  /** `casterChanged` hears of each caster whose shadow-relevant state a walk found changed. */
  constructor(casterChanged?: (mesh: AbstractMesh) => void) {
    this.casterChanged = casterChanged;
  }

  /**
   * What the last walk found of a caster: a revision that moves with anything its shadow depends on, and whether its
   * mesh and Material draw what its static geometry holds (`safe`), shown or hidden. Undefined before its first walk.
   */
  casterState(mesh: AbstractMesh): { readonly revision: number; readonly safe: boolean; readonly shown: boolean; readonly world: Matrix | null } | undefined {
    return this.casters.get(mesh);
  }

  /**
   * The part of a walk that cannot wait for a map: it releases removed casters
   * so they are not retained. Snapshots of the others stay, so a later walk
   * reports only what changed in between.
   */
  dropRemovedCasters(meshes: ReadonlySet<AbstractMesh>, walks = false): void {
    this.lodLevels.clear();
    // Removed casters leave each map's in-range list, which refreshes that map.
    for (const [mesh, record] of this.casters) {
      if (meshes.has(mesh)) continue;
      if (record.geometry) unwatchGeometry(record.geometry);
      this.casters.delete(mesh);
    }
    if (walks) return;
    // A walk drops the sources and Materials its casters left; without one, a disposed source or a Material no caster
    // holds is not kept.
    for (const source of this.sources.keys()) if (source.isDisposed()) this.sources.delete(source);
    // Only walks add Materials, so the first call after one sweeps them.
    if (!this.reader) return;
    const held = new Set<MaterialState>();
    for (const record of this.casters.values()) if (record.materialShared) held.add(record.materialShared);
    for (const [material, shared] of this.materials) if (!held.has(shared)) this.materials.delete(material);
    // Nothing drains the journal until a walk: it stops recording, and the next walk reads every caster.
    this.reader.dispose();
    this.reader = this.readerScene = null;
  }

  /** How the caster walks went (`ShadowJournalDiagnostics`); a copy. */
  journalDiagnostics(): ShadowJournalDiagnostics {
    return { ...this.stats, missedKinds: [...this.stats.missedKinds] };
  }

  /**
   * The frame's caster walk. It walks (`walkCaster`, the one reading of what a caster's shadow depends on) only the
   * casters something may have changed since their last walk, as the Scene's change journal and a few polls tell:
   * - its world matrix: every caster is asked for it (`computeWorldMatrix`), because Babylon recomputes a child of a
   *   moved ancestor only when asked, and its matrix object or `updateFlag` is compared (a frozen matrix an owner
   *   rewrites in place has no other write point);
   * - enabled, visibility and Material writes, its own or an ancestor's: the journal (`render-change-journal.ts`);
   * - billboard mode, infinite distance, an instance's lattice cage and the automatic-LOD masters: read per caster,
   *   each one field or lookup, none with a write point;
   * - what it shares: each distinct source mesh and Material in use is polled once (`sourceState`, `materialState`),
   *   since parts, thin-instance buffers, levels of detail, render observers, buffer updatability and Material depth,
   *   culling and transparency state have no write point; a change walks every caster using it;
   * - a new caster, a replaced default Material, or a journal this reader fell behind on: every caster.
   * Every `FULL_WALK_INTERVAL`th walk, and each while verifying (`verifyRenderChangeJournal`), the full walk follows and
   * counts what it still found changed (`journalDiagnostics`).
   */
  syncCasters(scene: Scene, meshes: ReadonlySet<AbstractMesh>): void {
    this.walkCasters(scene, meshes, true);
    const verifying = verifiesRenderChangeJournal();
    if (verifying || ++this.sinceFull >= FULL_WALK_INTERVAL) {
      this.sinceFull = 0;
      this.stats.fullWalks++;
      const missed = this.walkCasters(scene, meshes, false);
      if (verifying) this.stats.mismatches += missed;
      else this.stats.heals += missed;
    }
    this.syncScene(scene);
  }

  private readerFor(scene: Scene): { reader: RenderChangeReader; fresh: boolean } {
    if (this.reader && this.readerScene === scene) return { reader: this.reader, fresh: false };
    this.reader?.dispose();
    // Not transforms or geometry: asking every caster for its world matrix, and polling each source, already finds them.
    this.reader = openRenderChangeReader(scene, RenderChange.Visibility | RenderChange.Enabled | RenderChange.Material | RenderChange.Other);
    this.readerScene = scene;
    return { reader: this.reader, fresh: true };
  }

  private noteMissed(kind: string): void {
    const kinds = this.stats.missedKinds;
    if (kinds.length < MAX_MISSED_KINDS && !kinds.includes(kind)) kinds.push(kind);
  }

  /**
   * One walk over `meshes`: a journal walk (`journal`) walks the casters something may have changed, a full walk every
   * caster. A full walk returns how many casters it found changed: after a journal walk of the same frame, each is one
   * that walk missed.
   */
  private walkCasters(scene: Scene, meshes: ReadonlySet<AbstractMesh>, journal: boolean): number {
    const walk = ++this.walk;
    const stats = this.stats;
    // The levels as the journal walk left them, to compare.
    const lodCheck = this.lodCheck;
    lodCheck.clear();
    if (!journal) for (const [mesh, level] of this.lodLevels) lodCheck.set(mesh, level);
    this.lodLevels.clear();
    let everything = !journal;
    if (journal) {
      const { reader, fresh } = this.readerFor(scene);
      if (fresh) everything = true;
      // Walks that give a caster the new default note it again.
      if (this.defaultMaterial && (scene as unknown as { _defaultMaterial: Material | null })._defaultMaterial !== this.defaultMaterial) {
        this.defaultMaterial = null;
        everything = true;
      }
      if (!everything) {
        // Materials first: a source's poll reads its Material for this walk (`materialGate`), after which a read here
        // would find nothing new.
        for (const [material, shared] of this.materials) {
          const revision = shared.revision;
          this.materialState(material, walk);
          if (shared.revision !== revision) shared.changed = walk;
        }
        for (const [source, shared] of this.sources) this.pollSource(scene, source, shared, walk);
        stats.polledSources += this.sources.size;
        stats.polledMaterials += this.materials.size;
      }
      stats.walks++;
      stats.casters += meshes.size;
      // Asking every caster for its world matrix below notes recomputed ones; the drain after it reads those too.
      this.collect(meshes, walk, everything);
      if (!reader.drain((node) => {
        const record = this.casters.get(node as AbstractMesh);
        if (record) record.dirty = walk;
      })) everything = true;
    } else this.collect(meshes, walk, true);
    let visited = 0, moved = 0, missed = 0;
    for (const record of this.order) {
      const mesh = record.mesh;
      if (!everything && record.dirty !== walk) {
        if (record.moved === walk) {
          this.moveCaster(record);
          moved++;
        }
        if (record.lod) this.lodLevels.set(mesh, peekAutoLodLevel(mesh, scene.activeCamera) ?? 0);
        continue;
      }
      visited++;
      if (journal) {
        this.walkCaster(scene, record, walk);
        continue;
      }
      const revision = record.revision;
      const flags = +record.shown | (+record.safe << 1) | (+record.unsafe << 2) | (+record.bounded << 3);
      const first = this.walkCaster(scene, record, walk);
      let kind: string | null = null;
      if (record.revision !== revision) kind = CASTER_VALUES[first] ?? "transform";
      else if (flags !== (+record.shown | (+record.safe << 1) | (+record.unsafe << 2) | (+record.bounded << 3))) kind = "flags";
      else if (lodCheck.get(mesh) !== this.lodLevels.get(mesh)) kind = "lodLevel";
      if (kind) {
        missed++;
        this.noteMissed(kind);
      }
    }
    if (journal) {
      stats.visited += visited;
      stats.moved += moved;
    }
    // Sources and Materials no caster uses any more.
    if (this.sources.size > meshes.size || walk % 64 === 0)
      for (const [source, shared] of this.sources) if (shared.used !== walk) this.sources.delete(source);
    if (this.materials.size > meshes.size || walk % 64 === 0)
      for (const [material, shared] of this.materials) if (shared.used !== walk) this.materials.delete(material);
    return missed;
  }

  /**
   * Lists the walk's casters in order (new ones made) and asks each for its world matrix, marking the casters a poll
   * finds changed (`syncCasters`); drops the casters `meshes` no longer holds.
   */
  private collect(meshes: ReadonlySet<AbstractMesh>, walk: number, everything: boolean): void {
    const order = this.order;
    order.length = 0;
    const before = this.casters.size;
    let kept = 0;
    for (const mesh of meshes) {
      let record = this.casters.get(mesh);
      if (record) kept++;
      else {
        const instance = mesh instanceof InstancedMesh;
        record = {
          mesh,
          source: instance ? mesh.sourceMesh : mesh,
          instance,
          followed: journalFollows(mesh),
          snapshot: new Snapshot(),
          sourceShared: null,
          materialShared: null,
          billboard: 0,
          infinite: false,
          autoLod: false,
          lattice: false,
          lod: false,
          seen: 0,
          dirty: walk,
          moved: 0,
          geometry: null,
          world: null,
          worldFlag: -1,
          worldValue: Matrix.Identity(),
          transformRevision: 0,
          revision: 0,
          safe: false,
          unsafe: false,
          bounded: false,
          shown: false,
        };
        this.casters.set(mesh, record);
      }
      record.seen = walk;
      order.push(record);
      const world = mesh.computeWorldMatrix();
      if (record.sourceShared) record.sourceShared.used = walk;
      if (record.materialShared) record.materialShared.used = walk;
      if (everything || record.dirty === walk) continue;
      if (
        !record.followed ||
        record.sourceShared!.changed === walk ||
        record.materialShared!.changed === walk ||
        mesh.billboardMode !== record.billboard ||
        mesh.infiniteDistance !== record.infinite ||
        isAutoLodMaster(mesh) !== record.autoLod ||
        (record.instance &&
          ((mesh as InstancedMesh).sourceMesh !== record.source || hasMeshLatticeDeformer(mesh) !== record.lattice))
      )
        record.dirty = walk;
      // Only its world matrix: unless the journal, drained next, names it too, it reads that alone (`moveCaster`).
      else if (world !== record.world || world.updateFlag !== record.worldFlag) record.moved = walk;
    }
    if (kept === before) return;
    // Removed casters leave each map's in-range list, which refreshes that map.
    for (const [mesh, record] of this.casters) {
      if (record.seen === walk) continue;
      if (record.geometry) unwatchGeometry(record.geometry);
      this.casters.delete(mesh);
    }
  }

  /**
   * Polls a source mesh a caster used (`sourceState`): a change of its read, or of what it derives, walks every caster
   * drawing it. A source that has another geometry is left to those casters' walks, which watch it first.
   */
  private pollSource(scene: Scene, source: AbstractMesh, shared: SourceState, walk: number): void {
    const geometry = source instanceof Mesh ? source.geometry : null;
    if (geometry !== shared.geometry) {
      shared.changed = walk;
      return;
    }
    const { revision, rigid, levels, thin, material, safeMaterial } = shared;
    this.sourceState(source, geometry, source.material ?? scene.defaultMaterial, walk);
    if (
      shared.revision !== revision || shared.rigid !== rigid || shared.levels !== levels || shared.thin !== thin ||
      shared.material !== material || shared.safeMaterial !== safeMaterial
    ) {
      shared.changed = walk;
      this.stats.sourceChanges++;
    }
  }

  /**
   * `walkCaster` for a caster whose only observed change is its world matrix (`collect`): everything else the full read
   * would find is vouched for this walk. Its enabled state, `isVisible`, `visibility` and Material have no write the
   * journal did not hear (`followed`); its source's and Material's records were polled this walk and found unchanged
   * (else `collect` marked it), so its shared revisions, `safeMaterial`, `safeMesh` and `bounded` are what its last read
   * found; billboard mode, infinite distance, lattice cage, LOD mastery and an instance's source were compared in
   * `collect`. A move changes only its transform revision, the snapshot's first value: the result is the full read's.
   */
  private moveCaster(record: Caster): void {
    const world = record.mesh.computeWorldMatrix();
    const moved = !world.equals(record.worldValue);
    record.worldValue.copyFrom(world);
    record.world = world;
    record.worldFlag = world.updateFlag;
    if (!moved) return;
    record.snapshot.rewrite(0, ++record.transformRevision);
    record.revision++;
    this.casterChanged?.(record.mesh);
  }

  /**
   * Reads everything a caster's shadow depends on into its snapshot: a change bumps its revision. Returns the index of
   * the first value that changed (`CASTER_VALUES`), or -1.
   */
  private walkCaster(scene: Scene, record: Caster, walk: number): number {
    const mesh = record.mesh;
    // An instance draws its source's geometry, sub-meshes and material at its own world matrix: its shadow content is
    // its source's, posed and shown by the instance itself.
    const source = record.instance ? (mesh as InstancedMesh).sourceMesh : mesh;
    record.source = source;
    const geometry = source instanceof Mesh ? source.geometry : null;
    if (record.geometry !== geometry) {
      if (record.geometry) unwatchGeometry(record.geometry);
      record.geometry = geometry;
      if (geometry) watchGeometry(geometry);
    }
    const ownMaterial = mesh.material;
    const material = ownMaterial ?? scene.defaultMaterial;
    if (!ownMaterial) this.defaultMaterial = material;
    // What the caster shares with others is read once per walk: its source's part and its Material's.
    const shared = this.sourceState(source, geometry, material, walk);
    const materialShared = this.materialState(material, walk);
    shared.used = materialShared.used = walk;
    record.sourceShared = shared;
    record.materialShared = materialShared;
    const state = record.snapshot;
    state.begin();
    // freezeWorldMatrix(matrix), used by bone attachments, can replace/update
    // a frozen matrix without firing onAfterWorldMatrixUpdateObservable.
    const world = mesh.computeWorldMatrix();
    if (world !== record.world || world.updateFlag !== record.worldFlag) {
      if (!world.equals(record.worldValue)) record.transformRevision++;
      record.worldValue.copyFrom(world);
      record.world = world;
      record.worldFlag = world.updateFlag;
    }
    state.value(record.transformRevision);
    const enabled = mesh.isEnabled();
    state.value(enabled);
    state.value(mesh.isVisible);
    state.value(mesh.visibility);
    state.value(shared.revision);
    state.value(material);
    state.value(materialShared.revision);
    // An instance caches as its source does (`canCacheShadowMaterial`), unless a cage deforms the instance itself.
    const lattice = record.instance && hasMeshLatticeDeformer(mesh);
    const safeMaterial = shared.material !== material
      ? canCacheShadowMaterial(material, mesh)
      : shared.safeMaterial && !lattice;
    state.value(safeMaterial);
    // Automatic LOD levels are immutable index buffers that mirror this
    // mesh's material. Only maps that can see this caster track its level.
    const autoLod = isAutoLodMaster(mesh);
    // An instance of a mesh with levels of detail draws the level its source selects: it keeps refreshing.
    const safeMesh =
      shared.rigid &&
      !mesh.infiniteDistance &&
      mesh.billboardMode === Mesh.BILLBOARDMODE_NONE &&
      (source === mesh ? autoLod || !shared.levels : !shared.levels);
    state.value(safeMesh);
    state.end();
    if (state.changed) {
      record.revision++;
      this.casterChanged?.(mesh);
    }
    record.shown = enabled && mesh.isVisible;
    const visible = record.shown && mesh.visibility > 0;
    record.safe = safeMesh && safeMaterial;
    record.unsafe = visible && !record.safe;
    // Babylon's bounds leave thin instances out unless refreshed for them.
    record.bounded = safeMesh && !shared.thin;
    record.billboard = mesh.billboardMode;
    record.infinite = mesh.infiniteDistance;
    record.autoLod = autoLod;
    record.lattice = lattice;
    record.lod = visible && autoLod;
    if (record.lod) this.lodLevels.set(mesh, peekAutoLodLevel(mesh, scene.activeCamera) ?? 0);
    return state.first;
  }

  /** The Scene's own part of every map's state. */
  private syncScene(scene: Scene): void {
    const state = this.sceneState;
    state.begin();
    // Not the floating origin: a shadow pass offsets the casters and the light's view alike, so the depth it draws is
    // the same, and the light block applies the current origin to the views it samples with each frame.
    state.value(scene.activeCamera);
    state.value(scene.forceWireframe);
    state.value(scene.forcePointsCloud);
    state.value(scene.useRightHandedSystem);
    state.end();
    this.continuous = !!(
      scene.clipPlane ||
      scene.clipPlane2 ||
      scene.clipPlane3 ||
      scene.clipPlane4 ||
      scene.clipPlane5 ||
      scene.clipPlane6
    );
    if (state.changed) this.revision++;
  }

  /** Ends a shared record's read: a change gives it a revision no record held before. */
  private read(shared: Shared, walk: number): void {
    shared.snapshot.end();
    if (shared.snapshot.changed) shared.revision = ++this.sharedRevision;
    shared.walk = walk;
  }

  /** The depth and culling state of a Material, the same for every caster that draws with it. */
  private materialState(material: Material, walk: number): MaterialState {
    let shared = this.materials.get(material);
    if (!shared) {
      shared = { snapshot: new Snapshot(), revision: 0, walk: 0, changed: 0, used: 0, gateWalk: 0, opaque: undefined, vertexAlpha: undefined };
      this.materials.set(material, shared);
    }
    if (shared.walk === walk) return shared;
    const state = shared.snapshot;
    state.begin();
    state.value(material.alpha);
    state.value(material.fillMode);
    state.value(material.backFaceCulling);
    state.value(material.cullBackFaces);
    state.value(material.sideOrientation);
    state.value(material.zOffset);
    state.value(material.zOffsetUnits);
    state.value(material.depthFunction);
    state.value(material.disableDepthWrite);
    state.value(material.forceDepthWrite);
    state.value(material.useLogarithmicDepth);
    state.value(material.needDepthPrePass);
    state.value(material.pointSize);
    state.value(material.shadowDepthWrapper);
    state.value(material.metadata?.boundsPadding);
    this.read(shared, walk);
    return shared;
  }

  /**
   * Which of a geometry's buffers are updatable, read again only after its buffers were replaced or removed
   * (`geometryBufferLayout`, Babylon's write points for them): a buffer's updatability is fixed when it is made.
   */
  private geometryState(geometry: Geometry): GeometryState {
    const layout = geometryBufferLayout(geometry);
    let shared = this.geometries.get(geometry);
    if (shared?.layout === layout) return shared;
    if (!shared) this.geometries.set(geometry, (shared = { layout, indices: true, vertices: false, verticesBesidesPose: false }));
    shared.layout = layout;
    this.stats.bufferChecks++;
    // Babylon 9.29 has no public index-mutability getter. updateIndices skips
    // onGeometryUpdated for an existing dynamic buffer, including GPU-only
    // updates, so only the known immutable state is eligible for caching.
    shared.indices = Reflect.get(geometry, "_indexBufferIsUpdatable") !== false;
    shared.vertices = shared.verticesBesidesPose = false;
    const buffers = geometry.getVertexBuffers();
    if (buffers)
      for (const kind in buffers) {
        if (!buffers[kind]?.isUpdatable()) continue;
        shared.vertices = true;
        if (kind !== VertexBuffer.PositionKind && kind !== VertexBuffer.NormalKind) shared.verticesBesidesPose = true;
      }
    return shared;
  }

  /**
   * The part of a caster's state that is its source mesh's (the caster itself, or the mesh an instance draws): its
   * geometry, parts, deformers and thin instances, and whether `material` caches for it.
   */
  private sourceState(source: AbstractMesh, geometry: Geometry | null, material: Material, walk: number): SourceState {
    let shared = this.sources.get(source);
    if (!shared) {
      shared = {
        revision: 0, walk: 0, changed: 0, used: 0, read: false, geometry,
        watchRevision: undefined, sideOrientation: undefined, skeleton: null, morphTargetManager: null,
        thinCount: -1, thinMatrix: null, thinPrevious: null, thinUser: [], parts: undefined, partObjects: [], partNumbers: [],
        rigid: false, levels: false, thin: false, material, safeMaterial: false,
      };
      this.sources.set(source, shared);
    }
    if (shared.walk === walk) return shared;
    shared.walk = walk;
    // Each value is compared with the last read's in place, then kept: no list is built per read.
    let changed = !shared.read;
    shared.read = true;
    if (shared.geometry !== geometry) changed = true;
    shared.geometry = geometry;
    // Null once another owner replaced the shared update hook: updates are no longer counted.
    const geometryWatch = geometry ? geometryRevision(geometry) : null;
    const watchRevision = geometryWatch?.revision;
    if (shared.watchRevision !== watchRevision) changed = true;
    shared.watchRevision = watchRevision;
    const mesh = source instanceof Mesh ? source : null;
    const sideOrientation = mesh ? mesh.sideOrientation : undefined;
    if (shared.sideOrientation !== sideOrientation) changed = true;
    shared.sideOrientation = sideOrientation;
    if (shared.skeleton !== source.skeleton) changed = true;
    shared.skeleton = source.skeleton;
    if (shared.morphTargetManager !== source.morphTargetManager) changed = true;
    shared.morphTargetManager = source.morphTargetManager;
    // Static thin instances (`hasStaticThinInstances`) change only by a new buffer or count.
    shared.thin = !!mesh && mesh.hasThinInstances;
    if (mesh && shared.thin) {
      const thin = mesh._thinInstanceDataStorage;
      if (shared.thinCount !== thin.instancesCount || shared.thinMatrix !== thin.matrixBuffer || shared.thinPrevious !== thin.previousMatrixBuffer)
        changed = true;
      shared.thinCount = thin.instancesCount;
      shared.thinMatrix = thin.matrixBuffer;
      shared.thinPrevious = thin.previousMatrixBuffer;
      // Rare: only meshes with their own per-instance attributes have any.
      const user = mesh._userThinInstanceBuffersStorage?.vertexBuffers;
      const held = shared.thinUser;
      let count = 0;
      if (user)
        for (const kind in user) {
          if (held[count] !== user[kind]) changed = true;
          held[count++] = user[kind];
        }
      if (held.length !== count) changed = true;
      held.length = count;
    } else {
      if (shared.thinCount !== -1) changed = true;
      shared.thinCount = -1;
      shared.thinMatrix = shared.thinPrevious = null;
      shared.thinUser.length = 0;
    }
    // An instance draws its source's parts, not its own copies of them. Babylon leaves them unset on empty model and
    // tilemap roots until geometry creates their first SubMesh; the later populated list is followed.
    const parts = source.subMeshes;
    if (shared.parts !== parts) changed = true;
    shared.parts = parts;
    const objects = shared.partObjects, numbers = shared.partNumbers;
    const count = parts ? parts.length : 0;
    if (objects.length !== count) {
      changed = true;
      objects.length = count;
      numbers.length = 5 * count;
    }
    for (let index = 0; index < count; index++) {
      const part = parts![index]!, at = 5 * index;
      if (
        objects[index] !== part || numbers[at] !== part.indexStart || numbers[at + 1] !== part.indexCount ||
        numbers[at + 2] !== part.verticesStart || numbers[at + 3] !== part.verticesCount || numbers[at + 4] !== part.materialIndex
      ) {
        changed = true;
        objects[index] = part;
        numbers[at] = part.indexStart;
        numbers[at + 1] = part.indexCount;
        numbers[at + 2] = part.verticesStart;
        numbers[at + 3] = part.verticesCount;
        numbers[at + 4] = part.materialIndex;
      }
    }
    // A landscape chunk's updatable buffers change only through notified vertex updates, never its indices.
    const trackedDynamic = !!mesh && (hasRevisionTrackedDynamicMesh(mesh) || hasRevisionTrackedLandscapeGeometry(mesh));
    const trackedCable = !!mesh && hasRevisionTrackedCableGeometry(mesh);
    const buffers = geometry ? this.geometryState(geometry) : null;
    // A mesh with neither geometry nor parts (an empty root or volume) draws nothing; parts without geometry stay unknown.
    const dynamicGeometry = !trackedDynamic &&
      (buffers ? buffers.indices || (trackedCable ? buffers.verticesBesidesPose : buffers.vertices) : !!parts?.length);
    shared.levels = !!mesh && mesh.getLODLevels().length > 0;
    shared.rigid =
      !!mesh &&
      !dynamicGeometry &&
      !mesh.onBeforeRenderObservable.hasObservers() &&
      !mesh.onBeforeDrawObservable.hasObservers() &&
      (!geometry || geometryWatch !== null);
    shared.material = material;
    // `canCacheShadowMaterial(material, source)`, its Material's part read once per walk for every source drawing it.
    shared.safeMaterial = canCacheShadowMesh(source) && this.materialGate(material, source.hasVertexAlpha, walk);
    if (changed) shared.revision = ++this.sharedRevision;
    return shared;
  }

  /** `canCacheShadowMaterialFor(material, hasVertexAlpha)`, read at most once per walk for each value of `hasVertexAlpha`. */
  private materialGate(material: Material, hasVertexAlpha: boolean, walk: number): boolean {
    const shared = this.materialState(material, walk);
    if (shared.gateWalk !== walk) {
      shared.gateWalk = walk;
      shared.opaque = shared.vertexAlpha = undefined;
    }
    let gate = hasVertexAlpha ? shared.vertexAlpha : shared.opaque;
    if (gate === undefined) {
      gate = canCacheShadowMaterialFor(material, hasVertexAlpha);
      this.stats.cacheChecks++;
      if (hasVertexAlpha) shared.vertexAlpha = gate;
      else shared.opaque = gate;
    }
    return gate;
  }

  apply(generator: ShadowGenerator): void {
    const map = generator.getShadowMap();
    if (!map) return;
    const light = generator.getLight();
    const scene = light.getScene();
    let state = this.maps.get(generator);
    if (!state) {
      state = new Snapshot();
      this.maps.set(generator, state);
    }
    state.begin();
    state.value(map);
    state.value(this.revision);
    light.parent?.computeWorldMatrix(true);
    const transformed = light.computeTransformedInformation();
    const position = transformed ? light.transformedPosition! : light.position;
    // Cube face axes are fixed; PointLight.getShadowDirection allocates a vector.
    const direction = light.needCube() ? null : light.getShadowDirection(0);
    state.value(position.x);
    state.value(position.y);
    state.value(position.z);
    state.value(direction?.x);
    state.value(direction?.y);
    state.value(direction?.z);
    state.value(light.getDepthMinZ(scene.activeCamera));
    state.value(light.getDepthMaxZ(scene.activeCamera));
    // Scalar projection/filter changes retain the allocation but change its texels.
    state.value(light.range);
    state.value("angle" in light ? light.angle : undefined);
    state.value(
      "shadowAngleScale" in light ? light.shadowAngleScale : undefined,
    );
    state.value("shadowAngle" in light ? light.shadowAngle : undefined);
    state.value(generator.bias);
    state.value(generator.normalBias);
    state.value(generator.filter);
    state.value(generator.filteringQuality);
    state.value(generator.contactHardeningLightSizeUVRatio);
    state.value(generator.forceBackFacesOnly);
    state.value(generator.transparencyShadow);
    state.value(generator.enableSoftTransparentShadow);
    state.value(generator.useOpacityTextureForTransparentShadow);
    const cascadedSun = generator instanceof CascadedShadowGenerator ? generator : null;
    // What changed where, until the map's next real pass: everywhere for its view, settings or an unbounded caster;
    // else where the casters that changed, entered, left or keep changing on their own were and are.
    const changes = shadowMapChanges(map);
    changes.described = true;
    const region = changes.region;
    const seen = this.seenCasters(map);
    this.stamp++;
    let continuous: boolean =
      this.continuous ||
      (light instanceof DirectionalLight && !cascadedSun) ||
      !!light.customProjectionMatrixBuilder ||
      !!generator.customShaderOptions;
    if (continuous) {
      region.addAll();
    } else if (cascadedSun) {
      continuous = this.trackCascades(cascadedSun, map, state, seen, region);
    } else {
      if (state.changed) region.addAll();
      // A local map re-renders once when a caster within its range changes,
      // enters or leaves, or changes the level the camera draws; unrelated
      // casters elsewhere in the scene do not touch it.
      const range = "range" in light && Number.isFinite(light.range) ? light.range : Infinity;
      for (const [mesh, record] of this.casters) {
        if (!casterWithinShadowRange(mesh, position, range)) continue;
        const level = this.lodLevels.get(mesh);
        this.note(seen, mesh, record, level, region);
        if (record.unsafe) continuous = true;
        state.value(mesh);
        state.value(record.revision);
        if (level !== undefined) state.value(level);
      }
    }
    this.sweepSeen(seen, region);
    state.end();
    const rate = continuous
      ? RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME
      : RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    if (map.refreshRate !== rate) map.refreshRate = rate;
    else if (!continuous && state.changed) map.resetRefreshCounter();
    // No completion observer: readiness probes also emit onAfterUnbind without
    // drawing. Babylon consumes the refresh only at its real target-render gate,
    // and retries automatically when a caster's shader is not ready.
  }

  /**
   * Records what a cascaded sun map is fitted and drawn from, and reports
   * whether content that changes without a tracked state change reaches it.
   *
   * Babylon refits the cascades whenever the map binds, a readiness probe
   * (possibly another camera's) included, and the receivers then use that fit.
   * So the snapshot holds what a fresh fit depends on and a render must follow:
   * the camera's view and projection, the cascade settings and, from the
   * caller, the light direction. Separately, the fit the generator holds must be
   * the one of the pass that drew the retained depth: a probe that refit it
   * differently marks the snapshot changed. The casters follow the local-map
   * rule: one that cannot reach any cascade's light-space rectangle is not drawn
   * into the map. Deforming geometry is drawn whatever its bounds, so it
   * reaches within the shadow distance of the camera as well.
   */
  private trackCascades(
    generator: CascadedShadowGenerator, map: RenderTargetTexture, state: Snapshot, seen: Map<AbstractMesh, SeenCaster>, region: ShadowChangeRegion,
  ): boolean {
    const camera: Camera | null = generator.camera ?? generator.getLight().getScene().activeCamera;
    const view = camera?.getViewMatrix().m;
    const projection = camera?.getProjectionMatrix().m;
    for (let index = 0; index < 16; index++) {
      state.value(view?.[index]);
      state.value(projection?.[index]);
    }
    state.value(generator.numCascades);
    state.value(generator.lambda);
    state.value(generator.shadowMaxZ);
    state.value(generator.stabilizeCascades);
    state.value(generator.depthClamp);
    const minTexels = generator instanceof AtlasCascadedShadowGenerator ? generator.farCasterMinTexels : 0;
    state.value(minTexels);
    const sizes = this.cascadeSizes;
    for (let cascade = 0; cascade < generator.numCascades; cascade++) sizes[cascade] = shadowTileSize(generator, cascade);
    // The held fit places each cascade for the reach test. It is stale only
    // after a camera or light change, which renders the map this frame anyway.
    const drawn = this.drawnFit(generator, map);
    let refit = !drawn.valid;
    const matrices = this.cascadeMatrices;
    matrices.length = 0;
    for (let cascade = 0; cascade < generator.numCascades; cascade++) {
      const m = generator.getCascadeTransformMatrix(cascade)?.m;
      if (!m) {
        // No fit to test against: every caster may reach.
        matrices.length = 0;
        refit = true;
        break;
      }
      for (let index = 0; index < 16; index++) if (drawn.matrices[16 * cascade + index] !== m[index]) refit = true;
      this.cascadeScales[2 * cascade] = Math.hypot(m[0]!, m[4]!, m[8]!);
      this.cascadeScales[2 * cascade + 1] = Math.hypot(m[1]!, m[5]!, m[9]!);
      matrices.push(m);
    }
    if (refit) state.changed = true;
    // A changed fit, camera, light or setting redraws every cascade differently.
    if (state.changed) region.addAll();
    let continuous = false;
    const eye = camera?.globalPosition;
    const orthographic = camera?.mode === Camera.ORTHOGRAPHIC_CAMERA;
    for (const [mesh, record] of this.casters) {
      if (matrices.length) {
        const sphere = mesh.getBoundingInfo().boundingSphere;
        const center = sphere.centerWorld;
        const radius = sphere.radiusWorld;
        if (!drawnIntoCascade(matrices, this.cascadeScales, center, radius, sizes, minTexels)) {
          // Deforming geometry is drawn into the cascades whatever its bounds: no
          // plane culls it, and its skin can leave its bind-pose bounds anywhere.
          // So a visible one within the shadow distance of the camera (or near a
          // rectangle) reaches; any other caster out of reach is not drawn.
          if (!record.unsafe || !hasDeformingShadowBounds(mesh)) continue;
          if (!reachesCascade(matrices, this.cascadeScales, center, 2 * radius) && eye && !orthographic) {
            const limit = generator.shadowMaxZ + 2 * radius;
            const dx = center.x - eye.x;
            const dy = center.y - eye.y;
            const dz = center.z - eye.z;
            // Not negated: a non-finite distance reaches.
            if (dx * dx + dy * dy + dz * dz > limit * limit) continue;
          }
        }
      }
      const level = this.lodLevels.get(mesh);
      this.note(seen, mesh, record, level, region);
      if (record.unsafe) continuous = true;
      state.value(mesh);
      state.value(record.revision);
      if (level !== undefined) state.value(level);
    }
    return continuous;
  }

  private seenCasters(map: RenderTargetTexture): Map<AbstractMesh, SeenCaster> {
    let seen = this.seen.get(map);
    if (!seen) this.seen.set(map, (seen = new Map()));
    return seen;
  }

  /**
   * Where `mesh` draws into a map, into `box`; false when that cannot be bounded. A deforming caster can leave its
   * bind-pose bounds, so it gets twice its bounding radius (as `casterWithinShadowRange`).
   */
  private casterBox(mesh: AbstractMesh, record: Caster, box: Float64Array): boolean {
    if (!record.bounded) return false;
    const info = mesh.getBoundingInfo();
    if (hasDeformingShadowBounds(mesh)) {
      const center = info.boundingSphere.centerWorld, radius = 2 * info.boundingSphere.radiusWorld;
      box[0] = center.x - radius; box[1] = center.y - radius; box[2] = center.z - radius;
      box[3] = center.x + radius; box[4] = center.y + radius; box[5] = center.z + radius;
    } else {
      const min = info.boundingBox.minimumWorld, max = info.boundingBox.maximumWorld;
      box[0] = min.x; box[1] = min.y; box[2] = min.z;
      box[3] = max.x; box[4] = max.y; box[5] = max.z;
    }
    return true;
  }

  /**
   * Notes a caster a map draws: when it entered, changed or changes on its own, the map changed where it was and where
   * it is now (everywhere for an unbounded one).
   */
  private note(seen: Map<AbstractMesh, SeenCaster>, mesh: AbstractMesh, record: Caster, level: number | undefined, region: ShadowChangeRegion): void {
    const box = this.box;
    const bounded = this.casterBox(mesh, record, box);
    let entry = seen.get(mesh);
    if (!entry || record.unsafe || entry.revision !== record.revision || entry.level !== level) {
      if (entry) addSeen(entry, region);
      if (bounded) region.addBox(box[0]!, box[1]!, box[2]!, box[3]!, box[4]!, box[5]!);
      else region.addAll();
    }
    if (!entry) seen.set(mesh, (entry = { revision: 0, level: undefined, stamp: 0, bounded: false, box: new Float64Array(6) }));
    entry.revision = record.revision;
    entry.level = level;
    entry.stamp = this.stamp;
    entry.bounded = bounded;
    entry.box.set(box);
  }

  /** Casters the map no longer draws (removed, out of range or reach) changed it where they were. */
  private sweepSeen(seen: Map<AbstractMesh, SeenCaster>, region: ShadowChangeRegion): void {
    for (const [mesh, entry] of seen) {
      if (entry.stamp === this.stamp) continue;
      addSeen(entry, region);
      seen.delete(mesh);
    }
  }

  /** The cascade matrices of the map's last actual pass, kept by a clear observer. */
  private drawnFit(generator: CascadedShadowGenerator, map: RenderTargetTexture): DrawnFit {
    const existing = this.drawnFits.get(map);
    if (existing) return existing;
    const fit: DrawnFit = { matrices: new Float64Array(16 * 4), valid: false };
    this.drawnFits.set(map, fit);
    // Only an actual pass clears (probes emit the other render events), and the
    // map refit its cascades for that pass before it did.
    map.onClearObservable.add(() => {
      for (let cascade = 0; cascade < generator.numCascades; cascade++) {
        const m = generator.getCascadeTransformMatrix(cascade)?.m;
        if (m) for (let index = 0; index < 16; index++) fit.matrices[16 * cascade + index] = m[index]!;
      }
      fit.valid = true;
    });
    return fit;
  }

  dispose(): void {
    for (const record of this.casters.values())
      if (record.geometry) unwatchGeometry(record.geometry);
    this.casters.clear();
    this.sources.clear();
    this.materials.clear();
    this.lodLevels.clear();
    this.reader?.dispose();
    this.reader = this.readerScene = null;
  }
}
