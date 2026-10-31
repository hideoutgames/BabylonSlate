import { expect, test } from "@playwright/test";
import type { runShadowParticipationProof } from "../apps/editor/src/testing/shadow-participation-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Proof = typeof runShadowParticipationProof;

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`a cube over a plane shadows the plane only while the cube casts and the plane receives, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&shadowParticipationProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __shadowParticipationProof?: unknown }).__shadowParticipationProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __shadowParticipationProof: Proof }).__shadowParticipationProof(backend), backend);
    const report = result.cases.map(({ host, screenShadows, target, flags, shadowed, umbra, stray, open }) =>
      ({ case: `${host} ${screenShadows} ${target} cast=${flags.cast} receive=${flags.receive}`, shadowed, umbra, stray, open }));
    await testInfo.attach(`shadow-participation-${backend}`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.cases).toHaveLength(32);
    for (const entry of result.cases) {
      const label = `${entry.host} ${entry.screenShadows} ${entry.target} ${JSON.stringify(entry.flags)}`;
      // The cube's flags decide whether it shadows the plane; the plane's whether it shows that shadow.
      const expected = entry.target === "cube" ? entry.flags.cast : entry.flags.receive;
      expect(entry.umbra, label).toBeGreaterThan(100);
      expect(entry.shadowed, label).toBe(expected ? entry.umbra : 0);
      // No second shadow: away from the umbra's edge, the open plane stays lit.
      expect(entry.open, label).toBeGreaterThan(5000);
      expect(entry.stray, label).toBeLessThanOrEqual(2);
    }
  });
}
