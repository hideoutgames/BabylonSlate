import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { normalizeRenderingQuality } from "../packages/core/src/index";
import type { RenderShadingSettings, ShadowDiagnostics } from "../packages/render/src/index";
import { openMainScene, waitForEditorInteractive } from "./open-test-project";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

if (process.env.BL_RENDER_NATIVE_GPU !== "1" || process.env.CI)
  test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Viewport = {
  shadowDiagnostics(): ShadowDiagnostics | null;
  mannequinShadowProbe(neutral: boolean, modelOnly?: boolean): Promise<unknown>;
  setRenderSettings(settings: RenderShadingSettings): void;
  setShadowCaptureView(position: number[], target: number[], fov: number): void;
};
declare global { interface Window { __babylonslateViewportTest: Viewport } }

test("Basic 3D mannequin exposed shadow faces", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (["warning", "error"].includes(message.type()) && /shader|ERROR: 0:|GL_INVALID|GL_OUT_OF_MEMORY|context lost/i.test(message.text())) errors.push(message.text());
  });
  await page.goto("/?test=1");
  await page.waitForFunction(() => crossOriginIsolated);
  await expect(page.getByTestId("homepage")).toBeVisible();
  // The browser context owns fresh OPFS. Never reopen a previously edited model.
  await expect(page.getByTestId("open-listed-project-TestProject")).toHaveCount(0);
  await page.getByTestId("create-project").click();
  await page.getByTestId("create-project-empty").click();
  await page.getByTestId("create-project-submit").click();
  await waitForEditorInteractive(page);
  await openMainScene(page);
  const canvas = page.getByTestId("viewport-canvas");
  await expect.poll(() => page.evaluate(() => window.__babylonslateViewportTest?.shadowDiagnostics()?.lights.some(light => light.generator))).toBe(true);
  const initial = (await page.evaluate(() => window.__babylonslateViewportTest.shadowDiagnostics()))!;
  await testInfo.attach("initial-settings", { body: JSON.stringify(initial, null, 2), contentType: "application/json" });
  await testInfo.attach("initial-view", { body: await canvas.screenshot(), contentType: "image/png" });
  const settings: RenderShadingSettings = {
    mode: "pbr", shadows: initial.requestedShadows,
    quality: normalizeRenderingQuality({ resolution: { scale: 1, minScale: 1, dynamic: false } }),
  };
  const captures = [];
  for (const neutral of [false, true]) {
    const probe = await page.evaluate(neutral => window.__babylonslateViewportTest.mannequinShadowProbe(neutral), neutral);
    await testInfo.attach(`geometry-${neutral}`, { body: JSON.stringify(probe), contentType: "application/json" });
    const position = [3, 2, 4];
    await page.evaluate(position => window.__babylonslateViewportTest.setShadowCaptureView(position, [0, 1.35, 0], 0.7), position);
    for (const variant of ["baseline", "off", "normal-zero", "manual", "single", "unfiltered", "model-only"] as const) {
      const enabled = variant !== "off";
      await page.evaluate(settings => window.__babylonslateViewportTest.setRenderSettings(settings), {
        ...settings, shadows: { ...settings.shadows!, enabled,
          ...(variant === "normal-zero" ? { normalBias: 0 } : {}),
          ...(variant === "manual" ? { autoBias: false } : {}),
          ...(variant === "single" ? { cascades: 1 } : {}),
          ...(variant === "unfiltered" ? { filter: "none" } : {}),
        },
      });
      await page.evaluate(({ neutral, modelOnly }) => window.__babylonslateViewportTest.mannequinShadowProbe(neutral, modelOnly), { neutral, modelOnly: variant === "model-only" });
      const id = await page.evaluate(() => window.__babylonslateViewportTest.shadowDiagnostics()!.provenance.renderId);
      await expect.poll(() => page.evaluate(() => window.__babylonslateViewportTest.shadowDiagnostics()!.provenance.renderId)).toBeGreaterThan(id + 2);
      const state = (await page.evaluate(() => window.__babylonslateViewportTest.shadowDiagnostics()))!;
      const name = `${neutral ? "neutral" : "authored"}-${variant}`;
      await testInfo.attach(name, { body: await canvas.screenshot(), contentType: "image/png" });
      captures.push({ name, state });
    }
  }
  await testInfo.attach("effective-settings", { body: JSON.stringify({ buildSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), os: process.platform, captures }, null, 2), contentType: "application/json" });
  expect(errors).toEqual([]);
});
