import { expect, test, type Page } from "@playwright/test";
import { loadPlayerDistFiles } from "../apps/editor/src/services/load-player-files";
import { normalizeRenderProjectSettings } from "../packages/core/src/index";
import { exportGame, GAME_MANIFEST_FILE } from "../packages/exporter/src/index";
import type { PlayerTestHandle } from "../apps/player/src/boot";
import { previewPlacementScene } from "./preview-scene-fixture";
import { serveExportFiles } from "./export-static-server";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import { scalabilityGraphScripts } from "./scalability-graph-fixture";
import { renderingEvidence } from "./rendering-evidence";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

const command = (page: Page, line: string) => page.evaluate((line) =>
  (window as unknown as { __babylonslatePlayerTest: PlayerTestHandle }).__babylonslatePlayerTest.executeConsoleCommand(line), line);
const read = (page: Page) => page.evaluate(() => {
  const host = (window as unknown as { __babylonslatePlayerTest: PlayerTestHandle }).__babylonslatePlayerTest;
  return { rendering: host.rendering(), visuals: host.visuals(), tasks: host.renderTasks(), scalability: host.scalability() };
});
// Capture the presented surface. Reading a non-preserved GPU canvas with
// drawImage between frames can return the cleared drawing buffer.
const pixels = async (page: Page) =>
  (await page.getByTestId("player-canvas").screenshot({
    style: "#player-hud { visibility: hidden !important; }",
  })).toString("base64");

for (const variant of [
  { mode: "packed", backend: "webgl2", fail: false },
  { mode: "loose", backend: "webgpu", fail: false },
  { mode: "packed", backend: "webgpu", fail: true },
] as const) {
  test(`non-default ${variant.mode} settings reach the standalone ${variant.backend} player${variant.fail ? " after initialization failure" : ""}`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    const rendererMessages: string[] = [];
    page.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") rendererMessages.push(message.text()); });
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
      renderSettings, playFrameCap: 30, scripts: scalabilityGraphScripts(),
      assets: ["first", "second"].map((guid) => {
        const scene = { ...previewPlacementScene(), name: guid };
        if (guid === "second") {
          scene.actors.find((actor) => actor.id === "far-actor")!.transform.position[2] = 3;
          scene.settings.celShading = { shadowBands: 7 };
          scene.settings.environmentLighting = { intensity: 3 };
        }
        return { guid, type: "Scene", sceneGuid: guid, bytes: new TextEncoder().encode(JSON.stringify(scene)) };
      }),
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
      const ready = async (scale: number, scene = "first") => {
        await expect(root).toHaveAttribute("data-booted", "true", { timeout: 30_000 });
        await expect(root).toHaveAttribute("data-scene-loading", "false", { timeout: 30_000 });
        await expect.poll(async () => (await read(page)).rendering?.scalingLevel).toBeCloseTo(scale, 5);
        await expect.poll(async () => (await read(page)).visuals.find((visual) => visual.position[0] === 4)?.position[2]).toBe(scene === "second" ? 3 : 0);
        await expect.poll(async () => (await read(page)).scalability?.effective?.render.quality?.resolution.scale).toBeCloseTo(1 / scale, 5);
        try {
          await expect.poll(async () => (await read(page)).tasks?.some((name) => /FXAA/i.test(name)), { message: "prepared FXAA graph after output resizing" }).toBe(true);
        } finally {
          await testInfo.attach(`readiness-${scale}-${scene}`, { body: JSON.stringify({ state: await read(page), rendererMessages, errors }), contentType: "application/json" });
        }
        const live = await read(page);
        await testInfo.attach(`effective-output-${scale}-${scene}`, { body: JSON.stringify(live), contentType: "application/json" });
        expect(live.rendering?.width).toBe(Math.floor(480 / scale));
        expect(live.rendering?.height).toBe(Math.floor(270 / scale));
        expect(live.rendering?.shadowPasses).toBe(0);
        expect(live.rendering?.pipeline.requested.gpuBackend).toBe(variant.backend);
        expect(live.visuals.filter((visual) => visual.visible)).toHaveLength(3);
        expect(live.tasks?.some((name) => /FXAA/i.test(name))).toBe(true);
        return live;
      };
      const boot = await ready(1.25);
      // Graph surfaces keep their names when switching mode: compare actual
      // presented shading, then restore the complete authored settings.
      const celPixels = await pixels(page);
      await testInfo.attach("authored-cel", { body: Buffer.from(celPixels, "base64"), contentType: "image/png" });
      expect(await command(page, "qual_pbr")).toMatchObject({ success: true });
      await expect.poll(async () => (await read(page)).scalability?.effective?.render.mode).toBe("pbr");
      await expect.poll(async () => await pixels(page) !== celPixels).toBe(true);
      await testInfo.attach("runtime-pbr", { body: Buffer.from(await pixels(page), "base64"), contentType: "image/png" });
      expect(await command(page, "qual_cel")).toMatchObject({ success: true });
      await expect.poll(async () => (await read(page)).scalability?.effective?.render.mode).toBe("cel");
      await expect.poll(async () => await pixels(page) === celPixels).toBe(true);
      expect(await command(page, "framecap")).toMatchObject({ success: true, output: "framecap 30" });
      expect(await command(page, "qual_runtime")).toMatchObject({ success: true });
      const changed = await ready(2);
      expect(changed.scalability?.effective?.frameCap).toBe(20);
      for (let repeat = 0; repeat < 20; repeat++) expect(await command(page, "qual_runtime")).toMatchObject({ success: true });
      expect((await read(page)).scalability?.revision).toBe(changed.scalability?.revision);
      expect(await command(page, "changescene second")).toMatchObject({ success: true });
      const transitioned = await ready(2, "second");
      await expect.poll(async () => (await read(page)).scalability?.effective?.render.cel?.shadowBands).toBe(7);
      expect((await read(page)).scalability?.effective?.render.environmentLighting?.intensity).toBe(3);
      expect(boot.scalability?.pipeline?.requested.gpuBackend).toBe(variant.backend);
      if (variant.fail) expect(boot.scalability?.pipeline?.limits.join(" ")).toContain("qualification adapter failure");
      expect(await command(page, "framecap")).toMatchObject({ success: true, output: "framecap 20" });
      const stored = await (await page.request.get(new URL(GAME_MANIFEST_FILE, server.url).href)).json();
      expect(stored.render).toMatchObject({ gpuBackend: variant.backend, mode: "cel", quality: { resolution: { scale: 0.8 } }, effects: { fxaa: true } });
      const environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio }));
      await testInfo.attach("standalone-settings", { body: JSON.stringify({
        evidence: renderingEvidence("e2e/render-settings-export.spec.ts"), environment,
        variant, boot, transitioned, stored,
      }), contentType: "application/json" });
      await testInfo.attach("standalone-settings-canvas", { body: await page.getByTestId("player-canvas").screenshot(), contentType: "image/png" });
      expect(await command(page, "qual_reset")).toMatchObject({ success: true });
      const reset = await ready(1.25, "second");
      expect(reset.scalability?.effective?.frameCap).toBe(30);
      await page.reload();
      await ready(1.25);
      expect(await command(page, "framecap")).toMatchObject({ success: true, output: "framecap 30" });
      expect(errors).toEqual([]);
    } finally { await server.close(); }
  });
}
