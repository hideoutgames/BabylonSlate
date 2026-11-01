import { expect, test, type Page } from "@playwright/test";
import type { SerializedScene } from "../packages/core/src/scene";
import { createDefaultScene, MAIN_SCENE_FILE } from "../packages/core/src/project";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { decodeAssetDocument, encodeAssetDocument } from "../packages/assets/src/asset-document";
import { normalizeModelPayload } from "../packages/assets/src/model-payload";
import { encodeUvSphereGlb } from "../packages/render/src/glb-test-fixtures";
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
  return page.evaluate(() => (globalThis as unknown as { __hapticTest: { activeSceneContent(): SerializedScene } }).__hapticTest.activeSceneContent());
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

test.describe("Scene modes", () => {
  test("sculpts terrain and restores independent mode layouts, Focus, and saved content", { tag: IPAD_TEST_TAG }, async ({ page, isMobile }, testInfo) => {
    test.setTimeout(150_000);
    await openMinimalTestProject(page, await landscapeProjectFiles()); await openMainScene(page);
    await expect(page.getByTestId("scene-mode-select")).toContainText("Design");
    const designIslandHeight = (await page.getByTestId("viewport-panel-frame").boundingBox())!.height;
    await selectMode(page, "Landscape");
    expect((await page.getByTestId("viewport-panel-frame").boundingBox())!.height).toBe(designIslandHeight);
    await page.getByRole("button", { name: "Create Landscape", exact: true }).click();
    await expect(page.getByRole("treeitem", { name: /Landscape 1/ })).toBeVisible();
    const collisions = page.getByRole("checkbox", { name: "Landscape Collisions", exact: true });
    await expect(collisions).not.toBeChecked();
    if (isMobile) await collisions.tap();
    else await collisions.check();
    await page.getByTestId("undo-document").click();
    await expect(collisions).not.toBeChecked();
    await page.getByTestId("redo-document").click();
    await expect(collisions).toBeChecked();
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
    expect((await page.getByTestId("viewport-panel-frame").boundingBox())!.height).toBe(designIslandHeight);
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
    expect((await content(page)).actors.flatMap((actor) => actor.components).find((component) => component.classId === "LandscapeComponent")!.properties.collisionsEnabled).toBe(true);
  });

  test("selects only Models and reopens saved, undoable foliage strokes", async ({ page, isMobile }) => {
    test.setTimeout(120_000);
    const files = await landscapeProjectFiles();
    const guid = "00000000-0000-4000-8000-000000000010";
    files.set("assets/brush.model.hasset", await encodeAssetDocument({ guid, name: "Brush Model", type: "Model", version: 1, payload: {} }, {
      headerPayload: { ...normalizeModelPayload({}) },
      extraChunks: [{ id: "source", kind: "geometry", mime: "model/gltf-binary", data: encodeUvSphereGlb(4, 8) }],
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
    await saveAllIfEnabled(page);
    await closeProjectViaSettings(page);
    await page.getByTestId("open-listed-project-TestProject").click();
    await waitForEditorInteractive(page);
    await openMainScene(page);
    await waitForSceneViewportReady(page);
    expect((await foliage())[0]!.properties.batches).toEqual(batches);
  });
  test("creates, renames and keeps a Timeline Clip in Timeline mode, with the Clips and Timeline windows", async ({ page }) => {
    test.setTimeout(120_000);
    await openMinimalTestProject(page, await minimalProjectFiles()); await openMainScene(page);
    await page.keyboard.press("Shift+5");
    await expect(page.getByTestId("scene-mode-select")).toContainText("Timeline");
    await waitForSceneViewportReady(page);
    await expect(page.getByTestId("timeline-clips-empty")).toBeVisible();
    await expect(page.getByTestId("scene-timeline-title")).toHaveText("No Timeline Clips");
    // Both windows sit in the default layout beside the Viewport, not on top of it.
    const viewport = (await page.getByTestId("viewport-panel-frame").boundingBox())!;
    const timeline = (await page.getByTestId("scene-timeline-panel").boundingBox())!;
    expect(timeline.y).toBeGreaterThanOrEqual(viewport.y + viewport.height - 1);
    await page.getByTestId("timeline-clips-new").click();
    const rename = page.getByTestId("timeline-clips-list").getByRole("textbox");
    await rename.fill("Intro");
    await rename.press("Enter");
    await expect(page.getByTestId("scene-timeline-title")).toHaveText("Intro");
    await expect.poll(async () => (await content(page)).timelineClips?.map((clip) => clip.name)).toEqual(["Intro"]);
    await page.getByTestId("undo-document").click();
    await expect.poll(async () => (await content(page)).timelineClips?.map((clip) => clip.name)).toEqual(["Timeline Clip"]);
    await page.getByTestId("redo-document").click();
    await expect.poll(async () => (await content(page)).timelineClips?.map((clip) => clip.name)).toEqual(["Intro"]);
    await saveAllIfEnabled(page);
    await closeProjectViaSettings(page);
    await page.getByTestId("open-listed-project-TestProject").click();
    await waitForEditorInteractive(page);
    await openMainScene(page);
    await waitForSceneViewportReady(page);
    expect((await content(page)).timelineClips?.map((clip) => clip.name)).toEqual(["Intro"]);
    // The tab reopens in the mode it was saved in.
    await expect(page.getByTestId("scene-mode-select")).toContainText("Timeline");
  });
  test("animates an actor in the Timeline window: track, keys, a key drag and undo", async ({ page }) => {
    test.setTimeout(120_000);
    await openMinimalTestProject(page, await minimalProjectFiles()); await openMainScene(page);
    await page.keyboard.press("Shift+5");
    await waitForSceneViewportReady(page);
    await page.getByTestId("timeline-clips-new").click();
    await page.getByTestId("timeline-clips-list").getByRole("textbox").press("Enter");
    await expect(page.getByTestId("scene-timeline-empty")).toBeVisible();

    // Drag the actor's Outliner row onto the Timeline window.
    const row = page.getByTestId("tree-row-actor:actor-1");
    const rowBox = (await row.boundingBox())!;
    const timeline = (await page.getByTestId("scene-timeline-panel").boundingBox())!;
    await page.mouse.move(rowBox.x + 30, rowBox.y + rowBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rowBox.x + 60, rowBox.y + rowBox.height / 2 + 20, { steps: 4 });
    await page.mouse.move(timeline.x + timeline.width / 2, timeline.y + timeline.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await content(page)).timelineClips?.[0]?.objects.map((object) => object.actorId)).toEqual(["actor-1"]);
    const objectId = (await content(page)).timelineClips![0]!.objects[0]!.id;
    await expect(page.getByTestId("outliner-timeline-badge-actor-1")).toHaveAttribute("aria-label", "In Timeline Clip");

    await page.getByTestId(`timeline-add-track-${objectId}`).click();
    const dialog = page.getByTestId("timeline-add-track-dialog");
    await dialog.getByText("Location", { exact: true }).click();
    await dialog.getByText("Visible", { exact: true }).click();
    await dialog.getByRole("button", { name: "Add Tracks" }).click();
    await expect.poll(async () => (await content(page)).timelineClips![0]!.objects[0]!.tracks.map((track) => track.target.property)).toEqual(["location", "visible"]);
    const locationId = (await content(page)).timelineClips![0]!.objects[0]!.tracks[0]!.id;
    const keyTimes = async () => (await content(page)).timelineClips![0]!.objects[0]!.tracks[0]!.keys.map((key) => key.Time);

    // Keys at the start and, after Go to End, at 5 s.
    await page.getByTestId(`timeline-key-toggle-${locationId}`).click();
    await page.getByTestId("timeline-go-end").click();
    await page.getByTestId(`timeline-key-toggle-${locationId}`).click();
    await expect.poll(keyTimes).toEqual([0, 5]);

    // Drag the 5 s key to 2.5 s: one undo entry, snapped to a frame.
    const lanes = (await page.getByTestId("keyframe-timeline-lanes").boundingBox())!;
    const x = (time: number) => lanes.x + 10 + time * ((lanes.width - 34) / 5);
    const y = lanes.y + 24 * 1.5;
    await page.mouse.move(x(5), y);
    await page.mouse.down();
    await page.mouse.move(x(4), y, { steps: 4 });
    await page.mouse.move(x(2.5), y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(keyTimes).toEqual([0, 2.5]);
    await page.getByTestId("undo-document").click();
    await expect.poll(keyTimes).toEqual([0, 5]);

    // Previous Key moves the playhead to the key before it.
    await page.getByTestId("timeline-previous-key").click();
    await expect(page.getByLabel("Playhead Time")).toHaveValue(/^0(\.00)?/);

    // A selected key shows in the Inspector; its menu sets the interpolation.
    await page.mouse.click(x(5), y);
    const keyGrid = page.getByTestId("timeline-inspector-key");
    await expect(keyGrid.getByLabel("Track")).toHaveValue("Actor › Location");
    await page.mouse.click(x(5), y, { button: "right" });
    await page.getByTestId("timeline-key-menu-interpolation").click();
    await page.getByTestId("timeline-key-menu-interp-constant").click();
    await expect.poll(async () => (await content(page)).timelineClips![0]!.objects[0]!.tracks[0]!.keys[1]!.Interpolation).toBe("constant");
    await expect(page.getByTestId("timeline-inspector-clip").getByLabel("Name")).toHaveValue("Timeline Clip");
  });
  test("keys a track on a touch screen with 44 pt rows, the Add Track dialog and a long-press menu", { tag: IPAD_TEST_TAG }, async ({ page }) => {
    test.setTimeout(120_000);
    await openMinimalTestProject(page, await minimalProjectFiles()); await openMainScene(page);
    await page.keyboard.press("Shift+5");
    await waitForSceneViewportReady(page);
    await page.getByTestId("timeline-clips-new").click();
    await page.getByTestId("timeline-clips-list").getByRole("textbox").press("Enter");
    await page.getByTestId("tree-row-actor:actor-1").click();
    await page.getByTestId("timeline-add-menu").click();
    await page.getByTestId("timeline-track-menu-selected").click();
    await expect.poll(async () => (await content(page)).timelineClips?.[0]?.objects.length).toBe(1);
    const objectId = (await content(page)).timelineClips![0]!.objects[0]!.id;
    await page.getByTestId(`timeline-add-track-${objectId}`).click();
    const dialog = page.getByTestId("timeline-add-track-dialog");
    await dialog.getByText("Scale", { exact: true }).click();
    await dialog.getByRole("button", { name: "Add Tracks" }).click();
    await expect.poll(async () => (await content(page)).timelineClips![0]!.objects[0]!.tracks.length).toBe(1);
    const trackId = (await content(page)).timelineClips![0]!.objects[0]!.tracks[0]!.id;
    const isMobileLayout = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
    if (isMobileLayout) expect((await page.getByTestId(`timeline-row-${trackId}`).boundingBox())!.height).toBeGreaterThanOrEqual(43);
    await page.getByTestId(`timeline-key-toggle-${trackId}`).click();
    await expect.poll(async () => (await content(page)).timelineClips![0]!.objects[0]!.tracks[0]!.keys.map((key) => key.Value))
      .toEqual([{ x: 1, y: 1, z: 1 }]);
    // Right-click stands in for a long-press here; both open the row menu.
    await page.getByTestId(`timeline-row-${trackId}`).click({ button: "right" });
    await page.getByTestId("timeline-row-menu-mute").click();
    await expect.poll(async () => (await content(page)).timelineClips![0]!.objects[0]!.tracks[0]!.muted).toBe(true);
  });
});
