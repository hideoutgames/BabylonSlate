import { rangeSelectTreeIds } from "@babylonslate/editor-kit";
import { PREFAB_ROOT_ID } from "./prefab-preview";

export function applyPrefabTreeSelect(input: {
  visibleIds: readonly string[];
  selectedIds: readonly string[];
  id: string;
  additive?: boolean;
  range?: boolean;
}): string[] {
  const { visibleIds, selectedIds, id, additive, range } = input;
  if (range) {
    const from = selectedIds[selectedIds.length - 1];
    return rangeSelectTreeIds(visibleIds, from, id);
  }
  if (additive) {
    if (id === PREFAB_ROOT_ID) return [PREFAB_ROOT_ID];
    const withoutRoot = selectedIds.filter((entry) => entry !== PREFAB_ROOT_ID);
    return withoutRoot.includes(id)
      ? withoutRoot.filter((entry) => entry !== id)
      : [...withoutRoot, id];
  }
  return [id];
}
