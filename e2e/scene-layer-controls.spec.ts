import { expect, test, type Locator } from "@playwright/test";
import { createActor, createDefaultScene, createDefaultSceneLayer, MAIN_SCENE_FILE } from "../packages/core/src/index.ts";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";

async function colorAt(canvas: Locator, x: number, y: number) {
  return canvas.evaluate((node: HTMLCanvasElement, point) => {
    const copy = document.createElement("canvas");
    copy.width = node.width; copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const [r, g, b] = context.getImageData(Math.round((0.5 + point.x / 32) * copy.width), Math.round((0.5 - point.y / 18) * copy.height), 1, 1).data;
    return r! > 220 && g! < 30 && b! < 30 ? "red" : b! > 220 && r! < 30 && g! < 30 ? "blue" : "other";
  }, { x, y });
}

for (const mode of ["Play", "Preview Build"] as const) {
  test(`SceneLayer controls retain authored materials and edited values in ${mode}`, async ({ page }) => {
    test.setTimeout(120000);
    const files = await minimalProjectFiles(), versions = createDefaultMigrationRegistry();
    const layerGuid = "00000000-0000-4000-8000-000000000061";
    const redGuid = "00000000-0000-4000-8000-000000000062";
    const blueGuid = "00000000-0000-4000-8000-000000000063";
    for (const [guid, name, color] of [[redGuid, "Control Red", [1, 0, 0]], [blueGuid, "Control Blue", [0, 0, 1]]] as const) {
      const material = createDefaultMaterialDocument(name);
      material.shadingModel = "unlit";
      material.nodes[0]!.properties.value = [...color];
      files.set(`assets/${name}.material.babasset`, await encodeAssetDocument({ guid, type: "Material", name,
        version: versions.currentVersion("Material"), payload: material as unknown as Record<string, unknown> }));
    }
    const layer = createDefaultSceneLayer();
    layer.actors = [
      createActor("slider", "Slider", { classId: "SceneLayerActor", transform: { position: [0, 3, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, components: [{
        id: "slider-control", classId: "2DSliderComponent", properties: { width: 8, height: 1, value: 0.5,
          backgroundMaterialGuid: redGuid, trackMaterialGuid: redGuid, fillMaterialGuid: redGuid, thumbMaterialGuid: blueGuid },
      }] }),
      createActor("checkbox", "Checkbox", { classId: "SceneLayerActor", components: [{
        id: "checkbox-control", classId: "2DCheckboxComponent", properties: { width: 1, height: 1, checked: false,
          backgroundMaterialGuid: redGuid, indicatorMaterialGuid: blueGuid },
      }] }),
      createActor("text-input", "Text Input", { classId: "SceneLayerActor", transform: { position: [0, -3, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, components: [{
        id: "text-control", classId: "2DTextInputComponent", properties: { width: 8, height: 1, text: "Initial", maxLength: 12 },
      }] }),
    ];
    files.set("assets/Controls.scenelayer.babasset", await encodeAssetDocument({ guid: layerGuid, type: "SceneLayer", name: "Controls",
      version: versions.currentVersion("SceneLayer"), payload: layer as unknown as Record<string, unknown> }));
    const scene = createDefaultScene();
    scene.actors = scene.actors.filter(actor => actor.id === scene.settings.mainCameraActorId);
    scene.settings.environmentColor = [0, 0, 0];
    scene.settings.sceneLayers = [{ assetGuid: layerGuid, zOrder: 0, enabled: true }];
    files.set(MAIN_SCENE_FILE, await encodeAssetDocument({ guid: "00000000-0000-4000-8000-000000000001", type: "Scene", name: "Main",
      version: versions.currentVersion("Scene"), payload: scene as unknown as Record<string, unknown> }));
    await openMinimalTestProject(page, files);
    await openMainScene(page);
    if (mode === "Play") await clickPlayAndWaitForOverlay(page);
    else {
      await page.getByTestId("debug-menu").click();
      await page.getByTestId("preview-build-toggle").click();
      await page.getByTestId("play-preview").click();
      await waitForPreviewBuildBoot(page);
    }
    const canvas = mode === "Play" ? page.getByTestId("play-canvas") : page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-canvas");
    await expect.poll(() => colorAt(canvas, 0, 3), { timeout: 30000 }).toBe("blue");
    await expect.poll(() => colorAt(canvas, 2, 3)).toBe("red");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5625, box.y + box.height / 3);
    await page.mouse.up();
    await expect.poll(() => colorAt(canvas, 2, 3)).toBe("blue");
    await expect.poll(() => colorAt(canvas, 0, 3)).toBe("red");
    await expect.poll(() => colorAt(canvas, 0, 0)).toBe("red");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => colorAt(canvas, 0, 0)).toBe("blue");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => colorAt(canvas, 0, 0)).toBe("red");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 2 / 3);
    const nativeInput = mode === "Play" ? page.getByTestId("scene-layer-native-input")
      : page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("scene-layer-native-input");
    await expect(nativeInput).toHaveValue("Initial");
    await nativeInput.fill("Edited Text", { force: true });
    await nativeInput.press("Enter");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 2 / 3);
    await expect(nativeInput).toHaveValue("Edited Text");
    await page.getByTestId(mode === "Play" ? "play-overlay-close" : "preview-build-close").click();
  });
}
