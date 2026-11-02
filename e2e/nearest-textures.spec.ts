import { expect, test } from "@playwright/test";
import type { runNearestTexturesProof } from "../apps/editor/src/testing/nearest-textures-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Proof = typeof runNearestTexturesProof;

// A frozen Material keeps its texture bindings between draws (WebGPU binds the sampler with them): the switch must
// still reach it at once, both ways, and reach a texture that loads while it is on.
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Nearest Texture Filtering switches a frozen Material's texture live, both ways, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&nearestTexturesProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __nearestTexturesProof?: unknown }).__nearestTexturesProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __nearestTexturesProof: Proof }).__nearestTexturesProof(backend), backend);
    await testInfo.attach(`nearest-textures-${backend}`, { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    expect(errors).toEqual([]);
    // The checker fills the view: linear filtering blends its cells into a wide band of greys.
    expect(result.off.high - result.off.low).toBeGreaterThan(100);
    expect(result.off.between).toBeGreaterThan(1000);
    expect(result.restored.between).toBeGreaterThan(1000);
    expect({ on: result.on.between, loadedWhileOn: result.loadedWhileOn.between }).toEqual({ on: 0, loadedWhileOn: 0 });
  });
}
