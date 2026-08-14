import type { DockWindowDefinition } from "./window-catalog";

export type EditorUtilityAssetRef = {
  guid: string;
  name: string;
  type: string;
  payload?: Record<string, unknown>;
};

export type ListEditorUtilityWindowsOptions = {
  kind?: string;
  assets?: EditorUtilityAssetRef[];
};

const DOCK_KIND_FOR_DOCUMENT: Record<string, string> = {
  scene: "scene",
  graph: "class",
};

export function editorUtilityWindowId(guid: string): string {
  return `eui-${guid}`;
}

/** EditorUtilityInterface widgets opened from Windows → Editor Utilities. */
export function listEditorUtilityWindows(
  options?: ListEditorUtilityWindowsOptions,
): DockWindowDefinition[] {
  const dockKind = options?.kind
    ? DOCK_KIND_FOR_DOCUMENT[options.kind]
    : undefined;
  if (!dockKind || !options?.assets) return [];
  return options.assets
    .filter((asset) => asset.type === "EditorUtilityInterface")
    .filter((asset) => asset.payload?.dockKind === dockKind)
    .map((asset) => ({
      id: editorUtilityWindowId(asset.guid),
      component: "editor-utility",
      title: asset.name,
    }));
}
