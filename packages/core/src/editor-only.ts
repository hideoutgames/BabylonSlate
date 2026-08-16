/** Editor-only assets stripped from Play compile and game export (P12 / P14). */

export type EditorUtilityDockKind = "scene" | "class";

export function normalizeEditorUtilityDockKind(
  value: unknown,
): EditorUtilityDockKind {
  return value === "class" ? "class" : "scene";
}

export function isEditorOnlyAssetType(type: string): boolean {
  return type === "EditorUtilityInterface" || type === "PluginSettings";
}

function ancestryIncludes(
  classId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
  ancestorId: string,
): boolean {
  let current = classId ?? null;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = parentOf(current) ?? null;
  }
  return false;
}

export function isEditorUtilityObjectClass(
  classId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  return ancestryIncludes(classId, parentOf, "EditorUtilityObject");
}

export function isEditorFunctionLibraryClass(
  classId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  return ancestryIncludes(classId, parentOf, "EditorFunctionLibrary");
}

export function isFunctionLibraryClass(
  classId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  return ancestryIncludes(classId, parentOf, "FunctionLibrary");
}

export function isEditorGraphClass(
  classId: string | null | undefined,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  return (
    isEditorUtilityObjectClass(classId, parentOf) ||
    isEditorFunctionLibraryClass(classId, parentOf)
  );
}

export function isEditorGraphHost(options: {
  parentClass?: string | null;
  parentOf?: (id: string) => string | null | undefined;
  assetType?: string | null;
  editorGraph?: boolean;
}): boolean {
  if (options.editorGraph === true) return true;
  if (options.assetType === "EditorUtilityInterface") return true;
  const parentOf = options.parentOf ?? (() => null);
  return isEditorGraphClass(options.parentClass, parentOf);
}

export function isEditorOnlyAsset(
  header: { type: string; parentClass?: string | null },
  parentOf: (id: string) => string | null | undefined,
): boolean {
  if (isEditorOnlyAssetType(header.type)) return true;
  if (header.type !== "Class" && header.type !== "Graph") return false;
  return isEditorGraphClass(header.parentClass, parentOf);
}

export type FunctionLibraryHeaderFunction = {
  name: string;
  pins: Array<{ name: string; typeId?: string; direction?: "in" | "out" }>;
};

export function functionLibraryHeaderMeta(graph: {
  members?: Array<{
    kind: string;
    name: string;
    pins?: FunctionLibraryHeaderFunction["pins"];
  }>;
}): { functions: FunctionLibraryHeaderFunction[] } {
  return {
    functions: (graph.members ?? [])
      .filter((member) => member.kind === "function")
      .map((member) => ({
        name: member.name,
        pins: member.pins ?? [],
      })),
  };
}
