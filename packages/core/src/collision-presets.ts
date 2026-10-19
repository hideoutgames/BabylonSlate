/**
 * Project Collision Presets: named collision filters (a Layer and the layers
 * it collides with) that colliders reference by preset id. A collider whose
 * `collisionPreset` names no preset is Custom and keeps its own `layer` and
 * `mask`.
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
  /** Layers it collides with, as a component's `mask`. */
  mask: number;
}

const ALL_LAYERS = 0xffffffff;

export const DEFAULT_COLLISION_PRESETS: readonly CollisionPreset[] = [
  { id: DEFAULT_COLLISION_PRESET_ID, name: "Default", layer: 1, mask: ALL_LAYERS },
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
    presets.push({ id, name, layer: bits(source.layer, 1) || 1, mask: bits(source.mask, ALL_LAYERS) });
  }
  return presets.length > 0 ? presets : DEFAULT_COLLISION_PRESETS.map((preset) => ({ ...preset }));
}

/** A component's preset reference: a preset id, or Custom when missing or not a string. */
export function parseCollisionPresetRef(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : CUSTOM_COLLISION_PRESET;
}

/** The preset a reference names, if it still exists. */
export function findCollisionPreset(
  presets: readonly Pick<CollisionPreset, "id" | "layer" | "mask">[] | undefined,
  ref: unknown,
): Pick<CollisionPreset, "id" | "layer" | "mask"> | undefined {
  const id = parseCollisionPresetRef(ref);
  return id === CUSTOM_COLLISION_PRESET ? undefined : presets?.find((preset) => preset.id === id);
}

/** The layer and mask a collider uses: its preset's, or its own when Custom or the preset is gone. */
export function resolveCollisionFilter(
  layer: number,
  mask: number,
  ref: unknown,
  presets: readonly Pick<CollisionPreset, "id" | "layer" | "mask">[] | undefined,
): { layer: number; mask: number } {
  const preset = findCollisionPreset(presets, ref);
  return preset ? { layer: preset.layer >>> 0, mask: preset.mask >>> 0 } : { layer, mask: mask >>> 0 };
}

/** A preset id not yet used, derived from a name. */
export function newCollisionPresetId(name: string, presets: readonly Pick<CollisionPreset, "id">[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preset";
  const taken = new Set(presets.map((preset) => preset.id));
  let id = base === CUSTOM_COLLISION_PRESET ? `${base}-preset` : base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}
