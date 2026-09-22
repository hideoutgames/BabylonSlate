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

// Decode the actual presented screenshot, not the transient GPU canvas buffer.
const magentaPixels = (page: Page, captured: string) => page.evaluate(async (base64) => {
  const image = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], { type: "image/png" }));
  const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext("2d")!;
  context.drawImage(image, 0, 0); image.close();
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let index = 0; index < data.length; index += 4) if (data[index]! > 170 && data[index + 1]! < 100 && data[index + 2]! > 170) count++;
  return count;
}, captured);

for (const variant of [
  { mode: "packed", backend: "webgl2", fail: false },
  { mode: "loose", backend: "webgpu", fail: false },
  { mode: "packed", backend: "webgpu", fail: true },
] as const) {
  test(`non-default ${variant.mode} settings reach the standalone ${variant.backend} player${variant.fail ? " after initialization failure" : ""}`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => { Error.stackTraceLimit = 30; });
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
        // This setter fixture qualifies transactions, not large shadow-map
        // allocations. Dedicated shadow fixtures own actual caster coverage.
        for (const actor of scene.actors) for (const component of actor.components)
          if (component.classId === "LightComponent") component.properties.castShadows = false;
        // Serialized authored state reaches runtime hydration in both packed
        // and loose players; only this actor receives the magenta style.
        scene.actors.find((actor) => actor.id === "material-actor")!.components.push({ id: "authored-ink", classId: "OutlineComponent", properties: { enabled: true, color: [1, 0, 1], width: 4, throughMeshes: false } });
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
      expect(await command(page, "qual_outlines_off")).toMatchObject({ success: true });
      await expect.poll(async () => (await read(page)).scalability?.effective?.render.cel?.outlinesEnabled).toBe(false);
      const componentOnly = await pixels(page);
      expect(componentOnly).not.toBe(celPixels);
      expect(await magentaPixels(page, componentOnly)).toBeGreaterThan(8);
      await testInfo.attach("authored-component-only", { body: Buffer.from(componentOnly, "base64"), contentType: "image/png" });
      expect(await command(page, "qual_outlines")).toMatchObject({ success: true });
      await expect.poll(async () => (await read(page)).scalability?.effective?.render.cel?.outlineWidth).toBe(4);
      await expect.poll(async () => await pixels(page) !== componentOnly).toBe(true);
      const outlined = await read(page);
      expect(outlined.scalability?.effective?.render.cel).toMatchObject({ outlinesEnabled: true, outlineColor: [0.1875, 0.75, 0.375], outlineWidth: 4 });
      expect(await command(page, "qual_outline_roundtrip")).toMatchObject({ success: true });
      expect((await read(page)).scalability?.revision).toBe(outlined.scalability?.revision);
      expect(await command(page, "framecap")).toMatchObject({ success: true, output: "framecap 30" });
      expect(await command(page, "qual_runtime")).toMatchObject({ success: true });
      const changed = await ready(2);
      expect(changed.scalability?.effective?.frameCap).toBe(20);
      for (let repeat = 0; repeat < 20; repeat++) expect(await command(page, "qual_runtime")).toMatchObject({ success: true });
      expect((await read(page)).scalability?.revision).toBe(changed.scalability?.revision);
      expect(await command(page, "changescene second")).toMatchObject({ success: true });
      const transitioned = await ready(2, "second");
      expect(transitioned.scalability?.effective?.render.cel).toMatchObject({ outlinesEnabled: true, outlineColor: [0.1875, 0.75, 0.375], outlineWidth: 4 });
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
      expect(reset.scalability?.effective?.render.cel).toMatchObject({ outlinesEnabled: true, outlineColor: [0.03, 0.03, 0.03], outlineWidth: 1 });
      expect(await magentaPixels(page, await pixels(page))).toBeGreaterThan(8);
      if (!variant.fail) {
        for (const preset of ["low", "medium", "high", "ultra"]) {
          expect(await command(page, `qual_${preset}`)).toMatchObject({ success: true });
          await expect.poll(async () => (await read(page)).scalability?.effective?.render.quality?.lighting.profile).toBe(preset);
          const applied = (await read(page)).scalability!;
          expect(applied.effective?.render.mode).toBe("cel");
          expect(applied.effective?.render.effects?.fxaa).toBe(true);
          expect(applied.effective?.render.cel?.shadowBands).toBe(7);
          expect(applied.effective?.frameCap).toBe(30);
        }
        expect(await command(page, "qual_settings")).toMatchObject({ success: true });
        await expect.poll(async () => (await read(page)).scalability?.effective?.render.environmentLighting?.rotationYDegrees).toBe(23);
        const custom = await read(page);
        expect(custom.rendering).toMatchObject({ width: 300, height: 180, scalingLevel: 1 / 0.75 });
        expect(custom.scalability?.effective).toMatchObject({ frameCap: 24, render: {
          width: 400, height: 240, customResolution: true, blackBars: true,
          quality: { resolution: { scale: 0.75, dynamic: false, targetFps: 30 }, lighting: { localLightMode: "manual", maxLocalLights: 3 }, textures: { lodBias: 1, anisotropy: 2, byteBudget: 128 * 1024 ** 2 }, postprocessing: { resolutionScale: 0.5 } },
          shadows: { enabled: false, distance: 80, fadeFraction: 0.2, mapSize: 512, cascades: 1, filterQuality: "low", autoBias: false, depthBias: 0.002, normalBias: 0.01, localLightMode: "manual", maxLocalLights: 1, localMapSize: 256 },
          effects: { fxaa: false, exposure: 1.5, contrast: 1.2, vignette: { enabled: true, weight: 1.1, color: [0.2, 0.1, 0.3] } },
          cel: { shadowBands: 6, shadowThreshold: 0.4, shadowStrength: 0.7, specularEnabled: false, specularStrength: 0.1, specularSize: 0.3, lightColorInfluence: 0.8, lightMixing: "additive" },
          environmentLighting: { enabled: false, intensity: 0.3, rotationYDegrees: 23, celStrength: 0.5 },
        } });
        expect(custom.tasks?.some((name) => /FXAA/.test(name))).toBe(false);
        await testInfo.attach("compiled-setters", { body: JSON.stringify(custom), contentType: "application/json" });
        expect(await command(page, "qual_invalid")).toMatchObject({ success: true });
        expect((await read(page)).scalability?.revision).toBe(custom.scalability?.revision);
        expect(await command(page, "qual_aa")).toMatchObject({ success: true });
        await expect.poll(async () => (await read(page)).tasks?.some((name) => /FXAA/.test(name))).toBe(true);
        expect(await command(page, "qual_clamped")).toMatchObject({ success: true });
        await expect.poll(async () => (await read(page)).scalability?.effective?.render.quality?.resolution.scale).toBe(0.25);
        expect((await read(page)).scalability?.status).toBe("clamped");
        expect(await command(page, "qual_cluster")).toMatchObject({ success: true });
        await expect.poll(async () => (await read(page)).scalability?.pipeline?.requested.renderPath).toBe("clusteredForward");
        expect((await read(page)).scalability?.pipeline?.effective.renderPath).toBe(variant.backend === "webgpu" ? "forward" : "clusteredForward");
        expect(await command(page, "qual_reset")).toMatchObject({ success: true });
        await ready(1.25, "second");
      }
      await page.reload();
      await ready(1.25);
      expect(await magentaPixels(page, await pixels(page))).toBeGreaterThan(8);
      expect(await command(page, "framecap")).toMatchObject({ success: true, output: "framecap 30" });
      expect(errors).toEqual([]);
    } finally {
      await testInfo.attach("standalone-final-diagnostics", {
        body: JSON.stringify({ errors, rendererMessages,
          state: await read(page).catch((error: unknown) => ({ unavailable: String(error) })),
          shutdown: await page.evaluate(() =>
            (window as unknown as { __babylonslatePlayerTest: PlayerTestHandle }).__babylonslatePlayerTest.stop()
          ).catch((error: unknown) => ({ unavailable: String(error) })),
          evidence: renderingEvidence("e2e/render-settings-export.spec.ts"),
        }), contentType: "application/json",
      });
      await server.close();
    }
  });
}
