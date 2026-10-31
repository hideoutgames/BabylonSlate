import { expect, test } from "@playwright/test";
import type { runUnlitParityProof } from "../apps/editor/src/testing/unlit-parity-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`the unlit Material draws what the Standard setups it replaces drew, on ${backend}`, async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&unlitParityProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __unlitParityProof?: unknown }).__unlitParityProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __unlitParityProof: typeof runUnlitParityProof }).__unlitParityProof(backend), backend);
    expect(errors).toEqual([]);
    for (const { mode, fog, standard, unlit } of result.results) {
      expect(unlit.length, `${mode} ${fog}`).toBe(standard.length);
      // Every quad drew: most pixels differ from the clear colour.
      expect(standard.filter((value, index) => index % 4 !== 3 && Math.abs(value - 128) > 3).length, `${mode} ${fog} drew`).toBeGreaterThan(standard.length / 8);
      // Ambient occlusion at full strength rounds a few backdrop texels beside opaque quads' edges up to 3 levels apart on
      // WebGL2 (WebGPU matches within 1).
      const tolerance = mode === "spatial" ? 3 : 1;
      const differing: string[] = [];
      for (let index = 0; index < standard.length; index++) {
        if (Math.abs(standard[index]! - unlit[index]!) <= tolerance) continue;
        const pixel = index >> 2;
        differing.push(`(${pixel % result.width}, ${Math.floor(pixel / result.width)}) channel ${index % 4}: ${standard[index]} vs ${unlit[index]}`);
      }
      expect(differing.slice(0, 12), `${mode} ${fog}: ${differing.length} channels differ`).toEqual([]);
    }
  });
}
