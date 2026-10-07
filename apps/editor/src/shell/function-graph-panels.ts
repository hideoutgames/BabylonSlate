/**
 * Class function graphs open as their own DockView tabs next to the Event
 * Graph. They are not catalog windows: one panel per function, keyed by the
 * function member id and carried in `layout.json` by the DockView snapshot.
 */

export const FUNCTION_GRAPH_PANEL_COMPONENT = "function-graph";
/** The Event Graph stays the primary `graph` catalog panel. */
export const EVENT_GRAPH_PANEL_ID = "graph";

const PANEL_ID_PREFIX = "function-graph:";

export interface FunctionGraphPanelParams {
  functionId: string;
}

interface FunctionGraphPanel {
  id: string;
  api: {
    setActive: () => void;
    setTitle: (title: string) => void;
    title?: string;
  };
}

export interface FunctionGraphDockApi {
  getPanel: (id: string) => FunctionGraphPanel | undefined;
  readonly panels: readonly FunctionGraphPanel[];
  addPanel: (options: {
    id: string;
    component: string;
    title: string;
    params: FunctionGraphPanelParams;
    position?: { referencePanel: string; direction: "within" };
  }) => FunctionGraphPanel;
}

export function functionGraphPanelId(functionId: string): string {
  return `${PANEL_ID_PREFIX}${functionId}`;
}

export function isFunctionGraphPanelId(panelId: string): boolean {
  return panelId.startsWith(PANEL_ID_PREFIX);
}

/**
 * Focus the function's tab, opening it beside the Event Graph (or another
 * open function tab when the Event Graph is closed).
 */
export function openFunctionGraphPanel(
  api: FunctionGraphDockApi,
  functionId: string,
  title: string,
): void {
  const id = functionGraphPanelId(functionId);
  const existing = api.getPanel(id);
  if (existing) {
    if (existing.api.title !== title) existing.api.setTitle(title);
    existing.api.setActive();
    return;
  }
  const reference =
    api.getPanel(EVENT_GRAPH_PANEL_ID)?.id ??
    api.panels.find((panel) => isFunctionGraphPanelId(panel.id))?.id;
  const panel = api.addPanel({
    id,
    component: FUNCTION_GRAPH_PANEL_COMPONENT,
    title,
    params: { functionId },
    ...(reference
      ? { position: { referencePanel: reference, direction: "within" } }
      : {}),
  });
  panel.api.setActive();
}
