/** Editor-only assets stripped from Play compile and game export (P12 / P14). */

export type EditorUtilityDockKind = "scene" | "class";

export function normalizeEditorUtilityDockKind(
  value: unknown,
): EditorUtilityDockKind {
  return value === "class" ? "class" : "scene";
}

export function isEditorOnlyAssetType(type: string): boolean {
  return type === "EditorUtilityInterface";
}

export function isEditorUtilityObjectClass(
  classId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  let current = classId ?? null;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === "EditorUtilityObject") return true;
    seen.add(current);
    current = parentOf(current) ?? null;
  }
  return false;
}

export function isEditorOnlyAsset(
  header: { type: string; parentClass?: string | null },
  parentOf: (id: string) => string | null | undefined,
): boolean {
  if (isEditorOnlyAssetType(header.type)) return true;
  if (header.type !== "Class" && header.type !== "Graph") return false;
  return isEditorUtilityObjectClass(header.parentClass, parentOf);
}
