import { expect, test, type Locator } from "@playwright/test";
import { createActor, createDefaultScene, createDefaultSceneLayer, createMeshComponent, MAIN_SCENE_FILE } from "../packages/core/src/index.ts";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";

async function hudPixels(canvas: Locator) {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width; copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let white = 0, red = 0;
    for (let y = 0; y < copy.height; y++) for (let x = 0; x < copy.width; x++) {
      const i = (y * copy.width + x) * 4;
      const u = x / copy.width, v = y / copy.height;
      if (u > .2 && u < .3 && v > .3 && v < .37 && pixels[i]! > 240 && pixels[i + 1]! > 240 && pixels[i + 2]! > 240) white++;
      if (u > .7 && u < .8 && v > .63 && v < .7 && pixels[i]! > 240 && pixels[i + 1]! < 10 && pixels[i + 2]! < 10) red++;
    }
    return { textureInHud: white > 100, materialInHud: red > 100 };
  });
}

for (const mode of ["Play", "Preview Build"] as const) {
  test(`SceneLayer texture and material stay in HUD coordinates after world loading in ${mode}`, async ({ page }, testInfo) => {
    test.setTimeout(120000);
    const files = await minimalProjectFiles();
    const versions = createDefaultMigrationRegistry();
    const layerGuid = "00000000-0000-4000-8000-000000000021";
    const materialGuid = "00000000-0000-4000-8000-000000000022";
    const material = createDefaultMaterialDocument("HUD Red");
    material.shadingModel = "unlit";
    material.nodes[0]!.properties.value = [1, 0, 0];
    files.set("assets/HudRed.material.babasset", await encodeAssetDocument({
      guid: materialGuid, type: "Material", name: "HUD Red", version: versions.currentVersion("Material"), payload: material as unknown as Record<string, unknown>,
    }));
    const layer = createDefaultSceneLayer();
    layer.actors = [
      createActor("hud-texture", "HUD Texture", {
        classId: "SceneLayerActor",
        transform: { position: [-8, 3, 0], rotation: [0, 0, 0, 1], scale: [4, 2, 1] },
        components: [{ id: "texture", classId: "2DTextureComponent", properties: {} }],
      }),
      createActor("hud-material", "HUD Material", {
        classId: "SceneLayerActor",
        transform: { position: [8, -3, 0], rotation: [0, 0, 0, 1], scale: [4, 2, 1] },
        components: [{ id: "material", classId: "2DMaterialComponent", properties: { materialGuid } }],
      }),
    ];
    files.set("assets/Hud.scenelayer.babasset", await encodeAssetDocument({
      guid: layerGuid, type: "SceneLayer", name: "HUD", version: versions.currentVersion("SceneLayer"), payload: layer as unknown as Record<string, unknown>,
    }, { dependencies: [materialGuid] }));
    const scene = createDefaultScene();
    const camera = scene.actors.find((actor) => actor.id === scene.settings.mainCameraActorId)!;
    camera.transform.position[0] += 1000;
    scene.actors = [camera, createActor("world-box", "World Box", {
      transform: { position: [1000, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: [createMeshComponent("world-mesh", "box")],
    })];
    scene.settings.environmentColor = [0, 0, 0];
    scene.settings.sceneLayers = [{ assetGuid: layerGuid, zOrder: 0, enabled: true }];
    files.set(MAIN_SCENE_FILE, await encodeAssetDocument({
      guid: "00000000-0000-4000-8000-000000000001", type: "Scene", name: "Main", version: versions.currentVersion("Scene"), payload: scene as unknown as Record<string, unknown>,
    }, { dependencies: [layerGuid] }));
    await openMinimalTestProject(page, files);
    await openMainScene(page);
    let canvas: Locator;
    if (mode === "Play") {
      await clickPlayAndWaitForOverlay(page);
      canvas = page.getByTestId("play-canvas");
    } else {
      await page.getByTestId("debug-menu").click();
      await page.getByTestId("preview-build-toggle").click();
      await page.getByTestId("play-preview").click();
      await waitForPreviewBuildBoot(page);
      canvas = page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-canvas");
    }
    await expect.poll(() => canvas.evaluate(() => {
      const host = globalThis as unknown as {
        __babylonslatePlayTest?: { visuals: () => Array<{ visible: boolean; position: number[] }> };
        __babylonslatePlayerTest?: { visuals: () => Array<{ visible: boolean; position: number[] }> };
      };
      return (host.__babylonslatePlayTest ?? host.__babylonslatePlayerTest)?.visuals().some((visual) => visual.visible && Math.abs(visual.position[0]! - 1000) < .1) ?? false;
    }), { timeout: 30000 }).toBe(true);
    await expect.poll(() => hudPixels(canvas), { timeout: 30000 }).toEqual({ textureInHud: true, materialInHud: true });
    await canvas.screenshot({ path: testInfo.outputPath("hud-after-world-load.png") });
    await page.getByTestId(mode === "Play" ? "play-overlay-close" : "preview-build-close").click();
  });
}
