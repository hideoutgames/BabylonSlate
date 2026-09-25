import { expect, test } from "@playwright/test";
import type { runSpatialEffectsProof } from "../apps/editor/src/testing/spatial-effects-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) for (const kind of ["reflections", "point", "spot", "sun"] as const) {
  test(`${kind} spatial lighting renders and retires on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&spatialEffectsProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __spatialEffectsProof?: unknown }).__spatialEffectsProof === "function");
    const result = await page.evaluate(({ backend, kind }) => (window as unknown as { __spatialEffectsProof: typeof runSpatialEffectsProof }).__spatialEffectsProof(backend, kind), { backend, kind }).catch(async (error: unknown) => {
      await testInfo.attach("spatial-errors", { body: JSON.stringify(errors), contentType: "application/json" });
      throw error;
    });
    await testInfo.attach("spatial-pixels", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.reservations.reservedBytes).toBe(0);
    for (const capture of result.captures) {
      const lit = capture.on.filter((value, i) => i % 4 === 0 && value > capture.off[i]! + 8).length;
      expect(lit, `${capture.path}: visible ${kind}`).toBeGreaterThan(20);
      const disabledDifference = capture.disabled.reduce((sum, value, i) => sum + Math.abs(value - capture.off[i]!), 0) / capture.off.length;
      expect(disabledDifference, `${capture.path}: disabling restores scene color`).toBeLessThan(1);
      if (kind !== "reflections") {
        const occluded = capture.changed.filter((value, i) => i % 4 === 0 && value > capture.on[i]! + 3).length;
        expect(occluded, `${capture.path}: shadows occlude fog`).toBeGreaterThan(20);
      } else expect(capture.changed.some((value, i) => i % 4 === 0 && value > 50)).toBe(true);
    }
    const graph = result.captures[0]!.on, native = result.captures[1]!.on;
    expect(graph.reduce((sum, value, i) => sum + Math.abs(value - native[i]!), 0) / graph.length, "native and graph parity").toBeLessThan(5);
  });
}
