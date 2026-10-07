import { describe, expect, it } from "vitest";
import { panelComponents } from "./panel-registry";
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
  enum: true,
  structure: true,
  "data-definition": true,
  "data-tree": true,
  "script-interface": true,
  sprite: true,
  "sprite-animation": true,
  tileset: true,
  tilemap: true,
  material: true,
  "material-function": true,
  "material-instance": true,
  "plugin-settings": true,
  "anim-graph": true,
  "behaviour-tree": true,
  audio: true,
  "save-game": true,
  "input-action": true,
  "input-axis": true,
  "audio-mixer": true,
  "audio-channel": true,
  "sound-attenuation": true,
  "particle-emitter": true,
  "particle-graph": true,
  "particle-system": true,
  water: true,
  "render-target": true,
  "render-target-texture": true,
  model: true,
  skeleton: true,
  animation: true,
  "skybox-creator": true,
  trace: true,
  texture: true,
} satisfies Record<DockviewDocumentKind, true>) as DockviewDocumentKind[];

const OPTION_VARIANTS: DockWindowOptions[] = [
  {},
  { actorPrefab: false },
  { sourceControl: true },
  { animEditorMode: "stateMachine" },
  { animEditorMode: "animationObject" },
  ...SCENE_MODES.map((sceneMode) => ({ sceneMode })),
];

describe("panelComponents", () => {
  it.each(KINDS)("registers a panel for every %s dock window", (kind) => {
    const missing = OPTION_VARIANTS.flatMap((options) =>
      listDockWindows(kind, options).map((window) => window.component),
    ).filter((component) => !(component in panelComponents));
    expect(missing).toEqual([]);
  });
});
