import { describe, expect, it } from "vitest";
import { panelComponents, scenePanelComponents } from "./panel-registry";
import { SCENE_MODES } from "./scene-document-layout";
import {
  listDockWindows,
  type DockviewDocumentKind,
  type DockWindowOptions,
} from "./window-catalog";

// `satisfies` makes the compiler reject a kind that is added to or removed from the catalog type.
const KINDS = Object.keys({
  scene: true,
  "scene-layer": true,
  graph: true,
  prefab: true,
  enum: true,
  structure: true,
  "data-definition": true,
  "data-tree": true,
  "float-curve": true,
  "vector-curve": true,
  "color-curve": true,
  "global-parameter-collection": true,
  "script-interface": true,
  sprite: true,
  "sprite-animation": true,
  tileset: true,
  tilemap: true,
  material: true,
  "material-function": true,
  "material-instance": true,
  "plugin-settings": true,
  "anim-graph-3d": true,
  "anim-graph-2d": true,
  "behaviour-tree": true,
  audio: true,
  "save-game": true,
  "input-action": true,
  "input-axis": true,
  "audio-mixer": true,
  "audio-channel": true,
  "sound-attenuation": true,
  "camera-shake": true,
  "particle-emitter": true,
  "particle-graph": true,
  "particle-system": true,
  water: true,
  "render-target": true,
  "render-target-texture": true,
  model: true,
  skeleton: true,
  animation: true,
  "blend-space": true,
  "skybox-creator": true,
  trace: true,
  texture: true,
  font: true,
  blackboard: true,
  timeline: true,
  "timeline-clip-2d": true,
  "timeline-clip-3d": true,
  "extension-asset": true,
} satisfies Record<DockviewDocumentKind, true>) as DockviewDocumentKind[];

const OPTION_VARIANTS: DockWindowOptions[] = [
  {},
  { actorPrefab: false },
  { sourceControl: true },
  ...SCENE_MODES.map((sceneMode) => ({ sceneMode })),
];

describe("panelComponents", () => {
  it.each(KINDS)("registers a panel for every %s dock window", (kind) => {
    const missing = OPTION_VARIANTS.flatMap((options) =>
      listDockWindows(kind, options).map((window) => window.component),
    ).filter((component) => !(component in panelComponents));
    expect(missing).toEqual([]);
  });

  // A project opens on a Scene, so its windows in every mode load with the Editor route rather than on first use.
  it.each(["scene", "scene-layer"] as const)("registers every %s window with the Editor route", (kind) => {
    const lazy = OPTION_VARIANTS.flatMap((options) =>
      listDockWindows(kind, options).map((window) => window.component),
    ).filter((component) => !(component in scenePanelComponents));
    expect(lazy).toEqual([]);
  });
});
