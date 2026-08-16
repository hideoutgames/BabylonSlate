import type { DockWindowDirection } from "@babylonslate/core";
import type { UiEditorMode } from "./ui-document-layout";

export type { UiEditorMode };
export type DockviewDocumentKind =
  | "scene"
  | "graph"
  | "enum"
  | "structure"
  | "script-interface"
  | "sprite"
  | "tileset"
  | "tilemap"
  | "material"
  | "material-function"
  | "ui"
  | "plugin-settings"
  | "anim-graph"
  | "behaviour-tree";
export type { DockWindowDirection };

const DOCKVIEW_KINDS = new Set<DockviewDocumentKind>([
  "scene",
  "graph",
  "enum",
  "structure",
  "script-interface",
  "sprite",
  "tileset",
  "tilemap",
  "material",
  "material-function",
  "ui",
  "plugin-settings",
  "anim-graph",
  "behaviour-tree",
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
  /** EditorUtilityInterface authoring adds a Settings dock for `dockKind`. */
  editorUtilityInterface?: boolean;
  /** Opt-in Git LFS locking; hides the Locks window entirely when off. */
  sourceControl?: boolean;
  /** UserInterface / EditorUtilityInterface Designer vs Logic surface. */
  uiEditorMode?: UiEditorMode;
};

export const LOCKS_WINDOW_ID = "locks";

const DOCK_PRIMARY_PANEL: Record<DockviewDocumentKind, string> = {
  scene: "viewport",
  graph: "graph",
  enum: "enum-members",
  structure: "structure-members",
  "script-interface": "script-interface-preview",
  sprite: "sprite-preview",
  tileset: "tileset-preview",
  tilemap: "tilemap-paint",
  material: "material-graph",
  "material-function": "material-function-graph",
  ui: "ui-design",
  "plugin-settings": "plugin-settings-details",
  "anim-graph": "anim-graph-graph",
  "behaviour-tree": "behaviour-tree-graph",
};

export function primaryDockPanel(
  kind: DockviewDocumentKind,
  options?: DockWindowOptions,
): string {
  if (kind === "ui" && options?.uiEditorMode === "logic") return "graph";
  return DOCK_PRIMARY_PANEL[kind];
}

function locksWindow(
  kind: DockviewDocumentKind,
  options?: DockWindowOptions,
): DockWindowDefinition {
  return {
    id: LOCKS_WINDOW_ID,
    component: "locks",
    title: "Locks",
    defaultPosition: {
      referencePanelId: primaryDockPanel(kind, options),
      direction: "below",
      initialHeight: 180,
    },
  };
}

function withOptionalLocks(
  kind: DockviewDocumentKind,
  windows: DockWindowDefinition[],
  options?: DockWindowOptions,
): DockWindowDefinition[] {
  if (!options?.sourceControl) return windows;
  return [...windows, locksWindow(kind, options)];
}

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

const TILESET_WINDOWS: DockWindowDefinition[] = [
  { id: "tileset-preview", component: "tileset-preview", title: "Preview" },
  {
    id: "tileset-details",
    component: "tileset-details",
    title: "Details",
    defaultPosition: {
      referencePanelId: "tileset-preview",
      direction: "right",
      initialWidth: 280,
    },
  },
];

const TILEMAP_WINDOWS: DockWindowDefinition[] = [
  { id: "tilemap-paint", component: "tilemap-paint", title: "Paint" },
  {
    id: "tilemap-details",
    component: "tilemap-details",
    title: "Details",
    defaultPosition: {
      referencePanelId: "tilemap-paint",
      direction: "right",
      initialWidth: 280,
    },
  },
];

const MATERIAL_WINDOWS: DockWindowDefinition[] = [
  { id: "material-graph", component: "material-graph", title: "Graph" },
  {
    id: "material-preview",
    component: "material-preview",
    title: "Preview",
    defaultPosition: {
      referencePanelId: "material-graph",
      direction: "left",
      initialWidth: 320,
    },
  },
  {
    id: "material-details",
    component: "material-details",
    title: "Details",
    defaultPosition: {
      referencePanelId: "material-graph",
      direction: "right",
      initialWidth: 300,
    },
  },
  {
    id: "material-compiler-results",
    component: "material-compiler-results",
    title: "Compiler Results",
    defaultPosition: {
      referencePanelId: "material-graph",
      direction: "below",
      initialHeight: 160,
    },
  },
];

const MATERIAL_FUNCTION_WINDOWS: DockWindowDefinition[] = [
  {
    id: "material-function-graph",
    component: "material-function-graph",
    title: "Graph",
  },
  {
    id: "material-function-interface",
    component: "material-function-interface",
    title: "Interface",
    defaultPosition: {
      referencePanelId: "material-function-graph",
      direction: "left",
      initialWidth: 300,
    },
  },
  {
    id: "material-details",
    component: "material-details",
    title: "Details",
    defaultPosition: {
      referencePanelId: "material-function-graph",
      direction: "right",
      initialWidth: 300,
    },
  },
  {
    id: "material-compiler-results",
    component: "material-compiler-results",
    title: "Compiler Results",
    defaultPosition: {
      referencePanelId: "material-function-graph",
      direction: "below",
      initialHeight: 160,
    },
  },
];

const UI_DESIGNER_WINDOWS: DockWindowDefinition[] = [
  { id: "ui-design", component: "ui-design", title: "Design" },
  {
    id: "ui-hierarchy",
    component: "ui-hierarchy",
    title: "Hierarchy",
    defaultPosition: {
      referencePanelId: "ui-design",
      direction: "left",
      initialWidth: 240,
    },
  },
  {
    id: "ui-details",
    component: "ui-details",
    title: "Details",
    defaultPosition: {
      referencePanelId: "ui-design",
      direction: "right",
      initialWidth: 280,
    },
  },
];

const PLUGIN_SETTINGS_WINDOWS: DockWindowDefinition[] = [
  {
    id: "plugin-settings-details",
    component: "plugin-settings-details",
    title: "Details",
  },
];

const ANIM_GRAPH_WINDOWS: DockWindowDefinition[] = [
  { id: "anim-graph-graph", component: "anim-graph-graph", title: "Graph" },
  {
    id: "anim-graph-parameters",
    component: "anim-graph-parameters",
    title: "Parameters",
    defaultPosition: {
      referencePanelId: "anim-graph-graph",
      direction: "left",
      initialWidth: 224,
    },
  },
  {
    id: "anim-graph-details",
    component: "anim-graph-details",
    title: "Details",
    defaultPosition: {
      referencePanelId: "anim-graph-graph",
      direction: "right",
      initialWidth: 288,
    },
  },
];

const BEHAVIOUR_TREE_WINDOWS: DockWindowDefinition[] = [
  {
    id: "behaviour-tree-graph",
    component: "behaviour-tree-graph",
    title: "Graph",
  },
  {
    id: "behaviour-tree-details",
    component: "behaviour-tree-details",
    title: "Details",
    defaultPosition: {
      referencePanelId: "behaviour-tree-graph",
      direction: "right",
      initialWidth: 288,
    },
  },
];

const UI_SETTINGS_WINDOW: DockWindowDefinition = {
  id: "ui-settings",
  component: "ui-settings",
  title: "Settings",
  defaultPosition: {
    referencePanelId: "ui-details",
    direction: "below",
    initialHeight: 160,
  },
};

export function listDockWindows(
  kind: DockviewDocumentKind,
  options?: DockWindowOptions,
): DockWindowDefinition[] {
  if (kind === "scene") return withOptionalLocks(kind, SCENE_WINDOWS, options);
  if (kind === "enum") return withOptionalLocks(kind, ENUM_WINDOWS, options);
  if (kind === "structure") {
    return withOptionalLocks(kind, STRUCTURE_WINDOWS, options);
  }
  if (kind === "script-interface") {
    return withOptionalLocks(kind, SCRIPT_INTERFACE_WINDOWS, options);
  }
  if (kind === "sprite") return withOptionalLocks(kind, SPRITE_WINDOWS, options);
  if (kind === "tileset") {
    return withOptionalLocks(kind, TILESET_WINDOWS, options);
  }
  if (kind === "tilemap") {
    return withOptionalLocks(kind, TILEMAP_WINDOWS, options);
  }
  if (kind === "material") {
    return withOptionalLocks(kind, MATERIAL_WINDOWS, options);
  }
  if (kind === "material-function") {
    return withOptionalLocks(kind, MATERIAL_FUNCTION_WINDOWS, options);
  }
  if (kind === "ui") {
    if (options?.uiEditorMode === "logic") {
      return withOptionalLocks(kind, OBJECT_GRAPH_WINDOWS, options);
    }
    const windows = options?.editorUtilityInterface
      ? [...UI_DESIGNER_WINDOWS, UI_SETTINGS_WINDOW]
      : UI_DESIGNER_WINDOWS;
    return withOptionalLocks(kind, windows, options);
  }
  if (kind === "plugin-settings") {
    return withOptionalLocks(kind, PLUGIN_SETTINGS_WINDOWS, options);
  }
  if (kind === "anim-graph") {
    return withOptionalLocks(kind, ANIM_GRAPH_WINDOWS, options);
  }
  if (kind === "behaviour-tree") {
    return withOptionalLocks(kind, BEHAVIOUR_TREE_WINDOWS, options);
  }
  if (options?.actorPrefab === false) {
    return withOptionalLocks(kind, OBJECT_GRAPH_WINDOWS, options);
  }
  return withOptionalLocks(kind, GRAPH_WINDOWS, options);
}

export function findDockWindow(
  kind: DockviewDocumentKind,
  id: string,
  options?: DockWindowOptions,
): DockWindowDefinition | undefined {
  return listDockWindows(kind, options).find((entry) => entry.id === id);
}
