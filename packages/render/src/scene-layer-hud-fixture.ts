import type { Material } from "@babylonjs/core/Materials/material";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";
import type { OverlayLayoutRect } from "@haptic/core";
import { createJoystick2DMesh } from "./joystick2d-mesh";
import { OverlayLayoutRenderer } from "./overlay-layout-render";
import { createOverlayPanelMesh } from "./overlay-panel-mesh";
import { applyOverlayUnlitMaterial, createOverlayTextureQuad } from "./overlay-texture-quad";
import { applyOverlayVisualStyle } from "./overlay-visual-style";
import type { TextureResources } from "./resource-cache";
import { createText2DMesh } from "./text2d-mesh";
import { createUIControl2DMesh } from "./ui-controls2d-mesh";

/** Icon guids the fixture draws, each a 64 px texture. */
export const SCENE_LAYER_HUD_ICONS = ["camera", "navmesh", "audio", "particles", "spot_light", "point_light", "colormap"] as const;

export interface SceneLayerHudOptions {
  /** The texture each icon guid draws: one upload per guid, as the resource cache shares it. */
  texture: (guid: string) => BaseTexture;
  /**
   * What tinted backgrounds draw, as the Feature Test's authored overlay Material does; the unlit construction look
   * when absent.
   */
  panelMaterial?: Material;
}

/**
 * A HUD made like the Feature Test's `FT_HUD` Scene Layer, with Play's visual builders and actor names
 * (`actor-<slot>`): revealed rich text with letter effects, an underline and an image, headers, form controls, a
 * clipped scroll box of text rows, clipped virtualized list and grid windows, a widget row of icons, masked images and
 * buttons, card samples and a joystick, over texture and tinted panels. Letter effects hold their first sample, so
 * frames repeat exactly. For draw-batching tests and the browser proof.
 */
