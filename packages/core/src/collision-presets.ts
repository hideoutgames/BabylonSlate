/**
 * Project Collision Presets: named collision setups (a Layer and a response
 * to every layer: Ignore, Overlap or Block) that colliders reference by
 * preset id; a collider without one uses `default`. A collider whose
 * `collisionPreset` is `custom`, or names a deleted preset, keeps its own
 * `layer`, `mask` and `overlapMask`.
 *
 * Responses are two masks: `mask` holds the layers it blocks, `overlapMask`
 * the layers it overlaps; a layer in neither is ignored. A pair takes the
 * weaker of its two responses (`collisionPairResponse`).
 */

export const MAX_COLLISION_PRESETS = 64;
export const CUSTOM_COLLISION_PRESET = "custom";
export const DEFAULT_COLLISION_PRESET_ID = "default";

export interface CollisionPreset {
  /** Stable reference stored on components; renaming a preset keeps it. */
  id: string;
  name: string;
  /** One layer bit, as a component's `layer`. */
  layer: number;
  /** Layers it blocks, as a component's `mask`. */
  mask: number;
  /** Layers it overlaps (events, no blocking), as a component's `overlapMask`. */
  overlapMask: number;
}

export type CollisionResponse = "ignore" | "overlap" | "block";

/** A collider's layer and its two response masks. */
export interface CollisionFilter {
  layer: number;
  mask: number;
  overlapMask: number;
}

const ALL_LAYERS = 0xffffffff;

export const DEFAULT_COLLISION_PRESETS: readonly CollisionPreset[] = [
  { id: DEFAULT_COLLISION_PRESET_ID, name: "Default", layer: 1, mask: ALL_LAYERS, overlapMask: 0 },
];

const bits = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isInteger(value) ? value >>> 0 : fallback;

/** Unique ids and names, unsigned masks, at least one preset. */
export function normalizeCollisionPresets(value: unknown): CollisionPreset[] {
  const presets: CollisionPreset[] = [];
  const ids = new Set<string>();
  for (const entry of Array.isArray(value) ? value : []) {
    if (presets.length >= MAX_COLLISION_PRESETS || !entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const id = typeof source.id === "string" ? source.id.trim() : "";
    if (!id || id === CUSTOM_COLLISION_PRESET || ids.has(id)) continue;
    ids.add(id);
    const name = typeof source.name === "string" && source.name.trim() ? source.name.trim() : id;
    const mask = bits(source.mask, ALL_LAYERS);
    presets.push({ id, name, layer: bits(source.layer, 1) || 1, mask, overlapMask: (bits(source.overlapMask, 0) & ~mask) >>> 0 });
  }
  return presets.length > 0 ? presets : DEFAULT_COLLISION_PRESETS.map((preset) => ({ ...preset }));
}

/** A component's preset reference: a preset id or `custom`; the Default preset when missing. */
export function parseCollisionPresetRef(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_COLLISION_PRESET_ID;
}

/** The preset a reference names, if it still exists. */
export function findCollisionPreset(
  presets: readonly Pick<CollisionPreset, "id" | "layer" | "mask" | "overlapMask">[] | undefined,
  ref: unknown,
): Pick<CollisionPreset, "id" | "layer" | "mask" | "overlapMask"> | undefined {
  const id = parseCollisionPresetRef(ref);
  return id === CUSTOM_COLLISION_PRESET ? undefined : presets?.find((preset) => preset.id === id);
}

/** The filter a collider uses: its preset's, or its own when Custom or the preset is gone. */
export function resolveCollisionFilter(
  own: CollisionFilter,
  ref: unknown,
  presets: readonly Pick<CollisionPreset, "id" | "layer" | "mask" | "overlapMask">[] | undefined,
): CollisionFilter {
  const source = findCollisionPreset(presets, ref) ?? own;
  const mask = source.mask >>> 0;
  return { layer: source.layer, mask, overlapMask: (source.overlapMask & ~mask) >>> 0 };
}

/** One side's response to a layer bit set. */
export function collisionResponseTo(filter: Pick<CollisionFilter, "mask" | "overlapMask">, layer: number): CollisionResponse {
  if ((filter.mask & layer) !== 0) return "block";
  return (filter.overlapMask & layer) !== 0 ? "overlap" : "ignore";
}

const RANK: Record<CollisionResponse, number> = { ignore: 0, overlap: 1, block: 2 };

/** What two colliders do: the weaker of their responses to each other's layer. */
export function collisionPairResponse(a: CollisionFilter, b: CollisionFilter): CollisionResponse {
  const ab = collisionResponseTo(a, b.layer);
  const ba = collisionResponseTo(b, a.layer);
  return RANK[ab] <= RANK[ba] ? ab : ba;
}

/** The masks with `layerIndex` set to `response`. */
export function setCollisionResponse(
  filter: Pick<CollisionFilter, "mask" | "overlapMask">,
  layerIndex: number,
  response: CollisionResponse,
): { mask: number; overlapMask: number } {
  const bit = (1 << layerIndex) >>> 0;
  const mask = response === "block" ? filter.mask | bit : filter.mask & ~bit;
  const overlapMask = response === "overlap" ? filter.overlapMask | bit : filter.overlapMask & ~bit;
  return { mask: mask >>> 0, overlapMask: overlapMask >>> 0 };
}

/** A preset id not yet used, derived from a name. */
export function newCollisionPresetId(name: string, presets: readonly Pick<CollisionPreset, "id">[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preset";
  const taken = new Set(presets.map((preset) => preset.id));
  let id = base === CUSTOM_COLLISION_PRESET ? `${base}-preset` : base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}
