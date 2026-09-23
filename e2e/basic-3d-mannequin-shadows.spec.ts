import { execFileSync } from "node:child_process";
import { expect, test, type Locator } from "@playwright/test";
import { normalizeRenderingQuality } from "../packages/core/src/index";
import type { RenderShadingSettings, ShadowDiagnostics } from "../packages/render/src/index";
import { openMainScene, waitForEditorInteractive } from "./open-test-project";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import { mannequinShadowMetrics, mannequinShadowSamples, type MannequinGeometry } from "./mannequin-shadow-pixels";

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

async function capture(canvas: Locator, points: ReturnType<typeof mannequinShadowSamples>) {
  return canvas.evaluate((node: HTMLCanvasElement, points) => {
    const copy = document.createElement("canvas");
    copy.width = node.width; copy.height = node.height;
    const context = copy.getContext("2d")!;
    context.drawImage(node, 0, 0);
    const bytes = context.getImageData(0, 0, copy.width, copy.height).data;
    return {
      png: copy.toDataURL("image/png").split(",")[1]!,
      pixels: points.flatMap(({ x, y }) => Array.from(bytes.slice((y * copy.width + x) * 4, (y * copy.width + x) * 4 + 3))),
    };
  }, points);
}

test("Basic 3D mannequin keeps lit faces and contacts with collider helpers visible", async ({ page }, testInfo) => {
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
  const canvas = page.getByTestId("viewport-canvas");
  await expect.poll(() => page.evaluate(() => window.__babylonslateViewportTest?.shadowDiagnostics()?.lights.some(light => light.generator))).toBe(true);
  const initial = (await page.evaluate(() => window.__babylonslateViewportTest.shadowDiagnostics()))!;
  const settings: RenderShadingSettings = {
    mode: "pbr", shadows: initial.requestedShadows,
    quality: normalizeRenderingQuality({ resolution: { scale: 1, minScale: 1, dynamic: false } }),
  };
  await page.evaluate(() => window.__babylonslateViewportTest.setShadowCaptureView([3, 2, 4], [0, 1.35, 0], 0.7));
  await page.evaluate(settings => window.__babylonslateViewportTest.setRenderSettings(settings), settings);
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
  await page.evaluate(settings => window.__babylonslateViewportTest.setRenderSettings(settings), { ...settings, shadows: { ...settings.shadows!, enabled: false } });
  await frames();
  const directOnly = await capture(canvas, points);
  for (const [name, value] of Object.entries({ authored, modelOnly, directOnly }))
    await testInfo.attach(name, { body: Buffer.from(value.png, "base64"), contentType: "image/png" });
  const regions = mannequinShadowMetrics(points, authored.pixels, modelOnly.pixels, directOnly.pixels, visible);
  await testInfo.attach("effective-settings", { body: JSON.stringify({
    buildSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    host: "fresh Basic 3D editor", os: process.platform, initial, state, regions,
    geometry: geometry.map(({ name, vertices, indices }) => ({ name, vertices, indices })),
  }, null, 2), contentType: "application/json" });
  expect(errors).toEqual([]);
  expect(state.backend.actual).toBe("webgl2");
  expect(state.requestedShadows.profile).toBe("medium");
  expect(points.length).toBeGreaterThan(300);
  expect(regions.head!.lit).toBeGreaterThan(100);
  for (const [name, region] of Object.entries(regions)) {
    expect(region.changed, `${name}: helper shadows change mannequin pixels`).toBeLessThanOrEqual(1);
    expect(region.falseDark, `${name}: known lit face`).toBeLessThanOrEqual(1);
    if (region.contacts > 5) expect(region.retained / region.contacts, `${name}: contact coverage`).toBeGreaterThan(0.8);
  }
  expect(Object.values(regions).reduce((sum, region) => sum + region.contacts, 0)).toBeGreaterThan(5);
  expect(Object.values(regions).reduce((sum, region) => sum + region.edges, 0)).toBeGreaterThan(20);
});
