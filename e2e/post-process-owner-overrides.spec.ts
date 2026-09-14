import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { loadPlayerDistFiles } from "../apps/editor/src/services/load-player-files";
import { DEFAULT_RENDER_PROJECT_SETTINGS } from "../packages/core/src/index";
import { collectExportReachability, exportGame, PREVIEW_STOP_MESSAGE } from "../packages/exporter/src/index";
import { serveExportFiles } from "./export-static-server";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";
import { DISABLED_MASK_GUID, POST_PROCESS_SCENE_GUID, postProcessFixture } from "./post-process-fixture";
import { saveAllIfEnabled } from "./save-all";

function renderErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR:\s*0:|context lost|fatal error|texture.*(?:missing|not found|failed)/i.test(message.text())) errors.push(message.text());
  });
  return errors;
}

async function pixel(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((node) => {
    const source = node as HTMLCanvasElement;
    const copy = document.createElement("canvas"); copy.width = copy.height = 1;
    const context = copy.getContext("2d")!;
    context.drawImage(source, Math.floor(source.width / 2), Math.floor(source.height / 2), 1, 1, 0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  });
}

async function expectPixel(canvas: Locator, expected: number[], label: string, info: TestInfo) {
  try {
    await expect(async () => {
      const actual = await pixel(canvas);
      for (let channel = 0; channel < 4; channel++) expect(Math.abs(actual[channel]! - expected[channel]!), `${label} RGBA ${actual}`).toBeLessThanOrEqual(2);
    }).toPass({ timeout: 30_000 });
  } finally {
    await info.attach(`${label}-pixel`, { body: JSON.stringify({ expected, actual: await pixel(canvas) }), contentType: "application/json" });
    await info.attach(`${label}-canvas`, { body: await canvas.screenshot(), contentType: "image/png" });
  }
}

test("saved duplicate Post Process texture overrides survive editor reload, Play and Preview Build", async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors = renderErrors(page);
  await openMinimalTestProject(page, (await postProcessFixture(page)).files);
  await openMainScene(page);
  await expect(page.getByTestId("viewport-panel")).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
  // White * [128,255,255]/255 * .75 * [255,64,255]/255 * .5.
  const expected = [48, 24, 96, 255];
  await expectPixel(page.getByTestId("viewport-canvas"), expected, "editor-initial", info);
  await page.getByTestId("scene-post-process-3-enabled").click();
  await expectPixel(page.getByTestId("viewport-canvas"), [24, 12, 24, 255], "editor-enabled-reference", info);
  await page.getByTestId("scene-post-process-3-enabled").click();
  await expectPixel(page.getByTestId("viewport-canvas"), expected, "editor-disabled-again", info);
  await saveAllIfEnabled(page);
  await page.reload();
  await openMainScene(page);
  await expectPixel(page.getByTestId("viewport-canvas"), expected, "editor-reopened", info);
  await clickPlayAndWaitForOverlay(page);
  await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 30_000 });
  await expectPixel(page.getByTestId("play-canvas"), expected, "play", info);
  await page.getByTestId("play-overlay-close").click();
  await page.getByTestId("debug-menu").click();
  await page.getByTestId("preview-build-toggle").click();
  await page.getByTestId("play-preview").click();
  await waitForPreviewBuildBoot(page);
  const preview = page.frameLocator('[data-testid="preview-build-iframe"]');
  await expect(preview.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 30_000 });
  await expectPixel(preview.getByTestId("player-canvas"), expected, "preview-build", info);
  await page.getByTestId("preview-build-close").click();
  expect(errors).toEqual([]);
});

test("export closure retains disabled override textures and packed player presents independent entries", async ({ page, baseURL }, info) => {
  test.setTimeout(120_000);
  const errors = renderErrors(page);
  const fixture = await postProcessFixture(page);
  const closure = collectExportReachability({
    startupSceneGuid: POST_PROCESS_SCENE_GUID,
    assets: fixture.assets, pluginEnabledGuids: new Set(),
    parentOf: () => null, graphByGuid: () => null,
    sceneByGuid: (id) => id === POST_PROCESS_SCENE_GUID ? fixture.scene : null,
    payloadByGuid: (id) => fixture.payloads.get(id) ?? null,
  });
  if (!closure.ok) throw new Error(closure.error);
  expect(closure.value.guids).toContain(DISABLED_MASK_GUID);
  const result = await exportGame({
    startupSceneGuid: POST_PROCESS_SCENE_GUID, bundleDebugger: false, scripts: [],
    assets: fixture.assets.filter((asset) => closure.value.guids.includes(asset.guid)).map((asset) => ({
      guid: asset.guid, type: asset.type, name: asset.name, sceneGuid: POST_PROCESS_SCENE_GUID,
      bytes: fixture.bytes.get(asset.guid)!,
      ...(asset.type === "Texture" ? { width: 1, height: 1 } : {}),
    })),
    customResolution: { ...DEFAULT_RENDER_PROJECT_SETTINGS, gpuBackend: "webgl2", customResolution: true, width: 320, height: 180, blackBars: true },
    playFrameCap: 60, physicsWorld: "3d",
    playerFiles: await loadPlayerDistFiles(new URL("/player/", baseURL).href),
  });
  if (!result.ok) throw new Error(result.error);
  expect(result.value.warnings).toEqual([]);
  expect(result.value.manifest.assets.find((asset) => asset.guid === DISABLED_MASK_GUID)?.type).toBe("Texture");
  const server = await serveExportFiles(result.value.files, { honorRange: true });
  try {
    await page.goto(server.url);
    await expect(page.getByTestId("player-root")).toHaveAttribute("data-booted", "true", { timeout: 30_000 });
    await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 30_000 });
    await expectPixel(page.getByTestId("player-canvas"), [48, 24, 96, 255], "packed-player", info);
    await page.evaluate((type) => window.postMessage({ type }, location.origin), PREVIEW_STOP_MESSAGE);
    await expect(page.getByTestId("player-root")).toHaveAttribute("data-booted", "false");
    expect(errors).toEqual([]);
  } finally { await server.close(); }
});
