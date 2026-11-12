/** The parts of a DockView panel a Compiler Results row needs to bring it forward. */
export interface ResultWindowPanel {
  group: { id: string };
  api: { isVisible: boolean; setActive: () => void };
}

export interface ResultWindowDock {
  getPanel: (id: string) => ResultWindowPanel | undefined;
  /** One group fills the dock: the phone layout, or a maximized group. */
  hasMaximizedGroup: () => boolean;
}

/**
 * Whether showing a window in `groupId` would hide the results list: it is
 * tabbed with the list, or one group fills the dock (the phone layout, where
 * only one window shows at a time).
 */
export function hidesResults(
  dock: ResultWindowDock,
  groupId: string | undefined,
  resultsGroupId: string | undefined,
): boolean {
  return groupId === resultsGroupId || dock.hasMaximizedGroup();
}

/**
 * Whether choosing a row (a click or tap, not Open) may bring `panel`
 * forward: it is hidden, and showing it keeps the results list on screen.
 */
export function mayRevealOnChoice(
  dock: ResultWindowDock,
  panel: ResultWindowPanel | undefined,
  resultsGroupId: string | undefined,
): panel is ResultWindowPanel {
  return !!panel && !panel.api.isVisible && !hidesResults(dock, panel.group.id, resultsGroupId);
}

/**
 * Brings forward the window that shows a Compiler Results row's location.
 * Open (a double-click or double-tap, or the row menu) always does, reopening
 * the window when it was closed; a plain choice only uncovers a hidden window
 * when the results list stays on screen.
 */
export function revealResultWindow(options: {
  dock: ResultWindowDock | undefined;
  /** The Compiler Results panel's own group. */
  resultsGroupId: string | undefined;
  panelId: string;
  open: boolean;
  /** Reopens a closed catalog window (`toggleDockWindow`). */
  reopen: (panelId: string) => void;
}): void {
  const { dock, resultsGroupId, panelId, open, reopen } = options;
  if (!dock) return;
  const panel = dock.getPanel(panelId);
  if (open) {
    if (panel) panel.api.setActive();
    else reopen(panelId);
    return;
  }
  if (mayRevealOnChoice(dock, panel, resultsGroupId)) panel.api.setActive();
}
