import { expect, test, type Page } from "@playwright/test";
import type { SerializedScene } from "../packages/core/src/scene";
import { createDefaultScene, MAIN_SCENE_FILE } from "../packages/core/src/project";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { decodeAssetDocument, encodeAssetDocument } from "../packages/assets/src/asset-document";
import { normalizeModelPayload } from "../packages/assets/src/model-payload";
import { encodeTriangleGlb } from "../packages/render/src/model-mesh";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene, waitForSceneViewportReady, waitForEditorInteractive } from "./open-test-project";
import { closeProjectViaSettings } from "./close-project";
import { saveAllIfEnabled } from "./save-all";
import { IPAD_TEST_TAG } from "./ipad-tag";

async function selectMode(page: Page, label: string) {
  await page.getByTestId("scene-mode-select").click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await expect(page.getByTestId("scene-mode-select")).toContainText(label);
  await waitForSceneViewportReady(page);
}
async function content(page: Page): Promise<SerializedScene> {
  return page.evaluate(() => (globalThis as unknown as { __babylonslateTest: { activeSceneContent(): SerializedScene } }).__babylonslateTest.activeSceneContent());
}
async function landscapeProjectFiles() {
  const files = await minimalProjectFiles();
  const document = await decodeAssetDocument(files.get(MAIN_SCENE_FILE)!);
  const scene = document.payload as unknown as SerializedScene;
  scene.actors.push(...createDefaultScene().actors.filter((actor) => actor.components.some((component) => component.classId === "LightComponent")));
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument(document, { dependencies: ["00000000-0000-4000-8000-000000000002"] }));
  return files;
}
async function terrainPixelFraction(page: Page) {
  return page.getByTestId("viewport-canvas").evaluate((node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width; copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
    let terrain = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const channels = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
      if (pixels[i + 3]! > 0 && Math.max(...channels) - Math.min(...channels) < 15) terrain++;
    }
    return terrain / (copy.width * copy.height);
  });
}
async function stroke(page: Page, touch: boolean) {
  const box = await page.getByTestId("viewport-canvas").boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2; const y = box!.y + box!.height / 2;
  if (touch) {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 24, y }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
  } else {
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 24, y, { steps: 4 }); await page.mouse.up();
  }
}
async function toggleWindow(page: Page, id: string) {
  await page.getByTestId("windows-menu").click();
  await page.getByTestId(`windows-menu-${id}`).click();
  await page.keyboard.press("Escape");
}

test.describe("Scene modes", { tag: IPAD_TEST_TAG }, () => {
  test("sculpts terrain and restores independent mode layouts, Focus, and saved content", async ({ page, isMobile }, testInfo) => {
    test.setTimeout(150_000);
    await openMinimalTestProject(page, await landscapeProjectFiles()); await openMainScene(page);
    await expect(page.getByTestId("scene-mode-select")).toContainText("Design");
    await selectMode(page, "Landscape");
    await page.getByRole("button", { name: "Create Landscape", exact: true }).click();
    await expect(page.getByRole("treeitem", { name: /Landscape 1/ })).toBeVisible();
    await page.getByRole("button", { name: "Frame", exact: true }).click();
    await expect.poll(() => terrainPixelFraction(page)).toBeGreaterThan(0.02);
    await page.getByRole("button", { name: "Raise", exact: true }).click();
    const heightSum = async () => (await content(page)).actors.flatMap((actor) => actor.components).filter((c) => c.classId === "LandscapeComponent").flatMap((c) => c.properties.heights as number[]).reduce((sum, value) => sum + value, 0);
    await stroke(page, isMobile);
    await expect.poll(heightSum).toBeGreaterThan(0);
    await page.getByTestId("undo-document").click();
    await expect.poll(heightSum).toBe(0);
    await page.getByTestId("redo-document").click();
    await expect.poll(heightSum).toBeGreaterThan(0);
    if (isMobile) expect((await page.getByRole("button", { name: "Create Landscape", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const row = page.getByRole("treeitem", { name: /Landscape 1/ });
    await expect(row).toBeInViewport();
    const rowBox = (await row.boundingBox())!;
    const treeBox = (await page.getByRole("tree", { name: "Landscape Components" }).boundingBox())!;
    expect(rowBox.y).toBeGreaterThanOrEqual(treeBox.y);
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(treeBox.y + treeBox.height);
    if (isMobile) expect(rowBox.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath("landscape.png") });
    await toggleWindow(page, "landscape-outliner");
    await selectMode(page, "Foliage");
    await page.getByTestId("focus-layout").click();
    await expect(page.getByTestId("focus-layout")).toHaveAttribute("aria-pressed", "true");
    await selectMode(page, "Design");
    await expect(page.getByTestId("focus-layout")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("scene-outliner-panel")).toContainText("Landscape 1");
    await selectMode(page, "Foliage");
    await expect(page.getByTestId("focus-layout")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("focus-layout").click();
    await selectMode(page, "Landscape");
    await expect(page.getByRole("tree", { name: "Landscape Components" })).toHaveCount(0);
    await saveAllIfEnabled(page);
    const saved = await heightSum();
    await closeProjectViaSettings(page);
    await page.getByTestId("open-listed-project-TestProject").click();
    await waitForEditorInteractive(page); await openMainScene(page);
    await expect(page.getByTestId("scene-mode-select")).toContainText("Landscape");
    await expect(page.getByRole("tree", { name: "Landscape Components" })).toHaveCount(0);
    expect(await heightSum()).toBe(saved);
  });

  test("selects only Models and paints one undoable foliage component per stroke", async ({ page, isMobile }) => {
    test.setTimeout(120_000);
    const files = await landscapeProjectFiles();
    const guid = "00000000-0000-4000-8000-000000000010";
    files.set("assets/brush.model.babasset", await encodeAssetDocument({ guid, name: "Brush Model", type: "Model", version: 1, payload: {} }, {
      headerPayload: { ...normalizeModelPayload({}) },
      extraChunks: [{ id: "source", kind: "geometry", mime: "model/gltf-binary", data: encodeTriangleGlb() }],
    }));
    await openMinimalTestProject(page, files); await openMainScene(page);
    await selectMode(page, "Landscape");
    await page.getByRole("button", { name: "Create Landscape", exact: true }).click();
    await page.getByRole("button", { name: "Frame", exact: true }).click();
    await selectMode(page, "Foliage");
    await page.getByRole("button", { name: "New Group", exact: true }).click();
    await page.getByRole("button", { name: "Add Model", exact: true }).click();
    await expect(page.getByTestId("asset-picker")).not.toContainText("Main");
    await page.getByTestId("asset-picker").getByText("Brush Model", { exact: true }).click();
    await page.getByRole("button", { name: "Paint Foliage", exact: true }).click();
    await stroke(page, isMobile);
    const foliage = async () => (await content(page)).actors.flatMap((actor) => actor.components).filter((component) => component.classId === "FoliageComponent");
    await expect.poll(async () => (await foliage()).length).toBe(1);
    const painted = (await foliage())[0]!;
    const batches = painted.properties.batches as Array<{ modelGuid: string; transforms: unknown[] }>;
    expect(batches.map((batch) => batch.modelGuid)).toEqual([guid]);
    expect(batches[0]!.transforms.length).toBeGreaterThan(1);
    await page.getByTestId("undo-document").click();
    await expect.poll(async () => (await foliage()).length).toBe(0);
    await page.getByTestId("redo-document").click();
    await expect.poll(async () => (await foliage()).length).toBe(1);
    await selectMode(page, "Design");
    await expect(page.getByTestId("scene-outliner-panel")).toContainText("Foliage Group 1 Stroke");
  });
});
