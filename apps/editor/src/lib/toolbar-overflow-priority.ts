/**
 * Collapse order of the global toolbar's items when it is too narrow: lower tiers move into
 * the More Actions menu first, and items sharing a tier move together. Missing from this
 * list means pinned: Save All, Play and Simulate, the running Simulation's Pause, Stop and
 * Game / Edit input, and the Debug menu never collapse.
 *
 * Utilities that are also reachable elsewhere go first, then editing history (read-only
 * during a Simulation), then navigation and modes, and last the actions the open document
 * is about (Compile, Render).
 */
export const TOOLBAR_OVERFLOW_PRIORITY = {
  focus: 10,
  windows: 20,
  search: 30,
  settings: 40,
  history: 50,
  returnToScene: 60,
  sceneMode: 70,
  debugInstance: 72,
  simulationStep: 74,
  compilationError: 75,
  documentAction: 80,
} as const;
