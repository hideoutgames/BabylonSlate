import type { Matrix, RenderTargetTexture, Scene } from "@babylonjs/core";

/**
 * Where a shadow map's content changed: world boxes holding every caster whose drawing changed (where it was before
 * and where it is now), or everywhere. A reader that caches what shadowed surfaces look like (`ReflectedContent`)
 * redraws only when a surface it shows samples texels these boxes cover.
 */
export class ShadowChangeRegion {
  /** At most this many boxes; a further one merges into the last. */
  static readonly MAX_BOXES = 4;
  all = false;
  count = 0;
  /** `count` boxes, six numbers each: min x, y, z, max x, y, z. */
  readonly boxes = new Float64Array(ShadowChangeRegion.MAX_BOXES * 6);

  addAll(): void {
    this.all = true;
  }

  addBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): void {
    if (this.all) return;
    // Negated so a non-finite bound covers everything.
    if (!(minX <= maxX && minY <= maxY && minZ <= maxZ) || !Number.isFinite(minX + minY + minZ + maxX + maxY + maxZ)) {
      this.all = true;
      return;
    }
    const boxes = this.boxes;
    if (this.count < ShadowChangeRegion.MAX_BOXES) {
      const at = 6 * this.count++;
      boxes[at] = minX; boxes[at + 1] = minY; boxes[at + 2] = minZ;
      boxes[at + 3] = maxX; boxes[at + 4] = maxY; boxes[at + 5] = maxZ;
      return;
    }
    const at = 6 * (this.count - 1);
    boxes[at] = Math.min(boxes[at]!, minX); boxes[at + 1] = Math.min(boxes[at + 1]!, minY); boxes[at + 2] = Math.min(boxes[at + 2]!, minZ);
    boxes[at + 3] = Math.max(boxes[at + 3]!, maxX); boxes[at + 4] = Math.max(boxes[at + 4]!, maxY); boxes[at + 5] = Math.max(boxes[at + 5]!, maxZ);
  }

  addRegion(other: ShadowChangeRegion): void {
    if (other.all) this.all = true;
    const boxes = other.boxes;
    for (let i = 0; i < other.count && !this.all; i++) {
      const at = 6 * i;
      this.addBox(boxes[at]!, boxes[at + 1]!, boxes[at + 2]!, boxes[at + 3]!, boxes[at + 4]!, boxes[at + 5]!);
    }
  }

  get empty(): boolean {
    return !this.all && this.count === 0;
  }

  clear(): void {
    this.all = false;
    this.count = 0;
  }
}

/** A map's changes since its last real pass (`shadowMapChanges`). */
export interface PendingShadowChanges {
  /** Everywhere until a writer first describes the map: its first pass changes everything. */
  readonly region: ShadowChangeRegion;
  /** The refresh described the map since its last pass; a pass nothing described changes everywhere. */
  described: boolean;
  /** The last pass skipped a caster that was not ready: the next pass may change what it left out. */
  partial: boolean;
}

const pendingChanges = new WeakMap<RenderTargetTexture, PendingShadowChanges>();

/** What has changed in `map` since its last real pass, for its refresh to add to (`ShadowMapRefresh.apply`). */
export function shadowMapChanges(map: RenderTargetTexture): PendingShadowChanges {
  let pending = pendingChanges.get(map);
  if (!pending) {
    const region = new ShadowChangeRegion();
    region.addAll();
    pendingChanges.set(map, (pending = { region, described: false, partial: false }));
  }
  return pending;
}

/** A tile a map draws: the view-projection it was drawn with and how far around a point its filter reads (NDC units). */
export interface ShadowTileView {
  readonly view: Matrix;
  readonly reach: number;
}

/** One real pass of a map the Scene's surfaces sample: where it changed, in its tiles' views as drawn. */
export interface ShadowChange {
  readonly region: ShadowChangeRegion;
  /** `tiles` entries are the pass's tiles; their matrices are copies. */
  readonly views: Float64Array[];
  readonly reaches: number[];
  tiles: number;
}

/** Passes kept per Scene; a reader further behind redraws. */
const JOURNAL_LENGTH = 32;

type Journal = { entries: ShadowChange[]; sequence: number };
const journals = new WeakMap<Scene, Journal>();

function journalOf(scene: Scene): Journal {
  let journal = journals.get(scene);
  if (!journal) {
    journal = { entries: [], sequence: 0 };
    for (let i = 0; i < JOURNAL_LENGTH; i++) journal.entries.push({ region: new ShadowChangeRegion(), views: [], reaches: [], tiles: 0 });
    journals.set(scene, journal);
  }
  return journal;
}

/**
 * Records a real pass of `map` into its tiles (`views`): what changed since its last pass, everywhere when the pass or
 * the one before it skipped a caster (`partial`), or when no refresh described the map since then. Clears its pending
 * changes.
 */
export function recordShadowMapPass(scene: Scene, map: RenderTargetTexture, views: readonly ShadowTileView[], partial: boolean): void {
  const pending = shadowMapChanges(map);
  const journal = journalOf(scene);
  const entry = journal.entries[journal.sequence % JOURNAL_LENGTH]!;
  entry.region.clear();
  entry.region.addRegion(pending.region);
  if (partial || pending.partial || !pending.described) entry.region.addAll();
  entry.tiles = views.length;
  for (let i = 0; i < views.length; i++) {
    const copy = (entry.views[i] ??= new Float64Array(16));
    copy.set(views[i]!.view.m);
    entry.reaches[i] = views[i]!.reach;
  }
  journal.sequence++;
  pending.region.clear();
  pending.described = false;
  pending.partial = partial;
}

/** The Scene's journal position: every pass recorded so far. */
export function shadowChangeSequence(scene: Scene): number {
  return journals.get(scene)?.sequence ?? 0;
}

/**
 * Calls `visit` with each pass recorded after `sequence`; false (visiting none) when some of them are no longer kept.
 */
export function forEachShadowChangeSince(scene: Scene, sequence: number, visit: (change: ShadowChange) => boolean): boolean {
  const journal = journals.get(scene);
  if (!journal || journal.sequence === sequence) return true;
  if (journal.sequence - sequence > JOURNAL_LENGTH) return false;
  for (let at = sequence; at < journal.sequence; at++) if (visit(journal.entries[at % JOURNAL_LENGTH]!)) return true;
  return true;
}