export function buildSceneLayerHud(scene: Scene, options: SceneLayerHudOptions): OverlayLayoutRenderer {
  const assets = {
    pixelsPerUnit: 100,
    textureBytes: new Map(SCENE_LAYER_HUD_ICONS.map((guid) => [guid, new Uint8Array([1])])),
    texturePixelSizes: new Map(SCENE_LAYER_HUD_ICONS.map((guid) => [guid, { width: 64, height: 64 }])),
    resourceCache: { acquireTexture: (guid: string) => ({ resource: options.texture(guid), release: () => {} }) } as unknown as TextureResources,
    resolveMaterial: () => options.panelMaterial ?? null,
  };
  let next = 1;
  const clipped: Array<{ slotId: number; clip: OverlayLayoutRect }> = [];
  const actor = (x: number, y: number, z = 0, clip?: OverlayLayoutRect) => {
    const root = new Mesh(`actor-${next}`, scene);
    root.position.set(x, y, z);
    if (clip) clipped.push({ slotId: next, clip });
    next += 1;
    return root;
  };
  const part = <T extends Mesh>(root: Mesh, mesh: T, x = 0, y = 0, z = 0, scaleX = 1, scaleY = scaleX): T => {
    mesh.parent = root;
    mesh.position.set(x, y, z);
    mesh.scaling.set(scaleX, scaleY, 1);
    return mesh;
  };
  const label = (root: Mesh, text: string, size: number, wrap: [number, number], extra: Record<string, unknown> = {}, y = 0) =>
    part(root, createText2DMesh(scene, `${root.name}|label`, { text, size, wrapWidth: wrap[0], wrapHeight: wrap[1], ...extra }, assets), 0, y, -0.05);
  const panel = (root: Mesh, tint: [number, number, number, number], width: number, height: number, z = 0.05) => {
    const mesh = MeshBuilder.CreatePlane(`${root.name}|background`, { width: 1, height: 1 }, scene);
    applyOverlayUnlitMaterial(mesh);
    if (options.panelMaterial) mesh.material = options.panelMaterial;
    applyOverlayVisualStyle(mesh, { tint });
    return part(root, mesh, 0, 0, z, width, height);
  };
  const icon = (root: Mesh, guid: string, x = 0, y = 0, z = 0, scale = 1) =>
    part(root, createOverlayTextureQuad(scene, `${root.name}|icon:${guid}`, guid, assets), x, y, z, scale);
  const texturePanel = (x: number, y: number, width: number, height: number) => {
    const root = actor(x, y, 0.4);
    const mesh = createOverlayPanelMesh(scene, `${root.name}|panel`,
      { source: "texture", textureGuid: "colormap", materialGuid: null, marginLeft: 0.0625, marginRight: 0.0625, marginTop: 0.0625, marginBottom: 0.0625, hitTest: "ignore", destWidth: width, destHeight: height }, assets);
    applyOverlayVisualStyle(mesh, { tint: [0.09, 0.1, 0.15, 0.82] });
    // The panel's vertices span its destination size divided by it (-0.5..0.5): the actor's scale gives it in Play.
    part(root, mesh, 0, 0, 0, width, height);
  };

  // Header: title bar, rich text with an image, an underline and letter effects (revealed), the safe area label.
  panel(actor(0, 7.95, 0.4), [0.4, 0.3, 0.8, 0.55], 16, 1.7);
  label(actor(0, 8.35), "Haptic Feature Test", 44, [900, 60], { bold: true, alignment: "center", outline: 2 });
  const rich = actor(0, 7.55);
  part(rich, createText2DMesh(scene, `${rich.name}|rich`, {
    text: "[b]Rich[/b] [i]Text[/i] [color=orange]color[/color] [size=36]size[/size] [u]under[/u] [img=camera size=28] " +
      "[wave=3 intensity=1.2]wave[/wave] [shake=1]shake[/shake] [hover=1]hover[/hover] [rotate=10]tilt[/rotate]",
    size: 30, wrapWidth: 1500, wrapHeight: 44, alignment: "center", appearModes: ["fade", "slide"], appearProgress: 1,
  }, assets, { rich: true, isPaused: () => true }));
  label(actor(-15.4, 8.6), "Safe Area", 24, [220, 32], { color: [0.7, 0.9, 1] });

  // Form controls over a texture panel.
  texturePanel(-13.45, 2.55, 4.7, 5.4);
  label(actor(-13.45, 4.9), "Form Controls", 28, [410, 34], { bold: true, color: [1, 0.86, 0.42] });
  const controls: Array<[string, Record<string, unknown>]> = [
    ["2DSliderComponent", { width: 4.1, max: 100, value: 40, thumbTextureGuid: "point_light" }],
    ["2DRangeSliderComponent", { width: 4.1, max: 10, lowerValue: 2, upperValue: 7 }],
    ["2DCheckboxComponent", { width: 0.5, checked: true }],
    ["2DRadioButtonComponent", { width: 0.5, checked: true }],
    ["2DRadioButtonComponent", { width: 0.5 }],
    ["2DToggleComponent", { width: 1, checked: true }],
    ["2DTextInputComponent", { width: 4.1, text: "FeatureTest" }],
    ["2DNumericInputComponent", { width: 4.1, value: 42 }],
    ["2DDropdownComponent", { width: 4.1, options: ["Low", "Medium", "High", "Epic"], selectedIndex: 2 }],
    ["2DProgressBarComponent", { width: 4.1, height: 0.35, value: 0.65 }],
  ];
  controls.forEach(([classId, properties], index) => {
    const row = index >= 2 && index <= 5;
    const root = actor(row ? -15.25 + (index - 2) * 0.85 : -13.45, 4.24 - (row ? 2 : index < 2 ? index : index - 3) * 0.67);
    part(root, createUIControl2DMesh(scene, `${root.name}|control`, { classId, properties: { height: 0.5, fontSize: 0.28, ...properties } }, assets));
  });

  // Containers over a texture panel: a scroll box of text rows, a virtualized list and grid, each clipped to its box.
  texturePanel(13.45, 2.2, 4.7, 6.5);
  label(actor(13.45, 5.2), "Containers", 28, [410, 34], { bold: true, color: [1, 0.86, 0.42] });
  const scroll: OverlayLayoutRect = { x: 13.45, y: 3.68, width: 4.1, height: 1.9 };
  panel(actor(scroll.x, scroll.y, 0.2), [0.15, 0.2, 0.3, 0.6], scroll.width, scroll.height, 0);
  for (let row = 0; row < 10; row += 1)
    label(actor(13.6, 4.45 - row * 0.38, 0, scroll), `Scroll Row ${String(row + 1).padStart(2, "0")}`, 24, [390, 32], { color: row % 2 ? [0.75, 0.85, 1] : [1, 1, 1] });
  const list: OverlayLayoutRect = { x: 13.45, y: 1.77, width: 4.1, height: 1.7 };
  panel(actor(list.x, list.y, 0.2), [0.15, 0.2, 0.3, 0.6], list.width, list.height, 0);
  for (let row = 0; row < 7; row += 1) {
    const root = actor(13.45, 2.45 - row * 0.4, 0, list);
    panel(root, [0.2, 0.32, 0.5, 0.85], 4.1, 0.34);
    label(root, `Row ${row}`, 22, [380, 28]);
  }
  const grid: OverlayLayoutRect = { x: 13.45, y: -0.25, width: 4.1, height: 1.6 };
  panel(actor(grid.x, grid.y, 0.2), [0.15, 0.2, 0.3, 0.6], grid.width, grid.height, 0);
  for (let cell = 0; cell < 24; cell += 1) {
    const root = actor(11.7 + (cell % 6) * 0.68, 0.25 - Math.floor(cell / 6) * 0.68, 0, grid);
    icon(root, "navmesh", 0, 0.05, 0.05, 0.75);
    label(root, `#${cell}`, 18, [60, 22], { alignment: "center", outline: 1 }, -0.2);
  }

  // Widget row: icons, a tinted swatch, a button, an overlay box and two masked images.
  icon(actor(-10.9, -6.55), "camera");
  panel(actor(-9.95, -6.55), [1, 1, 1, 1], 0.9, 0.9, 0);
  const button = actor(-8.1, -6.55);
  panel(button, [0.25, 0.6, 1, 1], 2.6, 0.7);
  label(button, "Click Me", 26, [250, 32], { alignment: "center", bold: true });
  const overlayBox = actor(-1.5, -6.55);
  panel(overlayBox, [0.9, 0.5, 0.2, 0.9], 3, 0.8);
  label(overlayBox, "Overlay Box", 24, [280, 30], { alignment: "center" });
  icon(actor(1.6, -6.55, 0, { x: 1.6, y: -6.55, width: 1.8, height: 0.8 }), "spot_light", 0, 0, 0, 3);
  icon(actor(3.2, -6.55, 0, { x: 3.2, y: -6.55, width: 0.8, height: 0.8 }), "particles", 0, 0, 0, 2);
  icon(actor(4.35, -6.55), "audio");

  // Class row: the card switcher and one sample of every item and card Class.
  const switcher = actor(-9.4, -8.15);
  panel(switcher, [0.12, 0.12, 0.18, 0.7], 2.95, 0.95, 0.1);
  panel(switcher, [0.3, 0.55, 1, 0.95], 2.8, 0.85);
  label(switcher, "Card A (slot 0)", 26, [270, 32], { alignment: "center", bold: true });
  label(actor(-1.2, -8.15), "Class Samples", 24, [230, 30], { color: [0.7, 0.9, 1] });
  const listSample = actor(1.6, -8.15);
  panel(listSample, [0.2, 0.32, 0.5, 0.85], 4.1, 0.34);
  label(listSample, "Row 7", 22, [380, 28]);
  const gridSample = actor(4.25, -8.15);
  icon(gridSample, "navmesh", 0, 0.05, 0.05, 0.75);
  label(gridSample, "#3", 18, [60, 22], { alignment: "center", outline: 1 }, -0.2);
  for (const [index, tint] of [[0.3, 0.55, 1, 0.95], [1, 0.55, 0.25, 0.95]].entries()) {
    const card = actor(6.4 + index * 2.1, -8.15);
    card.scaling.set(0.6, 0.6, 1);
    panel(card, tint as [number, number, number, number], 2.8, 0.85);
    label(card, index ? "Card B" : "Card A", 26, [270, 32], { alignment: "center", bold: true });
  }

  part(actor(-14.2, -7.35), createJoystick2DMesh(scene, `actor-${next - 1}|stick`, { radius: 1, joystickRadius: 0.42 }));

  const layout = new OverlayLayoutRenderer(() => scene);
  layout.apply({
    type: "sceneLayerLayout", layerId: "hud",
    entries: clipped.map(({ slotId, clip }) => ({ slotId, actorId: `actor-${slotId}`, rect: clip, clip: { ...clip }, scrollAncestors: [] })),
  });
  return layout;
}
