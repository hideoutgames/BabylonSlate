import { expect, test } from "@playwright/test";
import type { runSurfaceLightingProof } from "../apps/editor/src/testing/surface-lighting-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`a Sprite's 2D and 3D Shading Modes compile and light it, on ${backend}`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&surfaceLightingProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __surfaceLightingProof?: unknown }).__surfaceLightingProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __surfaceLightingProof: typeof runSurfaceLightingProof }).__surfaceLightingProof(backend), backend);
    expect(errors).toEqual([]);
    // 2D: next to the Point light a white sprite is near full; past its radius only the 0.1 Global light remains.
    expect(result.twoDNear, "2D near").toBeGreaterThan(200);
    expect(result.twoDFar, "2D far").toBeGreaterThan(15);
    expect(result.twoDFar, "2D far").toBeLessThan(40);
    // 3D: the point light brightens the sprite's facing side and leaves its far edge unlit.
    expect(result.threeDNear, "3D near").toBeGreaterThan(result.threeDFar + 60);
  });
}
