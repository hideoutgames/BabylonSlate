import { err, ok, type Result } from "@babylonslate/core";
import {
  ClassRegistry,
  isLockedEngineClassId,
  type ReparentResult,
} from "@babylonslate/object-model";
import {
  classIdFromClassAsset,
  type ClassAssetRef,
} from "./content-browser-helpers";

export function editorClassRegistryFromAssets(
  assets: ReadonlyArray<ClassAssetRef>,
): ClassRegistry {
  const registry = new ClassRegistry();
  const pending = assets
    .filter((asset) => asset.header.type === "Class")
    .map((asset) => ({
      id: classIdFromClassAsset(asset),
      parentClassId: asset.header.parentClass ?? "Actor",
    }))
    .filter((entry) => !registry.has(entry.id));
  let guard = pending.length + 1;
  const remaining = [...pending];
  while (remaining.length > 0 && guard > 0) {
    guard -= 1;
    const index = remaining.findIndex(
      (entry) => !entry.parentClassId || registry.has(entry.parentClassId),
    );
    if (index < 0) break;
    const entry = remaining.splice(index, 1)[0]!;
    registry.register({
      id: entry.id,
      parentClassId: entry.parentClassId,
      kind: "actor",
      variables: [],
      implementedInterfaces: [],
    });
  }
  return registry;
}

/** Validate a Class header reparent. Does not rewrite graph members or components. */
export function tryReparentUserClass(options: {
  classId: string;
  newParentId: string;
  assets: ReadonlyArray<ClassAssetRef>;
}): Result<ReparentResult, string> {
  const { classId, newParentId, assets } = options;
  if (isLockedEngineClassId(classId)) {
    return err(`cannot reparent engine class: ${classId}`);
  }
  const registry = editorClassRegistryFromAssets(assets);
  if (!registry.has(classId)) {
    return err(`unknown class: ${classId}`);
  }
  if (!registry.isA(newParentId, "Actor")) {
    return err(`parent must remain Actor ancestry: ${newParentId}`);
  }
  return registry.reparent(classId, newParentId);
}
