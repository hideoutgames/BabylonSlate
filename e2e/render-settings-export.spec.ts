import { expect, test, type Page } from "@playwright/test";
import { loadPlayerDistFiles } from "../apps/editor/src/services/load-player-files";
import { normalizeRenderProjectSettings } from "../packages/core/src/index";
import { exportGame, GAME_MANIFEST_FILE } from "../packages/exporter/src/index";
import type { PlayerBootHandle } from "../apps/player/src/boot";
import { previewPlacementScene } from "./preview-scene-fixture";
import { serveExportFiles } from "./export-static-server";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const command = (page: Page, line: string) => page.evaluate((line) =>
  (window as unknown as { __babylonslatePlayerTest: PlayerBootHandle }).__babylonslatePlayerTest.executeConsoleCommand(line), line);
const read = (page: Page) => page.evaluate(() => {
  const host = (window as unknown as { __babylonslatePlayerTest: PlayerBootHandle }).__babylonslatePlayerTest;
  return { rendering: host.rendering(), materials: host.meshMaterialNames(), tasks: host.renderTasks() };
});

for (const variant of [
  { mode: "packed", backend: "webgl2", fail: false },
  { mode: "loose", backend: "webgpu", fail: false },
  { mode: "packed", backend: "webgpu", fail: true },
] as const) {
  test(`non-default ${variant.mode} settings reach the standalone ${variant.backend} player${variant.fail ? " after initialization failure" : ""}`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    if (variant.fail) await page.addInitScript(() => {
      navigator.gpu.requestAdapter = async () => { throw new Error("qualification adapter failure"); };
    });
    const renderSettings = normalizeRenderProjectSettings({
      gpuBackend: variant.backend, renderPath: "forward", mode: "cel",
      cel: { shadowBands: 5, lightMixing: "blend", specularEnabled: false },
      shadows: { enabled: false },
      quality: { resolution: { scale: 0.8, minScale: 0.8, dynamic: false } },
      environmentLighting: { enabled: false, intensity: 2 },
      effects: { fxaa: true },
      customResolution: true, width: 480, height: 270, blackBars: true,
    });
    const exported = await exportGame({
      mode: variant.mode, bundleDebugger: true, startupSceneGuid: "first",
      renderSettings, playFrameCap: 30, scripts: [],
      assets: ["first", "second"].map((guid) => ({
        guid, type: "Scene", sceneGuid: guid,
        bytes: new TextEncoder().encode(JSON.stringify({ ...previewPlacementScene(), name: guid })),
      })),
      playerFiles: await loadPlayerDistFiles(new URL("/player/", baseURL).href),
    });
    if (!exported.ok) throw new Error(exported.error);
    const server = await serveExportFiles(exported.value.files, { honorRange: true });
    try {
      await page.goto(server.url);
      const root = page.getByTestId("player-root");
      await expect(root).toHaveAttribute("data-requested-backend", variant.backend);
      await expect(root).toHaveAttribute("data-effective-backend", variant.fail ? "webgl2" : variant.backend);
      await expect(root).toHaveAttribute("data-backend-fallback", variant.fail ? /qualification adapter failure/ : "");
      const ready = async (scale: number) => {
        await expect(root).toHaveAttribute("data-booted", "true", { timeout: 30_000 });
        await expect(page.getByTestId("scene-loading-dialog")).toBeHidden({ timeout: 30_000 });
        await expect.poll(async () => (await read(page)).rendering?.scalingLevel).toBeCloseTo(scale, 5);
        const live = await read(page);
        expect(live.rendering?.shadowPasses).toBe(0);
        expect(live.rendering?.pipeline.requested.gpuBackend).toBe(variant.backend);
        expect(live.materials.some((name) => name.endsWith(":CEL"))).toBe(true);
        expect(live.tasks?.some((name) => /FXAA/i.test(name))).toBe(true);
        return live;
      };
      const boot = await ready(1.25);
      expect(await command(page, "framecap")).toMatchObject({ success: true, output: "framecap 30" });
      expect(await command(page, "quality resolution scale 0.5")).toMatchObject({ success: true });
      await ready(2);
      expect(await command(page, "changescene second")).toMatchObject({ success: true });
      const transitioned = await ready(2);
      const stored = await (await page.request.get(new URL(GAME_MANIFEST_FILE, server.url).href)).json();
      expect(stored.render).toMatchObject({ gpuBackend: variant.backend, mode: "cel", quality: { resolution: { scale: 0.8 } }, effects: { fxaa: true } });
      await testInfo.attach("standalone-settings", { body: JSON.stringify({ variant, boot, transitioned, stored }), contentType: "application/json" });
      await testInfo.attach("standalone-settings-canvas", { body: await page.getByTestId("player-canvas").screenshot(), contentType: "image/png" });
      await page.reload();
      await ready(1.25);
      expect(errors).toEqual([]);
    } finally { await server.close(); }
  });
}
