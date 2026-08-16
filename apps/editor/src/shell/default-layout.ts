import type { DockviewApi } from "dockview-react";
import {
  CLASS_PANEL_INITIAL_HEIGHT,
  CLASS_PANEL_TITLE,
  listDockWindows,
  primaryDockPanel,
  type DockviewDocumentKind,
  type DockWindowOptions,
} from "./window-catalog";

export type { DockviewDocumentKind };
export { CLASS_PANEL_INITIAL_HEIGHT, CLASS_PANEL_TITLE };

function applyCatalogLayout(
  api: DockviewApi,
  kind: DockviewDocumentKind,
  options?: DockWindowOptions,
): void {
  const windows = listDockWindows(kind, options);
  const primaryId = primaryDockPanel(kind, options);
  const ordered = [
    ...windows.filter((def) => def.id === primaryId),
    ...windows.filter((def) => def.id !== primaryId),
  ];
  let primary: ReturnType<DockviewApi["addPanel"]> | undefined;
  for (const def of ordered) {
    const reference = def.defaultPosition
      ? api.getPanel(def.defaultPosition.referencePanelId)
      : undefined;
    const panel = api.addPanel({
      id: def.id,
      component: def.component,
      title: def.title,
      ...(reference && def.defaultPosition
        ? {
            position: {
              referencePanel: reference,
              direction: def.defaultPosition.direction,
            },
            initialWidth: def.defaultPosition.initialWidth,
            initialHeight: def.defaultPosition.initialHeight,
          }
        : {}),
    });
    if (def.id === primaryId) primary = panel;
  }
  primary?.api.setActive();
}

export function createSceneDefaultLayout(api: DockviewApi): void {
  applyCatalogLayout(api, "scene");
}

export function createGraphDefaultLayout(api: DockviewApi): void {
  applyCatalogLayout(api, "graph");
}

export function createDefaultLayoutForKind(
  api: DockviewApi,
  kind: DockviewDocumentKind,
  options?: DockWindowOptions,
): void {
  applyCatalogLayout(api, kind, options);
}
