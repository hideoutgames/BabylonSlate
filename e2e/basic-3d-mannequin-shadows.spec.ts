import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { lookAtRotation, normalizeRenderingQuality, normalizeShadowSettings, type SerializedScene } from "../packages/core/src/index";
import type { RenderShadingSettings, ShadowDiagnostics } from "../packages/render/src/index";
import { openMainScene, waitForEditorInteractive, waitForSceneViewportReady } from "./open-test-project";
import { setPreviewScene } from "./preview-parity";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import { captureMannequinPixels as capture, mannequinShadowMetrics, mannequinShadowSamples, type MannequinGeometry } from "./mannequin-shadow-pixels";

if (process.env.BL_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Viewport = {
  shadowDiagnostics(): ShadowDiagnostics | null;
  mannequinShadowProbe(modelOnly?: boolean): Promise<MannequinGeometry>;
  mannequinShadowVisibility(points: { worldPosition: number[]; region: string }[]): Promise<boolean[]>;
  setRenderSettings(settings: RenderShadingSettings): void;
  setShadowCaptureView(position: number[], target: number[], fov: number): void;
};
declare global { interface Window { __babylonslateViewportTest: Viewport } }

const cases = [
  { backend: "webgl2", mode: "pbr", profile: "medium", alternate: false },
  { backend: "webgl2", mode: "cel", profile: "low", alternate: false },
  { backend: "webgpu", mode: "cel", profile: "medium", alternate: false },
  { backend: "webgpu", mode: "pbr", profile: "low", alternate: false },
  { backend: "webgl2", mode: "pbr", profile: "medium", alternate: true },
] as const;
for (const variant of cases) test(`Basic 3D mannequin ${variant.backend} ${variant.mode} ${variant.profile}${variant.alternate ? " alternate light" : ""} keeps shadows with collider helpers visible`, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
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
  if (variant.backend === "webgpu") {
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-rendering").click();
    await page.getByTestId("project-gpu-backend").click();
    await page.getByRole("option", { name: "WebGPU", exact: true }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__babylonslateViewportTest?.shadowDiagnostics()?.backend.actual), { timeout: 30_000 }).toBe("webgpu");
    await waitForSceneViewportReady(page);
    await expect(page.getByTestId("project-rendering-dialog")).toHaveCount(0);
  }
  if (variant.alternate) {
    const scene = await page.evaluate(() => (window as unknown as { __babylonslateTest: { activeSceneContent(): SerializedScene } }).__babylonslateTest.activeSceneContent());
    scene.actors.find(actor => actor.id === "actor-sun")!.transform.rotation = lookAtRotation([-4, 8, 5], [0, 0, 0]);
    await setPreviewScene(page, scene);
  }
  const canvas = page.getByTestId("viewport-canvas");
  await expect.poll(() => page.evaluate(() => window.__babylonslateViewportTest?.shadowDiagnostics()?.lights.some(light => light.generator))).toBe(true);
  const initial = (await page.evaluate(() => window.__babylonslateViewportTest.shadowDiagnostics()))!;
  const settings: RenderShadingSettings = {
    gpuBackend: variant.backend,
    mode: variant.mode, shadows: variant.profile === "medium" ? initial.requestedShadows : normalizeShadowSettings({ profile: "low" }),
    quality: normalizeRenderingQuality({ resolution: { scale: 1, minScale: 1, dynamic: false } }),
  };
  await page.evaluate(alternate => window.__babylonslateViewportTest.setShadowCaptureView(alternate ? [-3, 2, 4] : [3, 2, 4], [0, 1.35, 0], 0.7), variant.alternate);
  await page.evaluate(settings => window.__babylonslateViewportTest.setRenderSettings(settings), settings);
  await expect.poll(() => page.evaluate(() => {
    const state = window.__babylonslateViewportTest.shadowDiagnostics();
    return [state?.surfaceMode, state?.requestedShadows.profile, state?.lights.find(light => light.generator)?.generator?.map?.width];
  })).toEqual([variant.mode, variant.profile, variant.profile === "low" ? 1024 : 2048]);
  const geometry = await page.evaluate(() => window.__babylonslateViewportTest.mannequinShadowProbe(false));
  const frames = async () => {
    const id = await page.evaluate(() => window.__babylonslateViewportTest.shadowDiagnostics()!.provenance.renderId);
    await expect.poll(() => page.evaluate(() => window.__babylonslateViewportTest.shadowDiagnostics()!.provenance.renderId)).toBeGreaterThan(id + 2);
  };
  await frames();
  const state = (await page.evaluate(() => window.__babylonslateViewportTest.shadowDiagnostics()))!;
  const size = await canvas.evaluate((node: HTMLCanvasElement) => ({ width: node.width, height: node.height }));
  const points = mannequinShadowSamples(geometry, state, size.width, size.height);
  const visible = await page.evaluate(points => window.__babylonslateViewportTest.mannequinShadowVisibility(points), points);
  const authored = await capture(canvas, points);
  await page.evaluate(() => window.__babylonslateViewportTest.mannequinShadowProbe(true));
  await frames();
  const modelOnly = await capture(canvas, points);
  const isolated = (await page.evaluate(() => window.__babylonslateViewportTest.shadowDiagnostics()))!;
  expect(isolated.lights.map(light => light.generator?.map)).toEqual(state.lights.map(light => light.generator?.map));
  await page.evaluate(settings => window.__babylonslateViewportTest.setRenderSettings(settings), { ...settings, shadows: { ...settings.shadows!, enabled: false } });
  await frames();
  const directOnly = await capture(canvas, points);
  for (const [name, value] of Object.entries({ authored, modelOnly, directOnly }))
    await testInfo.attach(name, { body: Buffer.from(value.png, "base64"), contentType: "image/png" });
  const regions = mannequinShadowMetrics(points, authored.pixels, modelOnly.pixels, directOnly.pixels, visible);
  await testInfo.attach("effective-settings", { body: JSON.stringify({
    buildSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    host: "fresh Basic 3D editor", os: process.platform, variant, initial, state, regions,
    samples: points.map((point, index) => ({ ...point, visible: visible[index], authored: authored.pixels.slice(index * 3, index * 3 + 3), direct: directOnly.pixels.slice(index * 3, index * 3 + 3) })),
    geometry: geometry.map(({ name, vertices, indices }) => ({ name, vertices, indices })),
  }, null, 2), contentType: "application/json" });
  expect(errors).toEqual([]);
  expect(state.backend.actual).toBe(variant.backend);
  expect(state.backend.requested).toBe(variant.backend);
  expect(state.surfaceMode).toBe(variant.mode);
  expect(state.requestedShadows).toEqual(settings.shadows);
  expect(state.lights.find(light => light.generator)!.generator!.map!.width).toBe(variant.profile === "low" ? 1024 : 2048);
  expect(points.length).toBeGreaterThan(300);
  expect(regions.head!.lit).toBeGreaterThan(variant.profile === "medium" && !variant.alternate ? 100 : 50);
  for (const [name, region] of Object.entries(regions)) {
    expect(region.changed, `${name}: helper shadows change mannequin pixels`).toBeLessThanOrEqual(1);
    expect(region.falseDark, `${name}: known lit face`).toBeLessThanOrEqual(1);
    if (region.contacts > 5) expect(region.retained / region.contacts, `${name}: contact coverage`).toBeGreaterThan(0.8);
  }
  // Low's footprint can span these small contacts. Require independent contact
  // interiors at Medium; Low still compares every edge to the model-only draw.
  if (variant.profile === "medium") expect(Object.values(regions).reduce((sum, region) => sum + region.contacts, 0)).toBeGreaterThan(5);
  expect(Object.values(regions).reduce((sum, region) => sum + region.edges, 0)).toBeGreaterThan(20);
  await page.evaluate(() => window.__babylonslateViewportTest.mannequinShadowProbe(false));
  await page.evaluate(settings => window.__babylonslateViewportTest.setRenderSettings(settings), settings);
  await frames();
  expect((await page.evaluate(() => window.__babylonslateViewportTest.shadowDiagnostics()))!.requestedShadows).toEqual(settings.shadows);
});
