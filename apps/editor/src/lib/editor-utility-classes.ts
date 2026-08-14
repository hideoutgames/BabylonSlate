import { isEditorUtilityObjectClass } from "@babylonslate/core";
import type { ClassPickerEntry } from "@babylonslate/editor-kit";
import { classParentLookup } from "./content-browser-helpers";

export function editorUtilityObjectClassEntries(
  assets: ReadonlyArray<{
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
    if (asset.header.name === "EditorUtilityObject") continue;
    if (!isEditorUtilityObjectClass(asset.header.name, parentOf)) continue;
    entries.push({
      id: asset.header.name,
      name: asset.header.name,
      group: "Project",
    });
  }
  return entries;
}
