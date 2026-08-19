export type SkeletonKind = "skin" | "hierarchy";

export interface SkeletonPayload {
  modelGuid: string;
  kind: SkeletonKind;
  boneNames: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function trimmedGuid(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
}

export function normalizeSkeletonPayload(value: unknown): SkeletonPayload {
  const record = asRecord(value);
  return {
    modelGuid: trimmedGuid(record.modelGuid),
    kind: record.kind === "skin" ? "skin" : "hierarchy",
    boneNames: stringList(record.boneNames),
  };
}

export function remapSkeletonPayloadGuids(
  assetType: string,
  payload: Record<string, unknown>,
  remap: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (assetType !== "Skeleton") return payload;
  const skeleton = normalizeSkeletonPayload(payload);
  return {
    ...skeleton,
    modelGuid: remap.get(skeleton.modelGuid) ?? skeleton.modelGuid,
  };
}

export function skeletonAssetGuids(payload: unknown): string[] {
  const guid = normalizeSkeletonPayload(payload).modelGuid;
  return guid ? [guid] : [];
}
