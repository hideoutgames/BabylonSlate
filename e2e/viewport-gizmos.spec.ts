import { expect, test, type Locator } from "@playwright/test";
import { createActor, createDefaultScene, createMeshComponent } from "../packages/core/src/index.ts";
import { openAssetFromBrowser, openMainScene, openTestProject } from "./open-test-project";
import { setPreviewScene } from "./preview-parity";
import { clickPlayAndWaitForOverlay } from "./play";

/** Locate actual handle pixels, without reaching into the utility scene. */
async function handles(canvas: Locator) {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    const colors = [0, 0, 0];
    const red: { x: number; y: number }[] = [];
    for (let i = 0; i < pixels.length; i += 4) {
      const rgb = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
      for (let axis = 0; axis < 3; axis++) {
        if (rgb[axis]! > 80 && rgb[axis]! > rgb[(axis + 1) % 3]! * 1.2 && rgb[axis]! > rgb[(axis + 2) % 3]! * 1.2) {
          colors[axis]!++;
          // The orange selection outline is also red-dominant; the red axis
          // has nearly equal green/blue channels and is the draggable target.
          if (axis === 0 && Math.abs(rgb[1]! - rgb[2]!) < rgb[0]! * 0.18) red.push({ x: (i / 4) % copy.width, y: Math.floor(i / 4 / copy.width) });
        }
      }
    }
    // Select a solid pixel near the outer arrow rather than averaging across empty space.
    red.sort((a, b) => a.x - b.x);
    const point = red[Math.floor(red.length * 0.8)];
    return { colors, point: point ? { x: point.x / copy.width, y: point.y / copy.height } : null };
  });
}

test("selected objects show Move, Rotate, and Scale handles and a pointer drag is undoable", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await openTestProject(page);
  await openMainScene(page);
  const scene = createDefaultScene();
  scene.settings.grid.showGrid = false;
  scene.settings.environmentColor = [0, 0, 0];
  scene.settings.environmentTextureGuid = null;
  scene.actors = [createActor("gizmo-box", "Gizmo Box", { components: [createMeshComponent("gizmo-mesh", "box")] })];
  await setPreviewScene(page, scene);
  await page.getByTestId("tree-row-actor:gizmo-box").click();
  const canvas = page.getByTestId("viewport-canvas");
  for (const mode of ["3d", "2d"] as const) {
    if (mode === "2d") await page.getByTestId("viewport-mode-toggle").click();
    for (const tool of ["translate", "rotate", "scale"] as const) {
      await page.getByTestId(`gizmo-tool-${tool}`).click();
      await expect.poll(async () => (await handles(canvas)).colors.reduce((a, b) => a + b, 0)).toBeGreaterThan(30);
      if (mode === "3d") await expect.poll(async () => Math.min(...(await handles(canvas)).colors)).toBeGreaterThan(5);
    }
  }
  await page.getByTestId("gizmo-tool-translate").click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(async () => (await handles(canvas)).colors[0]).toBeGreaterThan(10);
  const point = (await handles(canvas)).point!;
  await testInfo.attach("move-handles", { body: await canvas.screenshot(), contentType: "image/png" });
  await testInfo.attach("handle-pixels", { body: JSON.stringify(await handles(canvas)), contentType: "application/json" });
  const bounds = (await canvas.boundingBox())!;
  const x = bounds.x + bounds.width * point.x;
  const y = bounds.y + bounds.height * point.y;
  const documentX = () => page.evaluate(() => (window as unknown as {
    __babylonslateTest: { activeSceneActorPosition(): number[] | null };
  }).__babylonslateTest.activeSceneActorPosition()![0]!);
  const before = await documentX();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(documentX).not.toBe(before);
  await page.getByTestId("undo-document").click();
  await expect.poll(documentX).toBeCloseTo(before, 5);
  await page.getByTestId("gizmo-tool-rotate").click();
  await clickPlayAndWaitForOverlay(page);
  await page.getByTestId("play-overlay-close").click();
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  await expect(page.getByTestId("gizmo-tool-rotate")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await handles(canvas)).colors[2], { timeout: 30_000 }).toBeGreaterThan(30);

  // Prefab presents a depth-backed RTT through the same shared Engine.
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  const components = [createMeshComponent("prefab-mesh", "box")];
  expect(await page.evaluate((components) => (window as unknown as {
    __babylonslateTest: { setMainGraphComponents(value: typeof components): Promise<boolean> };
  }).__babylonslateTest.setMainGraphComponents(components), components)).toBe(true);
  await page.getByTestId("tree-row-prefab-mesh").click();
  await page.locator(".dv-tab").filter({ hasText: "Prefab" }).click();
  const prefab = page.getByTestId("prefab-preview-canvas");
  await expect(prefab).toBeVisible();
  for (const tool of ["translate", "rotate", "scale"] as const) {
    await page.getByTestId(`prefab-gizmo-tool-${tool}`).click();
    await expect.poll(async () => Math.min(...(await handles(prefab)).colors), { timeout: 20_000 }).toBeGreaterThan(5);
  }
  await testInfo.attach("prefab-handles", { body: await prefab.screenshot(), contentType: "image/png" });
});
