import { isEditorUtilityObjectClass } from "@babylonslate/core";
import type { ClassPickerEntry } from "@babylonslate/editor-kit";
import { classIdFromClassAsset, classParentLookup } from "./content-browser-helpers";

export function editorUtilityObjectClassEntries(
  assets: ReadonlyArray<{
    path?: string;
    header: { type: string; name: string; parentClass?: string | null };
  }>,
): ClassPickerEntry[] {
  const parentOf = classParentLookup(assets);
  const entries: ClassPickerEntry[] = [
    {
      id: "EditorUtilityObject",
      name: "Editor Utility Object",
      group: "Engine",
    },
  ];
  for (const asset of assets) {
    if (asset.header.type !== "Class") continue;
    const id = classIdFromClassAsset(asset);
    if (id === "EditorUtilityObject") continue;
    if (!isEditorUtilityObjectClass(id, parentOf)) continue;
    entries.push({
      id,
      name: id,
      group: "Project",
    });
  }
  return entries;
}
