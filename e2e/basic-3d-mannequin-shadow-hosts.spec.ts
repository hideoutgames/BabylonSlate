import { execFileSync } from "node:child_process";
import { expect, test, type Locator } from "@playwright/test";
import { lookAtRotation, normalizeRenderingQuality, type SerializedScene } from "../packages/core/src/index";
import type { RenderShadingSettings, ShadowDiagnostics } from "../packages/render/src/index";
import { openMainScene, waitForEditorInteractive } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";
import { setPreviewScene } from "./preview-parity";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import { captureMannequinPixels, mannequinShadowMetrics, mannequinShadowSamples, posedMannequin, type MannequinGeometry } from "./mannequin-shadow-pixels";

if (process.env.BL_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Api = {
  shadowDiagnostics(): ShadowDiagnostics | null;
  setRenderSettings(settings: RenderShadingSettings): void;
};
type Host = "play" | "player";
const apiName = (host: Host) => host === "play" ? "__babylonslatePlayTest" : "__babylonslatePlayerTest";
const diagnostics = (canvas: Locator, host: Host) => canvas.evaluate((_node, name) => (window as unknown as Record<string, Api>)[name]!.shadowDiagnostics(), apiName(host));
async function settings(canvas: Locator, host: Host, value: RenderShadingSettings) {
  await canvas.evaluate((_node, { name, value }) => (window as unknown as Record<string, Api>)[name]!.setRenderSettings(value), { name: apiName(host), value });
  await expect.poll(async () => {
    const state = await diagnostics(canvas, host);
    return [state?.surfaceMode, state?.requestedShadows.enabled];
  }).toEqual([value.mode, value.shadows!.enabled]);
  const frame = (await diagnostics(canvas, host))!.provenance.renderId;
  await expect.poll(async () => (await diagnostics(canvas, host))!.provenance.renderId).toBeGreaterThan(frame + 2);
}

test("Basic 3D mannequin preserves real materials, contacts and animation in Play and packed player", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (["warning", "error"].includes(message.type()) && /shader|ERROR: 0:|GL_INVALID|GL_OUT_OF_MEMORY|context lost/i.test(message.text())) errors.push(message.text());
  });
  await page.goto("/?test=1");
  await page.waitForFunction(() => crossOriginIsolated);
  await expect(page.getByTestId("homepage")).toBeVisible();
  await expect(page.getByTestId("open-listed-project-TestProject")).toHaveCount(0);
  await page.getByTestId("create-project").click();
  await page.getByTestId("create-project-empty").click();
  await page.getByTestId("create-project-submit").click();
  await waitForEditorInteractive(page);
  await openMainScene(page);
  const scene = await page.evaluate(() => (window as unknown as { __babylonslateTest: { activeSceneContent(): SerializedScene } }).__babylonslateTest.activeSceneContent());
  const camera = scene.actors.find(actor => actor.id === scene.settings.mainCameraActorId)!;
  camera.transform.position = [3, 2, 4];
  camera.transform.rotation = lookAtRotation([3, 2, 4], [0, 1.35, 0]);
  Object.assign(camera.components.find(component => component.classId === "CameraComponent")!.properties, { fieldOfView: 0.7 * 180 / Math.PI });
  // Preserve the real template's model, animation, light and clipping settings.
  await setPreviewScene(page, scene);
  const geometry = await page.evaluate(() => (window as unknown as { __babylonslateViewportTest: { mannequinShadowProbe(): Promise<MannequinGeometry> } }).__babylonslateViewportTest.mannequinShadowProbe());
  const sourceSha256 = await page.evaluate(async () => {
    const bytes = await (window as unknown as { __babylonslateTest: { readAssetChunk(path: string, id: string): Promise<Uint8Array> } }).__babylonslateTest.readAssetChunk("assets/Mannequin/mannequin.babasset", "source");
    if (!bytes?.byteLength) throw new Error("Missing imported mannequin source bytes");
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), value => value.toString(16).padStart(2, "0")).join("");
  });
  const evidence: unknown[] = [];
  for (const host of ["play", "player"] as const) {
    if (host === "play") await clickPlayAndWaitForOverlay(page);
    else {
      await page.getByTestId("debug-menu").click();
      await page.getByTestId("preview-build-toggle").click();
      await page.getByTestId("play-preview").click();
      await waitForPreviewBuildBoot(page);
    }
    const canvas = host === "play" ? page.getByTestId("play-canvas") : page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-canvas");
    await expect.poll(async () => (await diagnostics(canvas, host))?.models.filter(mesh => geometry.some(part => part.name === mesh.name)).length, { timeout: 30_000 }).toBe(6);
    const dilation = async (value: 0 | 1) => {
      if (host === "play") await page.getByTestId("play-console-open").click();
      else await page.getByRole("button", { name: "Console", exact: true }).click();
      await page.getByTestId("debug-console-input").fill(`slomo ${value}`);
      await page.getByTestId("debug-console-submit").click();
      await expect(page.getByTestId("debug-console-transcript")).toContainText(`slomo ${value}`);
      await page.getByTestId("debug-console").getByRole("button", { name: "Close", exact: true }).click();
    };
    await dilation(0);
    const initial = (await diagnostics(canvas, host))!;
    for (const mode of ["pbr", "cel"] as const) {
      const render: RenderShadingSettings = { gpuBackend: "webgl2", mode, shadows: initial.requestedShadows, quality: normalizeRenderingQuality({ resolution: { scale: 1, minScale: 1, dynamic: false } }) };
      await settings(canvas, host, render);
      const state = (await diagnostics(canvas, host))!;
      const size = await canvas.evaluate((node: HTMLCanvasElement) => ({ width: node.width, height: node.height }));
      const pose = posedMannequin(geometry, state);
      const points = mannequinShadowSamples(pose, state, size.width, size.height);
      const shadowed = await captureMannequinPixels(canvas, points);
      await settings(canvas, host, { ...render, shadows: { ...render.shadows!, enabled: false } });
      const direct = await captureMannequinPixels(canvas, points);
      const regions = mannequinShadowMetrics(points, shadowed.pixels, shadowed.pixels, direct.pixels);
      evidence.push({ host, mode, initial, state, regions });
      for (const [name, value] of Object.entries({ shadowed, direct })) await testInfo.attach(`${host}-${mode}-${name}`, { body: Buffer.from(value.png, "base64"), contentType: "image/png" });
      await testInfo.attach(`${host}-${mode}-effective`, { body: JSON.stringify({ state, regions }), contentType: "application/json" });
      expect(state.backend.actual).toBe("webgl2");
      expect(state.requestedShadows).toEqual(initial.requestedShadows);
      expect(points.length).toBeGreaterThan(300);
      expect(regions.head!.lit).toBeGreaterThan(100);
      for (const [name, region] of Object.entries(regions)) {
        expect(region.falseDark, `${host} ${mode} ${name}: known lit face`).toBeLessThanOrEqual(1);
        if (region.contacts > 5) expect(region.retained / region.contacts, `${host} ${mode} ${name}: contact coverage`).toBeGreaterThan(0.8);
      }
      expect(Object.values(regions).reduce((sum, region) => sum + region.contacts, 0)).toBeGreaterThan(5);
      await settings(canvas, host, render);
      const frozen = (await diagnostics(canvas, host))!;
      expect(posedMannequin(geometry, frozen)).toEqual(pose);
    }
    const before = posedMannequin(geometry, (await diagnostics(canvas, host))!);
    await dilation(1);
    await expect.poll(async () => posedMannequin(geometry, (await diagnostics(canvas, host))!), { timeout: 15_000 }).not.toEqual(before);
    await page.getByTestId(host === "play" ? "play-overlay-close" : "preview-build-close").click();
    await expect(page.getByTestId(host === "play" ? "play-overlay" : "preview-build-overlay")).toHaveCount(0);
  }
  await testInfo.attach("effective-settings", { body: JSON.stringify({ buildSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), os: process.platform, sourceSha256, scene, evidence }), contentType: "application/json" });
  expect(errors).toEqual([]);
});
