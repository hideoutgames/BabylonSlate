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
 * Dockview then reports only its minimum size. Once the dock first grows past
 * that hidden size, the windows get the widths a shown build gives them: each
 * window with a host-width ratio takes its width out of its reference window.
 * Ratio windows chain rightwards from the first window of their row (Sprite
 * Animation; Source Control's Actors and Diff), so each reference is set to
 * what it keeps, left to right, and the last window takes the rest: Dockview
 * gives a resize's difference to the rightmost window.
 */
function applyWidthRatiosWhenSized(
  api: DockviewApi,
  unsized: ReadonlyArray<readonly [IDockviewPanel, DockWindowDefaultPosition]>,
): void {
  const first = unsized[0]?.[0];
  if (!first) return;
  const hiddenWidth = dockLayoutHostWidth(api);
  const subscription = first.api.onDidDimensionsChange(() => {
    const hostWidth = dockLayoutHostWidth(api);
    if (hostWidth <= hiddenWidth) return;
    subscription.dispose();
    const widths = new Map<string, number>();
    const references: IDockviewPanel[] = [];
    for (const [panel, position] of unsized) {
      const width = resolveDockInitialWidth(position, hostWidth);
      const reference = api.getPanel(position.referencePanelId);
      if (width === undefined || !reference) continue;
      widths.set(reference.id, (widths.get(reference.id) ?? hostWidth) - width);
      widths.set(panel.id, width);
      if (!references.includes(reference)) references.push(reference);
    }
    // Resize after Dockview finishes the layout pass that reported the width.
    queueMicrotask(() => {
      for (const reference of references) {
        const width = widths.get(reference.id);
        if (width !== undefined && api.getPanel(reference.id) === reference) {
          reference.api.setSize({ width });
        }
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
  const windows = listDockWindows(kind, options).filter((def) => def.openByDefault !== false);
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
  applyWidthRatiosWhenSized(api, unsized);
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
