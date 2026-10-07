import { expect, test } from "@playwright/test";
import { createActor, createDefaultScene, createDefaultSceneLayer, MAIN_CLASS_FILE, MAIN_SCENE_FILE, type SerializedComponent, type SerializedGraph } from "../packages/core/src/index.ts";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

test("SceneLayer compiled Tweens fade, tint and move rendered components after one trigger", async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const files = await minimalProjectFiles();
  const versions = createDefaultMigrationRegistry();
  const layerGuid = "00000000-0000-4000-8000-000000000031";
  const materialGuid = "00000000-0000-4000-8000-000000000032";
  const classGuid = "00000000-0000-4000-8000-000000000002";
  const material = createDefaultMaterialDocument("Tween White");
  material.shadingModel = "unlit";
  material.nodes[0]!.properties.value = [1, 1, 1];
  files.set("assets/TweenWhite.material.babasset", await encodeAssetDocument({
    guid: materialGuid, type: "Material", name: "Tween White", version: versions.currentVersion("Material"), payload: material as unknown as Record<string, unknown>,
  }));
  const components: SerializedComponent[] = [
    { id: "fade-texture", classId: "2DTextureComponent", properties: {},
      transform: { position: [-8, 3, 0], rotation: [0, 0, 0, 1], scale: [4, 2, 1] } },
    { id: "move-material", classId: "2DMaterialComponent", properties: { materialGuid },
      transform: { position: [-8, -3, 0], rotation: [0, 0, 0, 1], scale: [4, 2, 1] } },
  ];
  const actions: Array<[string, string, string, Record<string, unknown>]> = [
    ["fade", "tween.opacity", "2DTextureComponent", { a: 1, b: 0.25 }],
    ["tint", "tween.tint", "2DMaterialComponent", { a: { x: 1, y: 1, z: 1, w: 1 }, b: { x: 1, y: 0, z: 0, w: 1 } }],
    ["move", "tween.componentPosition", "2DMaterialComponent", { a: { x: -8, y: -3, z: 0 }, b: { x: 8, y: -3, z: 0 } }],
  ];
  // Separate native entries receive the same single key edge and run concurrently.
  // No Tick loop or renderer mutation performs any part of the interpolation.
  const graph: SerializedGraph = {
    members: [], components,
    nodes: actions.flatMap(([id, type, componentClassId, data], row) => [
      { id: `${id}-trigger`, type: "input.onAnyKeyPressed", data: {}, position: { x: 0, y: row * 220 } },
      { id: `${id}-target`, type: "component.getNamed", data: { componentClassId, implicitSelf: true }, position: { x: 200, y: row * 220 } },
      { id, type, data: { ...data, duration: 1 }, position: { x: 450, y: row * 220 } },
      { id: `${id}-done`, type: "debug.print", data: { value: `Tween ${id} completed`, key: `tween-${id}`, duration: 30 }, position: { x: 750, y: row * 220 } },
    ]),
    edges: actions.flatMap(([id]) => [
      { id: `${id}-start`, source: `${id}-trigger`, sourceHandle: "execOut", target: id, targetHandle: "execIn" },
      { id: `${id}-reference`, source: `${id}-target`, sourceHandle: "out", target: id, targetHandle: "target" },
      { id: `${id}-completed`, source: id, sourceHandle: "execOut", target: `${id}-done`, targetHandle: "execIn" },
    ]),
  };
  files.set(MAIN_CLASS_FILE, await encodeAssetDocument({
    guid: classGuid, type: "Class", name: "Main", version: versions.currentVersion("Class"), payload: graph as unknown as Record<string, unknown>,
  }, { parentClass: "SceneLayerActor", dependencies: [materialGuid] }));
  const layer = createDefaultSceneLayer();
  layer.actors = [createActor("tween-hud", "Tween HUD", { classId: "main", components })];
  files.set("assets/TweenHud.scenelayer.babasset", await encodeAssetDocument({
    guid: layerGuid, type: "SceneLayer", name: "Tween HUD", version: versions.currentVersion("SceneLayer"), payload: layer as unknown as Record<string, unknown>,
  }, { dependencies: [classGuid, materialGuid] }));
  const scene = createDefaultScene();
  scene.actors = scene.actors.filter((actor) => actor.id === scene.settings.mainCameraActorId);
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.sceneLayers = [{ assetGuid: layerGuid, zOrder: 0, enabled: true }];
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({
    guid: "00000000-0000-4000-8000-000000000001", type: "Scene", name: "Main", version: versions.currentVersion("Scene"), payload: scene as unknown as Record<string, unknown>,
  }, { dependencies: [layerGuid] }));
  await openMinimalTestProject(page, files);
  await openMainScene(page);
  await clickPlayAndWaitForOverlay(page);
  const canvas = page.getByTestId("play-canvas");
  const readPixels = () => canvas.evaluate((node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width; copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const sample = (u: number, v: number) => {
      const pixels = context.getImageData(Math.floor(u * copy.width) - 3, Math.floor(v * copy.height) - 3, 6, 6).data;
      const rgb = [0, 0, 0];
      for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) rgb[c]! += pixels[i + c]! / 36;
      return rgb;
    };
    const fade = sample(.25, 1 / 3), start = sample(.25, 2 / 3), end = sample(.75, 2 / 3);
    return {
      initial: fade.every((c) => c > 240) && start.every((c) => c > 240) && end.every((c) => c < 20),
      // Alpha blending and output transfer can differ by backend; both must
      // retain a visibly dim gray texture rather than full white or vanished black.
      finished: fade.every((c) => c > 30 && c < 180) && Math.max(...fade) - Math.min(...fade) < 5 &&
        start.every((c) => c < 20) && end[0]! > 220 && end[1]! < 20 && end[2]! < 20,
    };
  });
  await expect.poll(async () => (await readPixels()).initial, { timeout: 30000 }).toBe(true);
  // Focus without a mouse-button edge: Any Key Pressed includes mouse buttons.
  await canvas.focus();
  await expect(canvas).toBeFocused();
  await page.keyboard.press("KeyT");
  for (const [id] of actions) await expect(page.getByTestId("print-overlay")).toContainText(`Tween ${id} completed`, { timeout: 30000 });
  await expect.poll(async () => (await readPixels()).finished, { timeout: 30000 }).toBe(true);
  const tick = () => page.evaluate(() => (globalThis as unknown as { __babylonslatePlayTest: { tickIndex(): number } }).__babylonslatePlayTest.tickIndex());
  const completedAt = await tick();
  await expect.poll(tick, { timeout: 30000 }).toBeGreaterThan(completedAt + 90);
  await expect.poll(async () => (await readPixels()).finished, { timeout: 10000 }).toBe(true);
  await canvas.screenshot({ path: testInfo.outputPath("tween-rendered-endpoints.png") });
  await page.getByTestId("play-overlay-close").click();
});
