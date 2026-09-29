import { expect, test } from "@playwright/test";
import { createActor, createDefaultScene, createDefaultSceneLayer, MAIN_SCENE_FILE, parsePainter2DProperties, type PainterCommand, type PainterPathSegment } from "../packages/core/src/index.ts";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";

const rectangle = (left: number, bottom: number, right: number, top: number): PainterPathSegment[] => [
  { kind: "move", point: [left, bottom] }, { kind: "line", point: [right, bottom] },
  { kind: "line", point: [right, top] }, { kind: "line", point: [left, top] }, { kind: "close" },
];

for (const mode of ["Play", "Preview Build"] as const) {
  test(`2D Painter clips curves and cuts holes in ${mode}`, async ({ page }) => {
    test.setTimeout(120000);
    const files = await minimalProjectFiles(), versions = createDefaultMigrationRegistry();
    const layerGuid = "00000000-0000-4000-8000-000000000031";
    const style = parsePainter2DProperties({});
    const commands: PainterCommand[] = [
      { kind: "draw", path: rectangle(-4, -4, 4, 4), fill: true, stroke: false, fillRule: "nonzero", style: { ...style, fillColor: [1, 0, 0, 1] } },
      { kind: "pushMask", path: rectangle(-4, -4, 0, 4), fillRule: "nonzero" },
      { kind: "draw", path: [{ kind: "ellipse", center: [0, 0], radius: [3, 3], start: 0, end: Math.PI * 2, rotation: 0, anticlockwise: false }], fill: true, stroke: false, fillRule: "nonzero", style },
      { kind: "cutout", path: [{ kind: "ellipse", center: [-1.5, 0], radius: [0.4, 0.4], start: 0, end: Math.PI * 2, rotation: 0, anticlockwise: false }], fillRule: "nonzero" },
      { kind: "popMask" },
      { kind: "draw", path: [{ kind: "move", point: [1, 1] }, { kind: "bezier", control1: [1, 3], control2: [3, 3], point: [3, 1] }, { kind: "close" }], fill: true, stroke: false, fillRule: "nonzero", style: { ...style, fillColor: [0, 0, 1, 1] } },
    ];
    const layer = createDefaultSceneLayer();
    layer.actors = [createActor("canvas", "Canvas", { classId: "SceneLayerActor", components: [{ id: "ink", classId: "2DPainterComponent", properties: { width: 8, height: 8, clearEachFrame: false, commands } }] })];
    files.set("assets/Painter.scenelayer.babasset", await encodeAssetDocument({ guid: layerGuid, type: "SceneLayer", name: "Painter", version: versions.currentVersion("SceneLayer"), payload: layer as unknown as Record<string, unknown> }));
    const scene = createDefaultScene();
    scene.actors = scene.actors.filter((actor) => actor.id === scene.settings.mainCameraActorId);
    scene.settings.environmentColor = [0, 0, 0];
    scene.settings.sceneLayers = [{ assetGuid: layerGuid, zOrder: 0, enabled: true }];
    files.set(MAIN_SCENE_FILE, await encodeAssetDocument({ guid: "00000000-0000-4000-8000-000000000001", type: "Scene", name: "Main", version: versions.currentVersion("Scene"), payload: scene as unknown as Record<string, unknown> }, { dependencies: [layerGuid] }));
    await openMinimalTestProject(page, files); await openMainScene(page);
    if (mode === "Play") await clickPlayAndWaitForOverlay(page);
    else {
      await page.getByTestId("debug-menu").click(); await page.getByTestId("preview-build-toggle").click();
      await page.getByTestId("play-preview").click(); await waitForPreviewBuildBoot(page);
    }
    const canvas = mode === "Play" ? page.getByTestId("play-canvas") : page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-canvas");
    await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => {
      const copy = document.createElement("canvas"); copy.width = node.width; copy.height = node.height;
      const context = copy.getContext("2d")!; context.drawImage(node, 0, 0);
      const sample = (x: number, y: number) => [...context.getImageData(Math.round((0.5 + x / 32) * copy.width), Math.round((0.5 - y / 18) * copy.height), 1, 1).data].slice(0, 3);
      const white = sample(-2.4, 0), red = sample(1.5, 0), blue = sample(2, 1.6), hole = sample(-1.5, 0);
      return { mask: white.every((v) => v > 230) && red[0]! > 230 && red[1]! < 20 && red[2]! < 20,
        curve: blue[0]! < 20 && blue[1]! < 20 && blue[2]! > 230, cutout: hole.every((v) => v < 30) };
    }), { timeout: 30000 }).toEqual({ mask: true, curve: true, cutout: true });
    await page.getByTestId(mode === "Play" ? "play-overlay-close" : "preview-build-close").click();
  });
}
