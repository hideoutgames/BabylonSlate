import { expect, test } from "@playwright/test";
import type { runPoseBoundsProof } from "../apps/editor/src/testing/pose-bounds-proof";
import { encodeRgbaPng } from "../packages/render/src/png-encode";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Proof = typeof runPoseBoundsProof;

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`skinned actors culled by bounds that follow their pose draw the same image as when always drawn, and less out of view, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&poseBoundsProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __poseBoundsProof?: unknown }).__poseBoundsProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as { __poseBoundsProof: Proof }).__poseBoundsProof(backend), backend);
    await testInfo.attach(`pose-bounds-${backend}`, { body: JSON.stringify({ stages: result.stages, followed: result.followed }, null, 2), contentType: "application/json" });
    for (const [run, images] of Object.entries(result.images)) {
      for (const [index, image] of images.entries()) {
        await testInfo.attach(`${backend}-${run}-${index}.png`, {
          body: Buffer.from(encodeRgbaPng(result.width, result.height, new Uint8Array(image))), contentType: "image/png",
        });
      }
    }
    expect(errors).toEqual([]);
    // Both actors' bounds follow their skeletons in the culled run; none does in the run that draws them always.
    expect(result.followed).toEqual({ culled: [true, true], always: [false, false] });
    const [whole, crossing, away, carried, swung, second] = result.stages;
    expect(result.stages).toHaveLength(6);
    // Exactly the same image at every stage, every channel of every pixel: no posed vertex was culled.
    expect(result.stages.map((stage) => stage.differing)).toEqual([0, 0, 0, 0, 0, 0]);
    // The stages show what they say: an actor whole in view, part of it at the view's edge, none where the actors'
    // vertices were authored, then the first actor carried into that view and its arm swung over, and the second actor.
    expect(whole!.actor).toBeGreaterThan(400);
    expect(crossing!.actor).toBeGreaterThan(20);
    expect(crossing!.actor).toBeLessThan(whole!.actor);
    expect(away!.actor).toBe(0);
    // Carried there, the column stands close before the camera and leaves the view at the top; its arm then swings
    // down into it.
    expect(carried!.actor).toBeGreaterThan(100);
    expect(swung!.actor).toBeGreaterThan(carried!.actor + 100);
    expect(second!.actor).toBeGreaterThan(400);
    // Out of view the actors cost nothing: the culled run draws less there, and no more anywhere.
    expect(away!.draws.culled).toBeLessThan(away!.draws.always);
    for (const stage of result.stages) expect(stage.draws.culled).toBeLessThanOrEqual(stage.draws.always);
  });
}
