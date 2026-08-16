import type { AnimClipCatalogEntry } from "@babylonslate/anim-graph";

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** Build a clip catalog from Content Browser headers (Model clipNames, Animation clipName). */
export function animClipCatalogFromAssets(
  assets: ReadonlyArray<{
    header: {
      guid: string;
      type: string;
      name: string;
      dependencies?: string[];
      payload?: unknown;
    };
  }>,
): AnimClipCatalogEntry[] {
  return assets.map((asset) => {
    const payload =
      asset.header.payload && typeof asset.header.payload === "object"
        ? (asset.header.payload as Record<string, unknown>)
        : {};
    return {
      guid: asset.header.guid,
      type: asset.header.type,
      name: asset.header.name,
      clipName:
        typeof payload.clipName === "string" ? payload.clipName : undefined,
      clipNames: stringList(payload.clipNames),
      dependencyGuids: asset.header.dependencies ?? [],
    };
  });
}
