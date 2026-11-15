/**
 * Graph tabs that are document content, not catalog windows: a Class's function graphs open beside its Event Graph,
 * and an Animation Graph's state graphs beside its State Machine (Graph). One panel per function or state, keyed by
 * its id and carried in `layout.json` by the DockView snapshot.
 */

export const FUNCTION_GRAPH_PANEL_COMPONENT = "function-graph";
/** The Event Graph stays the primary `graph` catalog panel. */
export const EVENT_GRAPH_PANEL_ID = "graph";
/** The Class (Script in a Scene) members panel beside it. */
export const CLASS_PANEL_ID = "my-class";

export const ANIM_STATE_GRAPH_PANEL_COMPONENT = "anim-state-graph";
/** The State Machine stays the primary `anim-graph-graph` catalog panel; a transition rule still opens inside it. */
export const ANIM_STATE_MACHINE_PANEL_ID = "anim-graph-graph";

const PANEL_ID_PREFIX = "function-graph:";
const ANIM_STATE_PANEL_ID_PREFIX = "anim-state-graph:";

export interface FunctionGraphPanelParams {
  functionId: string;
}

export interface AnimStateGraphPanelParams {
  stateId: string;
}

interface GraphContentPanel {
  id: string;
  api: {
    setActive: () => void;
    setTitle: (title: string) => void;
    title?: string;
  };
}

export interface FunctionGraphDockApi {
  getPanel: (id: string) => GraphContentPanel | undefined;
  readonly panels: readonly GraphContentPanel[];
  addPanel: (options: {
    id: string;
    component: string;
    title: string;
    params: FunctionGraphPanelParams | AnimStateGraphPanelParams;
    position?: { referencePanel: string; direction: "within" };
  }) => GraphContentPanel;
}

export function functionGraphPanelId(functionId: string): string {
  return `${PANEL_ID_PREFIX}${functionId}`;
}

export function isFunctionGraphPanelId(panelId: string): boolean {
  return panelId.startsWith(PANEL_ID_PREFIX);
}

export function animStateGraphPanelId(stateId: string): string {
  return `${ANIM_STATE_PANEL_ID_PREFIX}${stateId}`;
}

export function isAnimStateGraphPanelId(panelId: string): boolean {
  return panelId.startsWith(ANIM_STATE_PANEL_ID_PREFIX);
}

/** A function or state graph tab: document content the snapshot carries, not a catalog window. */
export function isGraphContentPanelId(panelId: string): boolean {
  return isFunctionGraphPanelId(panelId) || isAnimStateGraphPanelId(panelId);
}

/** The panel component a graph content tab renders. */
export function graphContentPanelComponent(panelId: string): string {
  return isAnimStateGraphPanelId(panelId) ? ANIM_STATE_GRAPH_PANEL_COMPONENT : FUNCTION_GRAPH_PANEL_COMPONENT;
}

/** The primary graph a content tab opens beside: the Event Graph, or the State Machine for a state. */
export function graphContentPrimaryPanelId(panelId: string): string {
  return isAnimStateGraphPanelId(panelId) ? ANIM_STATE_MACHINE_PANEL_ID : EVENT_GRAPH_PANEL_ID;
}

/** Focus a content tab, opening it beside its primary graph (or another tab of its kind when that is closed). */
function openGraphContentPanel(
  api: FunctionGraphDockApi,
  id: string,
  title: string,
  params: FunctionGraphPanelParams | AnimStateGraphPanelParams,
): void {
  const existing = api.getPanel(id);
  if (existing) {
    if (existing.api.title !== title) existing.api.setTitle(title);
    existing.api.setActive();
    return;
  }
  const sameKind = isAnimStateGraphPanelId(id) ? isAnimStateGraphPanelId : isFunctionGraphPanelId;
  const reference =
    api.getPanel(graphContentPrimaryPanelId(id))?.id ??
    api.panels.find((panel) => sameKind(panel.id))?.id;
  const panel = api.addPanel({
    id,
    component: graphContentPanelComponent(id),
    title,
    params,
    ...(reference
      ? { position: { referencePanel: reference, direction: "within" } }
      : {}),
  });
  panel.api.setActive();
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
  openGraphContentPanel(api, functionGraphPanelId(functionId), title, { functionId });
}

/**
 * Focus the state's graph tab, opening it beside the State Machine (or another
 * open state tab when the State Machine is closed).
 */
export function openAnimStateGraphPanel(
  api: FunctionGraphDockApi,
  stateId: string,
  title: string,
): void {
  openGraphContentPanel(api, animStateGraphPanelId(stateId), title, { stateId });
}
