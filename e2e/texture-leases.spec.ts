import { expect, test } from "@playwright/test";
import type { runTextureLeaseProof } from "../apps/editor/src/testing/texture-lease-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`stable sprite selections retain native buffers and independent texture owners on ${backend}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.goto("/?test=1&textureLeaseProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __textureLeaseProof?: unknown }).__textureLeaseProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as { __textureLeaseProof: typeof runTextureLeaseProof }).__textureLeaseProof(backend), backend);
    await info.attach("texture-leases", { body: JSON.stringify(result), contentType: "application/json" });
    expect(result.backend).toBe(backend);
    expect(result.stable).toEqual({ acquisitions: 0, materials: 0, buffers: 0, updates: 0 });
    expect(result.stableResources).toBe(true);
    expect(result.dimensions).toEqual({ acquisitions: 0, materials: 0, buffers: 0, updates: 1 });
    expect(result.atlasChange).toEqual({ acquisitions: 1, materials: 0, buffers: 0, updates: 2 });
    expect(result.crossfade).toEqual({ acquisitions: 0, materials: 0, buffers: 0, updates: 0 });
    expect(result.crossfadeWeights).toEqual([0.2, 0.8]);
    expect(result.independentAtlases).toBe(true);
    expect(result.red[0]).toBeGreaterThan(200); expect(result.red[1]).toBeLessThan(20);
    expect(result.green[1]).toBeGreaterThan(200); expect(result.green[0]).toBeLessThan(20);
    expect(result.preservesAuthored).toBe(true);
    expect(result.layerMaterialScene).toBe(true);
    expect(result.siblingSurvives).toBe(true);
    expect(result.retired).toEqual({ generations: 0, wrappers: 0, leases: 0, pending: 0 });
  });
}
