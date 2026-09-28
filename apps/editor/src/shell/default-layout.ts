import type { DockviewApi } from "dockview-react";
import {
  dockLayoutHostWidth,
  listDockWindows,
  primaryDockPanel,
  resolveDockInitialWidth,
  type DockviewDocumentKind,
  type DockWindowOptions,
} from "./window-catalog";

export type { DockviewDocumentKind };

function applyCatalogLayout(
  api: DockviewApi,
  kind: DockviewDocumentKind,
  options?: DockWindowOptions,
): void {
  const windows = listDockWindows(kind, options);
  const primaryId = primaryDockPanel(kind, options);
  const hostWidth = dockLayoutHostWidth(api);
  const ordered = [
    ...windows.filter((def) => def.id === primaryId),
    ...windows.filter((def) => def.id !== primaryId),
  ];
  let primary: ReturnType<DockviewApi["addPanel"]> | undefined;
  for (const def of ordered) {
    const reference = def.defaultPosition
      ? api.getPanel(def.defaultPosition.referencePanelId)
      : undefined;
    const initialWidth = resolveDockInitialWidth(
      def.defaultPosition,
      hostWidth,
    );
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
            ...(typeof initialWidth === "number" ? { initialWidth } : {}),
            initialHeight: def.defaultPosition.initialHeight,
          }
        : {}),
    });
    if (def.id === primaryId) primary = panel;
  }
  primary?.api.setActive();
}

export function createDefaultLayoutForKind(
  api: DockviewApi,
  kind: DockviewDocumentKind,
  options?: DockWindowOptions,
): void {
  applyCatalogLayout(api, kind, options);
}
