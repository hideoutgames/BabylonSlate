import type { DockWindowDirection } from "@babylonslate/core";

export type DockviewDocumentKind =
  | "scene"
  | "graph"
  | "enum"
  | "structure"
  | "script-interface"
  | "sprite";
export type { DockWindowDirection };

const DOCKVIEW_KINDS = new Set<DockviewDocumentKind>([
  "scene",
  "graph",
  "enum",
  "structure",
  "script-interface",
  "sprite",
]);

export function isDockviewDocumentKind(
  kind: string | undefined,
): kind is DockviewDocumentKind {
  return kind !== undefined && DOCKVIEW_KINDS.has(kind as DockviewDocumentKind);
}

export const CLASS_PANEL_TITLE = "Class";
/** About half the left stack so Class is not a 180px stub under Components. */
export const CLASS_PANEL_INITIAL_HEIGHT = 400;

export type DockWindowOptions = {
  /** Actor-lineage class documents get Prefab + Components. Default true. */
  actorPrefab?: boolean;
};

export interface DockWindowDefaultPosition {
  referencePanelId: string;
  direction: DockWindowDirection;
  initialWidth?: number;
  initialHeight?: number;
}

export interface DockWindowDefinition {
  id: string;
  component: string;
  title: string;
  defaultPosition?: DockWindowDefaultPosition;
}

const SCENE_WINDOWS: DockWindowDefinition[] = [
  { id: "viewport", component: "viewport", title: "Viewport" },
  {
    id: "scene-outliner",
    component: "scene-outliner",
    title: "Outliner",
    defaultPosition: {
      referencePanelId: "viewport",
      direction: "left",
      initialWidth: 260,
    },
  },
  {
    id: "scene-details",
    component: "scene-details",
    title: "Details",
    defaultPosition: {
      referencePanelId: "viewport",
      direction: "right",
      initialWidth: 300,
    },
  },
  {
    id: "output-log",
    component: "output-log",
    title: "Output Log",
    defaultPosition: {
      referencePanelId: "viewport",
      direction: "below",
      initialHeight: 160,
    },
  },
];

const GRAPH_WINDOWS: DockWindowDefinition[] = [
  { id: "graph", component: "graph", title: "Graph" },
  {
    id: "prefab-viewport",
    component: "prefab-viewport",
    title: "Prefab",
    defaultPosition: {
      referencePanelId: "graph",
      direction: "within",
    },
  },
  {
    id: "actor-prefab",
    component: "actor-prefab",
    title: "Components",
    defaultPosition: {
      referencePanelId: "graph",
      direction: "left",
      initialWidth: 260,
    },
  },
  {
    id: "my-class",
    component: "my-class",
    title: CLASS_PANEL_TITLE,
    defaultPosition: {
      referencePanelId: "actor-prefab",
      direction: "below",
      initialHeight: CLASS_PANEL_INITIAL_HEIGHT,
    },
  },
  {
    id: "inspector",
    component: "inspector",
    title: "Inspector",
    defaultPosition: {
      referencePanelId: "graph",
      direction: "right",
      initialWidth: 280,
    },
  },
  {
    id: "compiler-results",
    component: "compiler-results",
    title: "Compiler Results",
    defaultPosition: {
      referencePanelId: "graph",
      direction: "below",
      initialHeight: 160,
    },
  },
];

const OBJECT_GRAPH_WINDOWS: DockWindowDefinition[] = [
  { id: "graph", component: "graph", title: "Graph" },
  {
    id: "my-class",
    component: "my-class",
    title: CLASS_PANEL_TITLE,
    defaultPosition: {
      referencePanelId: "graph",
      direction: "left",
      initialWidth: 260,
    },
  },
  {
    id: "inspector",
    component: "inspector",
    title: "Inspector",
    defaultPosition: {
      referencePanelId: "graph",
      direction: "right",
      initialWidth: 280,
    },
  },
  {
    id: "compiler-results",
    component: "compiler-results",
    title: "Compiler Results",
    defaultPosition: {
      referencePanelId: "graph",
      direction: "below",
      initialHeight: 160,
    },
  },
];

const ENUM_WINDOWS: DockWindowDefinition[] = [
  { id: "enum-members", component: "type-members", title: "Members" },
  {
    id: "enum-details",
    component: "type-details",
    title: "Details",
    defaultPosition: {
      referencePanelId: "enum-members",
      direction: "right",
      initialWidth: 280,
    },
  },
];

const STRUCTURE_WINDOWS: DockWindowDefinition[] = [
  { id: "structure-members", component: "type-members", title: "Members" },
  {
    id: "structure-details",
    component: "type-details",
    title: "Details",
    defaultPosition: {
      referencePanelId: "structure-members",
      direction: "right",
      initialWidth: 280,
    },
  },
];

const SCRIPT_INTERFACE_WINDOWS: DockWindowDefinition[] = [
  {
    id: "script-interface-preview",
    component: "script-interface-preview",
    title: "Preview",
  },
  {
    id: "script-interface-methods",
    component: "script-interface-methods",
    title: "Methods",
    defaultPosition: {
      referencePanelId: "script-interface-preview",
      direction: "left",
      initialWidth: 240,
    },
  },
  {
    id: "script-interface-details",
    component: "script-interface-details",
    title: "Details",
    defaultPosition: {
      referencePanelId: "script-interface-preview",
      direction: "right",
      initialWidth: 280,
    },
  },
];

const SPRITE_WINDOWS: DockWindowDefinition[] = [
  { id: "sprite-preview", component: "sprite-preview", title: "Preview" },
  {
    id: "sprite-details",
    component: "sprite-details",
    title: "Details",
    defaultPosition: {
      referencePanelId: "sprite-preview",
      direction: "right",
      initialWidth: 280,
    },
  },
];

export function listDockWindows(
  kind: DockviewDocumentKind,
  options?: DockWindowOptions,
): DockWindowDefinition[] {
  if (kind === "scene") return SCENE_WINDOWS;
  if (kind === "enum") return ENUM_WINDOWS;
  if (kind === "structure") return STRUCTURE_WINDOWS;
  if (kind === "script-interface") return SCRIPT_INTERFACE_WINDOWS;
  if (kind === "sprite") return SPRITE_WINDOWS;
  if (options?.actorPrefab === false) return OBJECT_GRAPH_WINDOWS;
  return GRAPH_WINDOWS;
}

export function findDockWindow(
  kind: DockviewDocumentKind,
  id: string,
  options?: DockWindowOptions,
): DockWindowDefinition | undefined {
  return listDockWindows(kind, options).find((entry) => entry.id === id);
}
