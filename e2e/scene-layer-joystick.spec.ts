import { expect, test, type Locator } from "@playwright/test";
import { createActor, createDefaultScene, createDefaultSceneLayer, MAIN_SCENE_FILE } from "../packages/core/src/index.ts";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";

async function colorAt(canvas: Locator, x: number) {
  return canvas.evaluate((node: HTMLCanvasElement, localX) => {
    const copy = document.createElement("canvas");
    copy.width = node.width; copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const [r, g, b] = context.getImageData(Math.round((0.5 + localX / 32) * copy.width), Math.round(copy.height / 2), 1, 1).data;
    return r! > 220 && g! < 30 && b! < 30 ? "red" : b! > 220 && r! < 30 && g! < 30 ? "blue" : "other";
  }, x);
}

for (const mode of ["Play", "Preview Build"] as const) {
  test(`@ipad SceneLayer joystick touch moves its custom material and resets on cancellation in ${mode}`, async ({ page }, testInfo) => {
    test.setTimeout(120000);
    const files = await minimalProjectFiles(), versions = createDefaultMigrationRegistry();
    const layerGuid = "00000000-0000-4000-8000-000000000051";
    const backgroundGuid = "00000000-0000-4000-8000-000000000052";
    const joystickGuid = "00000000-0000-4000-8000-000000000053";
    for (const [guid, name, color] of [[backgroundGuid, "Background", [1, 0, 0]], [joystickGuid, "Joystick", [0, 0, 1]]] as const) {
      const material = createDefaultMaterialDocument(name);
      material.shadingModel = "unlit";
      material.nodes[0]!.properties.value = [...color];
      files.set(`assets/${name}.material.babasset`, await encodeAssetDocument({ guid, type: "Material", name,
        version: versions.currentVersion("Material"), payload: material as unknown as Record<string, unknown> }));
    }
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("stick", "Stick", { classId: "SceneLayerActor", components: [{ id: "joystick", classId: "2DJoystickComponent",
      properties: { radius: 3, joystickRadius: 1, backgroundMaterialGuid: backgroundGuid, joystickMaterialGuid: joystickGuid } }] })];
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
    await expect.poll(() => colorAt(canvas, 0), { timeout: 30000 }).toBe("blue");
    await expect.poll(() => colorAt(canvas, 2.5)).toBe("red");
    // Rendering can finish before Play dismisses its loading overlay. CDP touch
    // injection has no actionability checks, so wait until the canvas owns hits.
    await canvas.click({ trial: true });
    const box = (await canvas.boundingBox())!;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 };
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [center] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...center, x: center.x + box.width / 8 }] });
    await expect.poll(() => colorAt(canvas, 0)).toBe("red");
    await expect.poll(() => colorAt(canvas, 2)).toBe("blue");
    if (mode === "Play") await expect.poll(async () => Number(await page.getByTestId("play-move-x").getAttribute("data-move-x"))).toBeGreaterThan(0.9);
    await canvas.screenshot({ path: testInfo.outputPath("joystick-drag.png") });
    await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect.poll(() => colorAt(canvas, 0)).toBe("blue");
    await expect.poll(() => colorAt(canvas, 2.5)).toBe("red");
    if (mode === "Play") await expect.poll(async () => Number(await page.getByTestId("play-move-x").getAttribute("data-move-x"))).toBe(0);
    await session.detach();
    await page.getByTestId(mode === "Play" ? "play-overlay-close" : "preview-build-close").click();
  });
}
