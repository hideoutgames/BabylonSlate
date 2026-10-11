import type { DockviewApi, IDockviewPanel } from "dockview-react";
import {
  dockLayoutHostWidth,
  listDockWindows,
  primaryDockPanel,
  resolveDockInitialWidth,
  type DockviewDocumentKind,
  type DockWindowDefaultPosition,
  type DockWindowOptions,
} from "./window-catalog";

export type { DockviewDocumentKind };

/**
 * A dock built while hidden (an inactive document tab) has no host width;
 * Dockview then reports only its minimum size. A host-width ratio applies
 * once the dock first grows past that hidden size.
 */
function applyWidthRatioWhenSized(
  api: DockviewApi,
  panel: IDockviewPanel,
  position: DockWindowDefaultPosition,
): void {
  const hiddenWidth = dockLayoutHostWidth(api);
  const subscription = panel.api.onDidDimensionsChange(() => {
    const hostWidth = dockLayoutHostWidth(api);
    if (hostWidth <= hiddenWidth) return;
    subscription.dispose();
    const width = resolveDockInitialWidth(position, hostWidth);
    // Resize after Dockview finishes the layout pass that reported the width.
    queueMicrotask(() => {
      if (width !== undefined && api.getPanel(panel.id) === panel) {
        panel.api.setSize({ width });
      }
    });
  });
}

function applyCatalogLayout(
  api: DockviewApi,
  kind: DockviewDocumentKind,
  options: DockWindowOptions | undefined,
  hostWidth: number,
): void {
  const windows = listDockWindows(kind, options);
  const primaryId = primaryDockPanel(kind, options);
  const ordered = [
    ...windows.filter((def) => def.id === primaryId),
    ...windows.filter((def) => def.id !== primaryId),
  ];
  let primary: ReturnType<DockviewApi["addPanel"]> | undefined;
  const unsized: Array<[IDockviewPanel, DockWindowDefaultPosition]> = [];
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
    if (
      reference &&
      def.defaultPosition?.initialWidthRatio !== undefined &&
      initialWidth === undefined
    ) {
      unsized.push([panel, def.defaultPosition]);
    }
    if (def.id === primaryId) primary = panel;
  }
  for (const [panel, position] of unsized) {
    applyWidthRatioWhenSized(api, panel, position);
  }
  primary?.api.setActive();
}

/**
 * `hostWidth` is the host element's client width; pass 0 for a hidden host so
 * width ratios wait for its first real layout.
 */
export function createDefaultLayoutForKind(
  api: DockviewApi,
  kind: DockviewDocumentKind,
  options?: DockWindowOptions,
  hostWidth = dockLayoutHostWidth(api),
): void {
  applyCatalogLayout(api, kind, options, hostWidth);
}
