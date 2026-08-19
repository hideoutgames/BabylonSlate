export interface ModelMaterialSlot {
  index: number;
  name: string;
  materialGuid: string | null;
}

export interface ModelPayload {
  materialSlots: ModelMaterialSlot[];
  clipNames: string[];
  skeletonGuid: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function slotName(value: unknown, index: number): string {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : `Slot ${index + 1}`;
}

function slotGuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const guid = value.trim();
  return guid.length > 0 ? guid : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

function nullableGuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const guid = value.trim();
  return guid.length > 0 ? guid : null;
}

/** Drop importer count fields; coerce slot guids; keep filled legacy guids. */
export function normalizeModelPayload(value: unknown): ModelPayload {
  const record = asRecord(value);
  const rawSlots = Array.isArray(record.materialSlots)
    ? record.materialSlots
    : [];
  const materialSlots: ModelMaterialSlot[] = rawSlots.map((entry, index) => {
    const slot = asRecord(entry);
    const slotIndex =
      typeof slot.index === "number" && Number.isFinite(slot.index)
        ? slot.index
        : index;
    return {
      index: slotIndex,
      name: slotName(slot.name, slotIndex),
      materialGuid: slotGuid(slot.materialGuid),
    };
  });
  return {
    materialSlots,
    clipNames: stringList(record.clipNames),
    skeletonGuid: nullableGuid(record.skeletonGuid),
  };
}

export function remapModelPayloadGuids(
  assetType: string,
  payload: Record<string, unknown>,
  remap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (assetType !== "Model") return payload;
  const model = normalizeModelPayload(payload);
  return {
    ...model,
    materialSlots: model.materialSlots.map((slot) => ({
      ...slot,
      materialGuid: slot.materialGuid
        ? (remap.get(slot.materialGuid) ?? slot.materialGuid)
        : null,
    })),
    skeletonGuid: model.skeletonGuid
      ? (remap.get(model.skeletonGuid) ?? model.skeletonGuid)
      : null,
  };
}

/** Slot Material guids for Show References, remap, and export. */
export function modelMaterialGuids(payload: unknown): string[] {
  const guids = new Set<string>();
  for (const slot of normalizeModelPayload(payload).materialSlots) {
    if (slot.materialGuid) guids.add(slot.materialGuid);
  }
  return [...guids].sort();
}

/** Skeleton + slot Material guids on a Model header. */
export function modelAssetGuids(payload: unknown): string[] {
  const model = normalizeModelPayload(payload);
  const guids = new Set<string>(modelMaterialGuids(model));
  if (model.skeletonGuid) guids.add(model.skeletonGuid);
  return [...guids].sort();
}
