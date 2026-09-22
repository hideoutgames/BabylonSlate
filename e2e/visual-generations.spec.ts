import { expect, test } from "@playwright/test";
import type { runVisualGenerationProof } from "../apps/editor/src/testing/visual-generation-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`model and rich text generations retain native ownership and pixels on ${backend}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.goto("/?test=1&visualGenerationProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __visualGenerationProof?: unknown }).__visualGenerationProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as { __visualGenerationProof: typeof runVisualGenerationProof }).__visualGenerationProof(backend), backend);
    await info.attach("visual-generations", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.backend).toBe(backend);
    expect(result.retired).toEqual(result.warmed);
    expect(result.modelPixels.red).toBeGreaterThan(100);
    expect(result.richPixels.white).toBeGreaterThan(20);
    expect(result.beforeFailure.white).toBeGreaterThan(20);
    expect(result.afterFailure).toEqual(result.beforeFailure);
    expect(result.preservedText).toBe(true);
    expect(result.afterModelDisposal.red).toBe(0);
    expect(result.afterModelDisposal.white).toBeGreaterThan(20);
    expect(result.borrowedMaterialAlive).toBe(true);
  });
}
