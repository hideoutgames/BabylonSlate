import { normalizeTransform, type SerializedTransform } from "./scene";

export interface FoliageModel {
  modelGuid: string;
  materialGuid: string | null;
  weight: number;
  minScale: number;
  maxScale: number;
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
      return [{ modelGuid, materialGuid: guid(model.materialGuid), weight: number(model.weight, 1, 0, 100),
        minScale, maxScale: number(model.maxScale, Math.max(1.2, minScale), minScale, 100) }];
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
    return transforms.length ? [{ modelGuid, materialGuid: guid(batch.materialGuid), transforms }] : [];
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
  return { ...properties, batches: existing < 0
    ? [...properties.batches, { modelGuid: model.modelGuid, materialGuid: model.materialGuid, transforms: [transform] }]
    : properties.batches.map((batch, index) => index === existing ? { ...batch, transforms: [...batch.transforms, transform] } : batch) };
}
