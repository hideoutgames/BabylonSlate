import { expect, test, type Locator } from "@playwright/test";
import { createActor, createDefaultScene, createDefaultSceneLayer, createMeshComponent, MAIN_SCENE_FILE } from "../packages/core/src/index.ts";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultMigrationRegistry } from "../packages/assets/src/migration";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openMainScene } from "./open-test-project";

async function border(canvas: Locator) {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width; copy.height = node.height;
    const ctx = copy.getContext("2d")!; ctx.drawImage(node, 0, 0);
    const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
    const points: [number, number][] = [];
    for (let y = 0; y < copy.height; y++) for (let x = 0; x < copy.width; x++) {
      const i = (y * copy.width + x) * 4;
      if (data[i]! > 180 && data[i + 1]! > 120 && data[i + 1]! < 220 && data[i + 2]! < 90) points.push([x, y]);
    }
    if (points.length < 100) return { complete: false, x: 0, y: 0 };
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    const topXs = new Set(points.filter(p => p[1] <= top + 3).map(p => p[0]));
    const bottomXs = new Set(points.filter(p => p[1] >= bottom - 3).map(p => p[0]));
    const leftYs = new Set(points.filter(p => p[0] <= left + 3).map(p => p[1]));
    const rightYs = new Set(points.filter(p => p[0] >= right - 3).map(p => p[1]));
    const complete = right - left > 100 && bottom - top > 50 && left > 5 && top > 5 && right < copy.width - 5 && bottom < copy.height - 5 &&
      Math.min(topXs.size, bottomXs.size) > (right - left) * .9 && Math.min(leftYs.size, rightYs.size) > (bottom - top) * .9;
    return { complete, x: (left + right) / 2, y: (top + bottom) / 2 };
  });
}

for (const kind of ["Scene", "SceneLayer"] as const) {
  test(`${kind} bounds keep all four edges while panning, zooming and moving actors`, async ({ page }, testInfo) => {
    const files = await minimalProjectFiles();
    const scene = kind === "Scene" ? createDefaultScene("2d") : createDefaultSceneLayer();
    scene.actors = [createActor("subject", "Subject", {
      classId: kind === "SceneLayer" ? "SceneLayerActor" : "Actor",
      components: kind === "SceneLayer" ? [{ id: "texture", classId: "2DTextureComponent", properties: {} }] : [createMeshComponent("mesh", "box")],
    })];
    if ("layerBounds" in scene.settings) scene.settings.layerBounds = { width: 16, height: 9 };
    const path = kind === "Scene" ? MAIN_SCENE_FILE : "assets/Guide.scenelayer.babasset";
    files.set(path, await encodeAssetDocument({
      guid: kind === "Scene" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000021", type: kind, name: "Guide",
      version: createDefaultMigrationRegistry().currentVersion(kind), payload: scene as unknown as Record<string, unknown>,
    }));
    await openMinimalTestProject(page, files);
    if (kind === "Scene") await openMainScene(page); else await openAssetFromBrowser(page, path);
    const canvas = page.getByTestId("viewport-canvas");
    await expect(canvas).toBeVisible();
    await canvas.hover();
    await page.mouse.wheel(0, 350);
    await expect.poll(async () => (await border(canvas)).complete).toBe(true);
    const initial = await border(canvas);
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * .25, box.y + box.height * .75);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .25 + 35, box.y + box.height * .75 + 20, { steps: 2 });
    await page.mouse.up();
    await expect.poll(async () => (await border(canvas)).complete).toBe(true);
    await expect.poll(async () => Math.abs((await border(canvas)).x - initial.x)).toBeGreaterThan(10);
    const panned = await border(canvas);
    await page.getByRole("treeitem", { name: "Subject", exact: true }).click();
    await page.getByRole("textbox", { name: "Position X", exact: true }).fill("2");
    await page.getByRole("textbox", { name: "Position X", exact: true }).press("Tab");
    await expect.poll(async () => (await border(canvas)).complete).toBe(true);
    expect(Math.abs((await border(canvas)).x - panned.x)).toBeLessThan(3);
    await canvas.hover(); await page.mouse.wheel(0, 100);
    await expect.poll(async () => (await border(canvas)).complete).toBe(true);
    await canvas.screenshot({ path: testInfo.outputPath("complete-guide.png") });
  });
}
