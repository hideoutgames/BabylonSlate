import { expect, test } from "@playwright/test";
import type { runInstancingParityProof } from "../apps/editor/src/testing/instancing-parity-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Proof = typeof runInstancingParityProof;

/** The largest channel difference between two captures, and how many pixels differ by more than one step. */
function compare(a: number[], b: number[]) {
  let max = 0;
  let over = 0;
  for (let pixel = 0; pixel < a.length / 4; pixel++) {
    let worst = 0;
    for (let channel = 0; channel < 3; channel++) worst = Math.max(worst, Math.abs(a[pixel * 4 + channel]! - b[pixel * 4 + channel]!));
    max = Math.max(max, worst);
    if (worst > 1) over++;
  }
  return { max, over };
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`pooled primitives draw the same image as meshes of their own, in fewer draws, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error|InstancedMesh/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&instancingParityProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __instancingParityProof?: unknown }).__instancingParityProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __instancingParityProof: Proof }).__instancingParityProof(backend), backend);
    const report = {
      draws: result.draws, pool: result.pool,
      visible: compare(result.unpooled.visible, result.pooled.visible),
      occluded: compare(result.unpooled.occluded, result.pooled.occluded),
    };
    await testInfo.attach(`instancing-parity-${backend}`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    console.log(JSON.stringify(report));
    expect(errors).toEqual([]);
    // Shading, shadows (casting and receiving) and occlusion culling are the same within one step of a channel.
    expect(report.visible).toEqual({ max: expect.any(Number), over: 0 });
    expect(report.occluded).toEqual({ max: expect.any(Number), over: 0 });
    if (backend === "webgpu") {
      // WebGPU does not pool yet (`sceneInstancing`): the same meshes draw.
      expect(report.pool).toEqual({ groups: 0, pooled: 0 });
      return;
    }
    // Three shapes and two Materials: one batch per group, so far fewer draws, in the shadow maps too.
    expect(report.pool.pooled).toBe(36);
    expect(report.pool.groups).toBeLessThanOrEqual(6);
    expect(report.draws.pooled.visible).toBeLessThan(report.draws.unpooled.visible);
    expect(report.draws.pooled.occluded).toBeLessThanOrEqual(report.draws.unpooled.occluded);
  });
}
