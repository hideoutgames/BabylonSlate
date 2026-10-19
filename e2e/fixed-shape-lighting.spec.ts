import { expect, test } from "@playwright/test";
import type { runFixedLightProof } from "../apps/editor/src/testing/fixed-light-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

// BL_RENDER_NATIVE_GPU=1 keeps the perf-gpu project's launch arguments (playwright.perf.config.ts).
if (process.env.BL_RENDER_NATIVE_GPU !== "1") test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`fixed light seats shade native PBR and Standard like the legacy path on ${backend}, and light changes compile nothing`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&fixedLightProof=1");
    await page.waitForFunction(() =>
      typeof (window as unknown as { __babylonslateFixedLightProof?: unknown }).__babylonslateFixedLightProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __babylonslateFixedLightProof: typeof runFixedLightProof }).__babylonslateFixedLightProof(backend), backend);
    await testInfo.attach("fixed-light-proof", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.backend).toBe(backend);
    // Sun, fill, the casting spot in its shadow seat, the other spot and three points.
    for (const guard of ["multiply", "branch"] as const)
      expect(result.seats[guard], guard).toEqual([
        "SUN:sun", "FILL:fill", "SPOT_SHADOW:spot-0 shadowed", "LOCAL_SPOT:spot-1", "LOCAL_POINT:point-0", "LOCAL_POINT:point-1", "LOCAL_POINT:point-2",
      ]);
    const legacy = new Map(result.captures.filter((capture) => capture.path === "legacy").map((capture) => [capture.name, capture.pixels]));
    expect([...legacy.keys()]).toEqual(["all lights", "empty seats", "sun only"]);
    for (const capture of result.captures) {
      const reference = legacy.get(capture.name)!;
      let difference = 0;
      let lit = 0;
      for (let index = 0; index < reference.length; index++) {
        difference = Math.max(difference, Math.abs(capture.pixels[index]! - reference[index]!));
        if (index % 4 === 0 && Math.max(...reference.slice(index, index + 3)) > 25) lit++;
      }
      expect(lit, `${capture.path} ${capture.name}`).toBeGreaterThan(400);
      // Seat order sums lights in another order than lightSources: float rounding only.
      expect(difference, `${capture.path} ${capture.name}`).toBeLessThanOrEqual(2);
    }
    // The poses really differ, so a seat that ignored its light would fail above.
    expect(legacy.get("empty seats")).not.toEqual(legacy.get("all lights"));
    // Both native materials drew with seat-bound shaders (each guard), not Babylon's lightSources path.
    expect(result.fixedLitEffects).toBeGreaterThanOrEqual(4);
    expect(result.steps).toEqual([
      { step: "a point switched off", newLitEffects: 0 },
      { step: "an unshadowed spot switched off", newLitEffects: 0 },
      { step: "the fill switched off", newLitEffects: 0 },
      { step: "all back on", newLitEffects: 0 },
      { step: "a new point in a freed seat", newLitEffects: 0 },
    ]);
  });
}
