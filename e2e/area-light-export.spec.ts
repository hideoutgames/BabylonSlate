import { expect, test } from "@playwright/test";
import { createActor, createDefaultScene, createMeshComponent, defaultExportPreset, identitySerializedTransform, normalizeRenderProjectSettings } from "../packages/core/src/index";
import { AREA_EMISSION_EDGE, encodeAreaEmission, sha256Hex } from "../packages/assets/src/index";
import { encodeRgbaPng } from "../packages/render/src/png-encode";
import { collectAndExportGame } from "../apps/editor/src/services/export-game";
import { loadPlayerDistFiles } from "../apps/editor/src/services/load-player-files";
import type { PlayerTestHandle } from "../apps/player/src/boot";
import { serveExportFiles } from "./export-static-server";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import { renderingEvidence } from "./rendering-evidence";

if (process.env.BL_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`prepared rectangular emission survives standalone export and scene lifecycle on ${backend}`, async ({ page, baseURL, request }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [], external: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://**", async (route) => { external.push(route.request().url()); await route.abort(); });
    const source = await encodeRgbaPng(1, 1, new Uint8Array([48, 220, 72, 255]));
    const rgba = new Uint8Array(AREA_EMISSION_EDGE ** 2 * 4);
    for (let index = 0; index < rgba.length; index += 4) rgba.set([48, 220, 72, 255], index);
    // Uniform numeric source: the native preparation filter leaves every pixel unchanged.
    const prepared = await encodeAreaEmission(rgba, await sha256Hex(source));
    const scenes = ["textured", "uniform", "off", "empty"].map((name) => {
      const scene = createDefaultScene(); scene.name = name;
      scene.settings.environmentLighting = { enabled: false };
      scene.settings.mainCameraActorId = "camera"; scene.settings.mainCameraComponentId = "view";
      scene.actors = [
        createActor("camera", "Camera", { transform: { ...identitySerializedTransform(), position: [0, 0, -6] }, components: [{ id: "view", classId: "CameraComponent", properties: { fieldOfView: 50, projectionMode: "perspective" } }] }),
        createActor("receiver", "Receiver", { transform: { ...identitySerializedTransform(), scale: [2, 2, 2] }, components: [createMeshComponent("surface", "sphere")] }),
        ...(name === "empty" ? [] : [createActor("emitter", "Emitter", { transform: { ...identitySerializedTransform(), position: [0, 0.5, -3] }, components: [{ id: "area", classId: "AreaRectLightComponent", properties: { enabled: name !== "off", width: 2, height: 2, intensity: 4, textureGuid: name === "textured" ? "emission" : null } }] })]),
      ];
      return scene;
    });
    const exported = await collectAndExportGame({
      startupSceneGuid: "textured", assets: [
        ...scenes.map((scene) => ({ guid: scene.name, name: scene.name, type: "Scene", dependencies: scene.name === "textured" ? ["uniform", "off", "empty"] : [], rootId: "project", parentClass: null })),
        { guid: "emission", name: "Emission", type: "Texture", dependencies: [], rootId: "project", parentClass: null },
      ], plugins: [], projectPluginOverrides: {}, parentOf: () => null,
      sceneByGuid: (guid) => scenes.find((scene) => scene.name === guid) ?? null, graphByGuid: () => null,
      bytesByGuid: (guid) => guid === "emission" ? source : new TextEncoder().encode(JSON.stringify(scenes.find((scene) => scene.name === guid))),
      areaEmissionBytesByGuid: (guid) => guid === "emission" ? prepared : null,
      preset: { ...defaultExportPreset(), packed: backend === "webgl2", bundleDebugger: true },
      renderSettings: normalizeRenderProjectSettings({ gpuBackend: backend, renderPath: "forward", mode: "cel", cel: { specularEnabled: false, shadowStrength: 1 }, environmentLighting: { enabled: false }, shadows: { enabled: false }, customResolution: true, width: 320, height: 180, quality: { resolution: { dynamic: false, scale: 1 } } }),
      playFrameCap: 30, physicsWorld: "3d", playerFiles: await loadPlayerDistFiles(new URL("/player/", baseURL).href),
    });
    if (!exported.ok) throw new Error(exported.error);
    expect([...exported.value.files.keys()].some((path) => path.includes("area-emission-worker"))).toBe(false);
    const server = await serveExportFiles(exported.value.files, { honorRange: true });
    try {
      // Legal assets must ship in both formats and be served without editor caches.
      for (const [path, text] of [
        ["legal/BabylonJS-Area-Lights-Attribution.txt", "Copyright BabylonJS contributors"],
        ["legal/BabylonJS-Area-Lights-CC-BY-4.0.txt", "Attribution 4.0 International"],
      ]) {
        const response = await request.get(new URL(path!, server.url).href);
        expect(response.ok(), path).toBe(true);
        expect(await response.text()).toContain(text);
      }
      await page.goto(server.url);
      const root = page.getByTestId("player-root");
      await expect(root).toHaveAttribute("data-effective-backend", backend);
      const diagnostics = () => page.evaluate(() => (window as unknown as { __babylonslatePlayerTest: PlayerTestHandle }).__babylonslatePlayerTest.rendering());
      const capture = async (name: string, areaBytes: number) => {
        await expect(root).toHaveAttribute("data-booted", "true", { timeout: 30_000 });
        await expect(root).toHaveAttribute("data-scene-loading", "false", { timeout: 30_000 });
        await expect.poll(async () => (await diagnostics())?.gpuReservations.categoryBytes.areaLight).toBe(areaBytes);
        const report = await diagnostics();
        expect(report?.qualityLimits).toEqual([]);
        expect(report?.shadowPasses).toBe(0);
        const pixels = await page.getByTestId("player-canvas").screenshot({ style: "#player-hud { visibility: hidden !important; }" });
        await testInfo.attach(name, { body: pixels, contentType: "image/png" });
        return { pixels: pixels.toString("base64"), report };
      };
      const change = async (name: string) => {
        const previousLoad = await root.getAttribute("data-scene-load-id");
        const result = await page.evaluate((name) => (window as unknown as { __babylonslatePlayerTest: PlayerTestHandle }).__babylonslatePlayerTest.executeConsoleCommand(`changescene ${name}`), name);
        expect(result.success).toBe(true);
        await expect.poll(() => root.getAttribute("data-scene-load-id")).not.toBe(previousLoad);
        await expect(root).toHaveAttribute("data-scene-loading", "false", { timeout: 30_000 });
      };
      const textured = await capture("textured boot", 65_536 + 5_592_404);
      await change("uniform"); const uniform = await capture("uniform", 65_536);
      expect(uniform.pixels !== textured.pixels).toBe(true);
      await change("off"); const off = await capture("disabled", 65_536);
      expect(off.pixels !== uniform.pixels).toBe(true);
      for (let repeat = 0; repeat < 3; repeat++) {
        await change("empty"); await capture(`disposed ${repeat}`, 0);
        await change("textured");
        const restored = await capture(`restored ${repeat}`, 65_536 + 5_592_404);
        expect(restored.pixels === textured.pixels).toBe(true);
      }
      await page.reload();
      expect((await capture("reload", 65_536 + 5_592_404)).pixels === textured.pixels).toBe(true);
      expect(errors).toEqual([]); expect(external).toEqual([]);
      await testInfo.attach("standalone-area-evidence", { body: JSON.stringify({ evidence: renderingEvidence("e2e/area-light-export.spec.ts"), backend, textured: textured.report, uniform: uniform.report, off: off.report }), contentType: "application/json" });
    } finally { await server.close(); }
  });
}
