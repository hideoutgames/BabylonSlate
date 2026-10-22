import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { normalizeRenderingQuality } from "../packages/core/src/index";
import type { RenderShadingSettings, ShadowDiagnostics } from "../packages/render/src/index";
import { openMainScene, waitForEditorInteractive } from "./open-test-project";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import { captureMannequinLuminance as luminance, captureMannequinPixels as capture, mannequinContactCoverage, mannequinShadowEdgeError, mannequinShadowMetrics, mannequinShadowPixels, mannequinShadowSamples, type MannequinGeometry } from "./mannequin-shadow-pixels";

if (process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Viewport = {
  shadowDiagnostics(): ShadowDiagnostics | null;
  mannequinShadowProbe(modelOnly?: boolean): Promise<MannequinGeometry>;
  mannequinShadowVisibility(points: { worldPosition: number[]; region: string }[]): Promise<boolean[]>;
  setRenderSettings(settings: RenderShadingSettings): void;
  setShadowCaptureView(position: number[], target: number[], fov: number): void;
  renderingBaseline(): { frameCount: number };
};
declare global { interface Window { __hapticViewportTest: Viewport } }

// The default WebGL2 PBR Medium editor view. The hosts spec adds CEL; webgpu-backend.spec.ts covers WebGPU shadows.
const variant = { backend: "webgl2", mode: "pbr", profile: "medium" } as const;
test(`Basic 3D mannequin ${variant.backend} ${variant.mode} ${variant.profile} keeps shadows with collider helpers visible`, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (["warning", "error"].includes(message.type()) && /shader|ERROR: 0:|GL_INVALID|WebGL: INVALID_|GL_OUT_OF_MEMORY|context lost/i.test(message.text())) errors.push(message.text());
  });
  await page.goto("/?test=1");
  await page.waitForFunction(() => crossOriginIsolated);
  await expect(page.getByTestId("homepage")).toBeVisible();
  await expect(page.getByTestId("open-listed-project-TestProject")).toHaveCount(0);
  await page.getByTestId("create-project").click();
  await page.getByTestId("create-project-empty").click();
  await page.getByTestId("create-project-name").fill("TestProject");
  await page.getByTestId("create-project-submit").click();
  await waitForEditorInteractive(page);
  await openMainScene(page);
  const canvas = page.getByTestId("viewport-canvas");
  await expect.poll(() => page.evaluate(() => window.__hapticViewportTest?.shadowDiagnostics()?.lights.some(light => light.generator))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__hapticViewportTest.shadowDiagnostics()?.models.filter(mesh => ["head", "torso", "arm-left", "arm-right", "leg-left", "leg-right"].includes(mesh.name ?? "")).length), { timeout: 30_000 }).toBe(6);
  const initial = (await page.evaluate(() => window.__hapticViewportTest.shadowDiagnostics()))!;
  const settings: RenderShadingSettings = {
    gpuBackend: variant.backend,
    mode: variant.mode, shadows: initial.requestedShadows,
    quality: normalizeRenderingQuality({ resolution: { scale: 1, minScale: 1, dynamic: false } }),
  };
  // The template Mannequin faces the default camera (-Z); frame its front, which the sun lights at a wide angle.
  await page.evaluate(() => window.__hapticViewportTest.setShadowCaptureView([0, 1.9, -5.5], [0, 1.35, 0], 0.7));
  const beforeSettings = await page.evaluate(() => window.__hapticViewportTest.renderingBaseline());
  await page.evaluate(settings => window.__hapticViewportTest.setRenderSettings(settings), settings);
  try {
    await expect.poll(() => page.evaluate(() => {
      const state = window.__hapticViewportTest.shadowDiagnostics();
      return [state?.surfaceMode, state?.requestedShadows.profile, state?.lights.find(light => light.generator)?.generator?.map?.width];
    })).toEqual([variant.mode, variant.profile, 2048]);
  } catch (error) {
    const stalled = await page.evaluate(() => ({
      baseline: window.__hapticViewportTest.renderingBaseline(),
      shadows: window.__hapticViewportTest.shadowDiagnostics(),
      documentVisibility: document.visibilityState,
    }));
    const animationFrameProbe = await page.evaluate(async () => {
      const started = performance.now();
      let fired = false;
      const frame = requestAnimationFrame(() => { fired = true; });
      await new Promise<void>(resolve => setTimeout(resolve, 1_000));
      cancelAnimationFrame(frame);
      return { fired, elapsedMs: performance.now() - started,
        baseline: window.__hapticViewportTest.renderingBaseline() };
    });
    await testInfo.attach("shadow-profile-stall", {
      body: JSON.stringify({ beforeSettings, ...stalled, animationFrameProbe, errors }, null, 2),
      contentType: "application/json",
    });
    throw error;
  }
  const geometry = await page.evaluate(() => window.__hapticViewportTest.mannequinShadowProbe(false));
  const frames = async () => {
    const id = await page.evaluate(() => window.__hapticViewportTest.renderingBaseline().frameCount);
    // Scene render IDs also count shadow/preparation draws. Wait for presented
    // viewport frames, then require the captured view to belong to this camera.
    await expect.poll(() => page.evaluate(() => window.__hapticViewportTest.renderingBaseline().frameCount), { timeout: 30_000 }).toBeGreaterThan(id + 2);
    await expect.poll(() => page.evaluate(() => {
      const camera = window.__hapticViewportTest.shadowDiagnostics()!.camera!;
      const p = camera.position!, m = camera.view!;
      return Math.max(...[0, 1, 2].map(i => Math.abs(p[0]! * m[i]! + p[1]! * m[i + 4]! + p[2]! * m[i + 8]! + m[i + 12]!)));
    })).toBeLessThan(1e-5);
  };
  await frames();
  const state = (await page.evaluate(() => window.__hapticViewportTest.shadowDiagnostics()))!;
  const size = await canvas.evaluate((node: HTMLCanvasElement) => ({ width: node.width, height: node.height }));
  const points = mannequinShadowSamples(geometry, state, size.width, size.height);
  const visible = await page.evaluate(points => window.__hapticViewportTest.mannequinShadowVisibility(points), points);
  const oracle = mannequinShadowPixels(geometry, state, size.width, size.height);
  const authored = await capture(canvas, points);
  const authoredLuminance = await luminance(canvas, oracle.box);
  await page.evaluate(() => window.__hapticViewportTest.mannequinShadowProbe(true));
  await frames();
  const modelOnly = await capture(canvas, points);
  const isolated = (await page.evaluate(() => window.__hapticViewportTest.shadowDiagnostics()))!;
  expect(isolated.lights.map(light => light.generator?.map)).toEqual(state.lights.map(light => light.generator?.map));
  await page.evaluate(settings => window.__hapticViewportTest.setRenderSettings(settings), { ...settings, shadows: { ...settings.shadows!, enabled: false } });
  await frames();
  const directOnly = await capture(canvas, points);
  const directLuminance = await luminance(canvas, oracle.box);
  for (const [name, value] of Object.entries({ authored, modelOnly, directOnly }))
    await testInfo.attach(name, { body: Buffer.from(value.png, "base64"), contentType: "image/png" });
  const regions = mannequinShadowMetrics(points, authored.pixels, directOnly.pixels, { modelOnly: modelOnly.pixels, visible });
  const edgeError = mannequinShadowEdgeError(oracle, authoredLuminance, directLuminance, state.camera!.fov!, size.height);
  await testInfo.attach("effective-settings", { body: JSON.stringify({
    buildSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    host: "fresh Basic 3D editor", os: process.platform, variant, initial, state, regions, edgeError,
    samples: points.map((point, index) => ({ ...point, visible: visible[index], authored: authored.pixels.slice(index * 3, index * 3 + 3), direct: directOnly.pixels.slice(index * 3, index * 3 + 3) })),
    geometry: geometry.map(({ name, vertices, indices }) => ({ name, vertices, indices })),
  }, null, 2), contentType: "application/json" });
  expect(errors).toEqual([]);
  expect(state.backend.actual).toBe(variant.backend);
  expect(state.backend.requested).toBe(variant.backend);
  expect(state.surfaceMode).toBe(variant.mode);
  expect(state.requestedShadows).toEqual(settings.shadows);
  expect(state.lights.find(light => light.generator)!.generator!.map!.width).toBe(2048);
  expect(points.length).toBeGreaterThan(300);
  expect(regions.head!.lit).toBeGreaterThan(100);
  for (const [name, region] of Object.entries(regions)) {
    expect(region.changed, `${name}: helper shadows change mannequin pixels`).toBeLessThanOrEqual(1);
    expect(region.falseDark, `${name}: known lit face`).toBeLessThanOrEqual(1);
    if (region.contacts > 5) expect(region.retained / region.contacts, `${name}: contact coverage`).toBeGreaterThan(0.8);
  }
  // Small regions can each hold five or fewer contacts; their sum is still covered.
  const contact = mannequinContactCoverage(regions);
  expect(contact.contacts).toBeGreaterThan(5);
  expect(contact.coverage, "total contact coverage").toBeGreaterThan(0.8);
  expect(Object.values(regions).reduce((sum, region) => sum + region.edges, 0)).toBeGreaterThan(20);
  // The sample classes above forgive a band of two shadow-map texels stretched by the sun's incidence,
  // which on a grazed face spans most of a limb. This one holds the drawn edge to the ray-cast one in metres.
  expect(edgeError.edge, "shadow edge pixels measured").toBeGreaterThan(100);
  expect(edgeError.widthMetres, "mean width of the wrong band along the shadow edges").toBeLessThan(0.02);
  await page.evaluate(() => window.__hapticViewportTest.mannequinShadowProbe(false));
  await page.evaluate(settings => window.__hapticViewportTest.setRenderSettings(settings), settings);
  await frames();
  expect((await page.evaluate(() => window.__hapticViewportTest.shadowDiagnostics()))!.requestedShadows).toEqual(settings.shadows);
});
