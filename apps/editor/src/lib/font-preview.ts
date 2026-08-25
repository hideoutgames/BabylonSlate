import { compileFontStack } from "@babylonslate/assets";

export function familyFromAssetPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const family = (payload as { family?: unknown }).family;
  return typeof family === "string" && family.trim() !== "" ? family.trim() : null;
}

export function fontEditorStack(options: {
  family: string;
  fallbackGuids: readonly string[];
  defaultFontGuid: string | null;
  globalFallback: string;
  familyForGuid: (guid: string) => string | null;
}): string {
  const fallbackFamilies = options.fallbackGuids
    .map((guid) => options.familyForGuid(guid))
    .filter((family): family is string => family !== null);
  return compileFontStack({
    family: options.family,
    fallbackFamilies,
    projectDefaultFamily: options.defaultFontGuid
      ? options.familyForGuid(options.defaultFontGuid)
      : null,
    globalFallback: options.globalFallback,
  });
}
