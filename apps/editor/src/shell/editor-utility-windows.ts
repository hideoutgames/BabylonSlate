import { normalizeEditorUtilityDockKind } from "@babylonslate/core";
import {
  findDockWindow,
  type DockWindowDefinition,
  type DockWindowOptions,
  type DockviewDocumentKind,
} from "./window-catalog";

export type EditorUtilityAssetRef = {
  guid: string;
  name: string;
  type: string;
  payload?: Record<string, unknown>;
};

export type ListEditorUtilityWindowsOptions = DockWindowOptions & {
  kind?: string;
  assets?: EditorUtilityAssetRef[];
};

const DOCK_KIND_FOR_DOCUMENT: Record<string, string> = {
  scene: "scene",
  graph: "class",
};

const DEFAULT_REFERENCE: Record<string, string> = {
  scene: "viewport",
  graph: "graph",
};

export function editorUtilityWindowId(guid: string): string {
  return `eui-${guid}`;
}

export function editorUtilityGuidFromWindowId(windowId: string): string | null {
  return windowId.startsWith("eui-") ? windowId.slice("eui-".length) : null;
}

export function editorUtilityAssetsFromIndexed(
  assets: ReadonlyArray<{
    header: {
      guid: string;
      name: string;
      type: string;
      payload?: Record<string, unknown>;
    };
  }>,
): EditorUtilityAssetRef[] {
  return assets.map((asset) => ({
    guid: asset.header.guid,
    name: asset.header.name,
    type: asset.header.type,
    payload: asset.header.payload,
  }));
}

/** EditorUtilityInterface widgets opened from Windows → Editor Utilities. */
export function listEditorUtilityWindows(
  options?: ListEditorUtilityWindowsOptions,
): DockWindowDefinition[] {
  const dockKind = options?.kind
    ? DOCK_KIND_FOR_DOCUMENT[options.kind]
    : undefined;
  if (!dockKind || !options?.assets) return [];
  const referencePanelId = options.kind
    ? DEFAULT_REFERENCE[options.kind]
    : undefined;
  return options.assets
    .filter((asset) => asset.type === "EditorUtilityInterface")
    .filter(
      (asset) =>
        normalizeEditorUtilityDockKind(asset.payload?.dockKind) === dockKind,
    )
    .map((asset) => ({
      id: editorUtilityWindowId(asset.guid),
      component: "editor-utility",
      title: asset.name,
      ...(referencePanelId
        ? {
            defaultPosition: {
              referencePanelId,
              direction: "right" as const,
              initialWidth: 320,
            },
          }
        : {}),
    }));
}

export function findDockOrUtilityWindow(
  kind: DockviewDocumentKind,
  panelId: string,
  options?: ListEditorUtilityWindowsOptions,
): DockWindowDefinition | undefined {
  return (
    findDockWindow(kind, panelId, options) ??
    listEditorUtilityWindows({ ...options, kind }).find(
      (entry) => entry.id === panelId,
    )
  );
}
