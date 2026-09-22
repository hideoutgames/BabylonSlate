import { expect, test } from "@playwright/test";
import type { runAreaRectLightProof } from "../apps/editor/src/testing/area-rect-light-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import { renderingEvidence } from "./rendering-evidence";

if (process.env.BL_RENDER_NATIVE_GPU !== "1" || process.env.CI)
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
      for (const capture of [...result.captures, ...result.transforms]) await testInfo.attach(`${result.mode}-${result.renderPath}-${capture.name}`, { body: Buffer.from(capture.image.split(",")[1]!, "base64"), contentType: "image/png" });
    }
    const withoutImage = ({ image, ...capture }: typeof report.results[number]["captures"][number]) => { void image; return capture; };
    await testInfo.attach("area-light-qualification", { body: JSON.stringify({ ...report, results: report.results.map((result) => ({ ...result, captures: result.captures.map(withoutImage), transforms: result.transforms.map(withoutImage) })), errors, externalRequests, evidence: renderingEvidence("apps/editor/src/testing/area-rect-light-proof.ts") }), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
    expect(report.emission.meanError, "worker/native emission pixels").toBeLessThan(1);
    expect(report.emission.maxError).toBeLessThanOrEqual(3);
    expect(report.emission.progress).toEqual(["decoding", "filtering"]);
    expect(report.minifiedEmission.meanError, "minified worker/native emission pixels").toBeLessThan(1);
    expect(report.minifiedEmission.maxError).toBeLessThanOrEqual(3);
    expect(report.oddEmission.meanError, "odd-sized minified worker/native emission pixels").toBeLessThan(1);
    expect(report.oddEmission.maxError).toBeLessThanOrEqual(3);
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
      expect(textured.image === nativeTexture.image, `${result.mode} ${result.renderPath} native upload parity`).toBe(true);
      for (const transformed of result.transforms) {
        const disabled = ["unsupported shear", "degenerate scale", "mirrored forward axis"].includes(transformed.name);
        expect(transformed.image === (disabled ? off!.image : on!.image), `${result.mode}: ${transformed.name}`).toBe(true);
        if (transformed.name === "unsupported shear") expect(transformed.emission.diagnostic).toContain("sheared");
        else if (transformed.name === "degenerate scale") expect(transformed.emission.diagnostic).toContain("non-degenerate");
        else expect(transformed.emission.diagnostic).toBeNull();
      }
    }
  });
}
