import { expect, test } from "@playwright/test";
import type { runAreaRectLightProof } from "../apps/editor/src/testing/area-rect-light-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import { renderingEvidence } from "./rendering-evidence";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`rectangular area emitters reach native and graph receivers through FrameGraph on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    const externalRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text()); });
    await page.route("https://**", async (route) => { externalRequests.push(route.request().url()); await route.abort(); });
    await page.goto("/?test=1&areaRectLightProof=1");
    await page.waitForFunction(() => "__babylonslateAreaRectLightProof" in window);
    const report = await page.evaluate((backend) => (window as unknown as { __babylonslateAreaRectLightProof: typeof runAreaRectLightProof }).__babylonslateAreaRectLightProof(backend), backend);
    for (const result of report.results) {
      for (const capture of result.captures) await testInfo.attach(`${result.mode}-${result.renderPath}-${capture.name}`, { body: Buffer.from(capture.image.split(",")[1]!, "base64"), contentType: "image/png" });
    }
    await testInfo.attach("area-light-qualification", { body: JSON.stringify({ ...report, results: report.results.map((result) => ({ ...result, captures: result.captures.map(({ image: _image, ...capture }) => capture) })), errors, externalRequests, evidence: renderingEvidence("apps/editor/src/testing/area-rect-light-proof.ts") }), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
    expect(report.emission.meanError, "worker/native emission pixels").toBeLessThan(1);
    expect(report.emission.maxError).toBeLessThanOrEqual(3);
    expect(report.emission.progress).toEqual(["decoding", "filtering"]);
    for (const result of report.results) {
      const [on, off, back, restored] = result.captures;
      if (backend === "webgl2") expect(result.pipeline.effective.renderPath).toBe(result.renderPath);
      if (result.mode === "cel") expect(on!.nativeLevels.length).toBeLessThanOrEqual(3);
      expect(on!.unlit[2]).toBeGreaterThan(on!.unlit[0]! + 20);
      expect(on!.nativeBrightness, `${result.mode} ${result.renderPath} native contribution`).toBeGreaterThan(off!.nativeBrightness + 1000);
      expect(on!.graphBrightness, `${result.mode} ${result.renderPath} graph contribution`).toBeGreaterThan(off!.graphBrightness + 1000);
      expect(back!.nativeBrightness).toBe(off!.nativeBrightness);
      expect(back!.graphBrightness).toBe(off!.graphBrightness);
      expect(restored!.image).toBe(on!.image);
      expect(off!.unlit).toEqual(on!.unlit);
      expect(back!.unlit).toEqual(on!.unlit);
      const textured = result.captures[4]!, nativeTexture = result.captures[5]!;
      if (backend === "webgl2") for (const capture of [textured, nativeTexture]) {
        for (const bindings of Object.values(capture.emission.bindings)) {
          expect(bindings.find((binding) => binding.name.startsWith("rectAreaLightEmissionTexture"))?.texture).toBe("emission");
        }
      }
      expect(textured.image !== on!.image, `${result.mode} textured output changes`).toBe(true);
      expect(textured.nativeBrightness).toBeGreaterThan(off!.nativeBrightness + 1000);
      expect(textured.graphBrightness).toBeGreaterThan(off!.graphBrightness + 1000);
      expect(textured.nativeBrightness / nativeTexture.nativeBrightness).toBeCloseTo(1, 2);
      expect(textured.graphBrightness / nativeTexture.graphBrightness).toBeCloseTo(1, 2);
    }
  });
}
