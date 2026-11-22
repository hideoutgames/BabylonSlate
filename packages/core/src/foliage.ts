import { normalizeTransform, type SerializedActor, type SerializedTransform } from "./scene";

export const DEFAULT_FOLIAGE_CULL_DISTANCE = 120;
export const DEFAULT_FOLIAGE_FADE_RANGE = 15;
export const DEFAULT_FOLIAGE_SHADOW_DISTANCE = 45;

export interface FoliageModel {
  modelGuid: string;
  materialGuid: string | null;
  weight: number;
  minScale: number;
  maxScale: number;
  /** Distance from camera at which spatial cells stop drawing (0 = unlimited). */
  cullDistance: number;
  /** Width of the dithered fade-out band ending at cullDistance (meters). */
  fadeRange: number;
  /** Distance at which spatial cells stop casting shadows (0 = inherit cullDistance). */
  shadowDistance: number;
}
export interface FoliageGroup {
  id: string;
  name: string;
  models: FoliageModel[];
}
export interface FoliageBatch {
  modelGuid: string;
  materialGuid: string | null;
  transforms: SerializedTransform[];
  cullDistance: number;
  fadeRange: number;
  shadowDistance: number;
}
export interface FoliageProperties {
  groupId: string;
  batches: FoliageBatch[];
}
export const MAX_FOLIAGE_INSTANCES = 20000;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function number(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function guid(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function normalizeFoliageGroups(value: unknown): FoliageGroup[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.slice(0, 64).flatMap((entry, index) => {
    const p = object(entry);
    const id = guid(p.id) ?? `foliage-group-${index + 1}`;
    if (ids.has(id)) return [];
    ids.add(id);
    const models = Array.isArray(p.models) ? p.models : [];
    return [{ id, name: guid(p.name) ?? "Foliage Group", models: models.slice(0, 64).flatMap((entry) => {
      const model = object(entry);
      const modelGuid = guid(model.modelGuid);
      if (!modelGuid) return [];
      const minScale = number(model.minScale, 0.8, 0.01, 100);
      return [{
        modelGuid,
        materialGuid: guid(model.materialGuid),
        weight: number(model.weight, 1, 0, 100),
        minScale,
        maxScale: number(model.maxScale, Math.max(1.2, minScale), minScale, 100),
        cullDistance: number(model.cullDistance, DEFAULT_FOLIAGE_CULL_DISTANCE, 0, 10_000),
        fadeRange: number(model.fadeRange, DEFAULT_FOLIAGE_FADE_RANGE, 0, 1_000),
        shadowDistance: number(model.shadowDistance, DEFAULT_FOLIAGE_SHADOW_DISTANCE, 0, 10_000),
      }];
    }) }];
  });
}

export function parseFoliageProperties(value: unknown): FoliageProperties {
  const p = object(value);
  const batches = Array.isArray(p.batches) ? p.batches : [];
  let remaining = MAX_FOLIAGE_INSTANCES;
  return { groupId: guid(p.groupId) ?? "", batches: batches.slice(0, 128).flatMap((entry) => {
    const batch = object(entry);
    const modelGuid = guid(batch.modelGuid);
    if (!modelGuid || !Array.isArray(batch.transforms) || remaining <= 0) return [];
    const transforms = batch.transforms.slice(0, remaining).map(normalizeTransform);
    remaining -= transforms.length;
    return transforms.length ? [{
      modelGuid,
      materialGuid: guid(batch.materialGuid),
      transforms,
      cullDistance: number(batch.cullDistance, DEFAULT_FOLIAGE_CULL_DISTANCE, 0, 10_000),
      fadeRange: number(batch.fadeRange, DEFAULT_FOLIAGE_FADE_RANGE, 0, 1_000),
      shadowDistance: number(batch.shadowDistance, DEFAULT_FOLIAGE_SHADOW_DISTANCE, 0, 10_000),
    }] : [];
  }) };
}

/** Models are selected by weight; zero-weight entries never paint. */
export function chooseFoliageModel(group: FoliageGroup, random: number): FoliageModel | null {
  const models = group.models.filter((entry) => entry.weight > 0);
  const sum = models.reduce((total, entry) => total + entry.weight, 0);
  let pick = Math.max(0, Math.min(1 - Number.EPSILON, random)) * sum;
  for (const model of models) { pick -= model.weight; if (pick < 0) return model; }
  return null;
}

export function appendFoliageInstance(properties: FoliageProperties, model: FoliageModel, transform: SerializedTransform): FoliageProperties {
  if (properties.batches.reduce((sum, batch) => sum + batch.transforms.length, 0) >= MAX_FOLIAGE_INSTANCES) return properties;
  const existing = properties.batches.findIndex((batch) => batch.modelGuid === model.modelGuid && batch.materialGuid === model.materialGuid);
  const cullDistance = number(model.cullDistance, DEFAULT_FOLIAGE_CULL_DISTANCE, 0, 10_000);
  const fadeRange = number(model.fadeRange, DEFAULT_FOLIAGE_FADE_RANGE, 0, 1_000);
  const shadowDistance = number(model.shadowDistance, DEFAULT_FOLIAGE_SHADOW_DISTANCE, 0, 10_000);
  return { ...properties, batches: existing < 0
    ? [...properties.batches, { modelGuid: model.modelGuid, materialGuid: model.materialGuid, transforms: [transform], cullDistance, fadeRange, shadowDistance }]
    : properties.batches.map((batch, index) => index === existing ? { ...batch, transforms: [...batch.transforms, transform], cullDistance, fadeRange, shadowDistance } : batch) };
}

/**
 * A Foliage Group Model's edit from `previous` to `next` reaches the strokes painted with it: every batch of group
 * `groupId`'s Foliage components that holds `previous`'s Model and Material Override takes `next`'s Material Override and
 * distances, so later edits still find it. Untouched actors, components and batches keep their identity; returns
 * `actors` itself when no batch is the Model's.
 */
export function applyFoliageModelEdit(
  actors: SerializedActor[], groupId: string, previous: FoliageModel, next: FoliageModel,
): SerializedActor[] {
  let changed = false;
  const result = actors.map((actor) => {
    let actorChanged = false;
    const components = actor.components.map((component) => {
      const properties = object(component.properties);
      if (component.classId !== "FoliageComponent" || properties.groupId !== groupId || !Array.isArray(properties.batches)) return component;
      let batchChanged = false;
      const batches = properties.batches.map((batch: unknown) => {
        const entry = object(batch);
        if (entry.modelGuid !== previous.modelGuid || guid(entry.materialGuid) !== previous.materialGuid) return batch;
        batchChanged = true;
        return { ...entry, materialGuid: next.materialGuid, cullDistance: next.cullDistance, fadeRange: next.fadeRange, shadowDistance: next.shadowDistance };
      });
      if (!batchChanged) return component;
      actorChanged = true;
      return { ...component, properties: { ...properties, batches } };
    });
    if (!actorChanged) return actor;
    changed = true;
    return { ...actor, components };
  });
  return changed ? result : actors;
}
