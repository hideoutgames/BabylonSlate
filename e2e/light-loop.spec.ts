import { expect, test } from "@playwright/test";
import type { runLightLoopProof } from "../apps/editor/src/testing/light-loop-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`the light block's loops visit every admitted light at each pixel, its clusters list those in range, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&lightLoopProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __lightLoopProof?: unknown }).__lightLoopProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __lightLoopProof: typeof runLightLoopProof }).__lightLoopProof(backend), backend);
    expect(errors).toEqual([]);
    expect({ lights: result.lights, admitted: result.admitted }).toEqual({ lights: 48, admitted: 32 });

    // Floor pixels: everything the clear colour does not show.
    const floor = result.pbr.visited.flatMap((visited, pixel) => (visited > 0 ? [pixel] : []));
    expect(floor.length).toBeGreaterThan(result.width * result.height * 0.5);
    // Today's loops visit every admitted point light at every pixel; the pixel's range test keeps those that reach it.
    expect(floor.filter((pixel) => result.pbr.visited[pixel] !== 32)).toEqual([]);
    expect(floor.filter((pixel) => result.pbr.reached[pixel]! > result.pbr.visited[pixel]!)).toEqual([]);
    // The pixel's cluster lists every light that reaches it, and at most the admitted ones.
    expect(floor.filter((pixel) => result.pbr.clustered[pixel]! < result.pbr.reached[pixel]!)).toEqual([]);
    expect(floor.filter((pixel) => result.pbr.clustered[pixel]! > 32)).toEqual([]);
    // CEL's loops are the same shape.
    expect(result.cel.visited).toEqual(result.pbr.visited);
    expect(result.cel.reached).toEqual(result.pbr.reached);
    expect(result.cel.clustered).toEqual(result.pbr.clustered);

    // The shader's in-range count agrees with the CPU's count at the sampled floor points (a sample on a range's edge
    // can fall either side).
    const sampled = result.samples.filter(({ pixel }) => result.pbr.visited[pixel]! > 0);
    expect(sampled.length).toBeGreaterThan(100);
    const off = sampled.filter(({ pixel, reached }) => Math.abs(result.pbr.reached[pixel]! - reached) > 1);
    expect(off).toEqual([]);
    const differ = sampled.filter(({ pixel, reached }) => result.pbr.reached[pixel] !== reached);
    expect(differ.length).toBeLessThanOrEqual(Math.ceil(sampled.length * 0.05));

    const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
    const visited = mean(floor.map((pixel) => result.pbr.visited[pixel]!));
    const reached = mean(floor.map((pixel) => result.pbr.reached[pixel]!));
    const clustered = mean(floor.map((pixel) => result.pbr.clustered[pixel]!));
    // The baseline light culling is measured against: iterations a pixel spends on lights that cannot reach it.
    await testInfo.attach(`light-loop-${backend}`, {
      body: JSON.stringify({ floorPixels: floor.length, meanVisited: visited, meanReached: reached, meanClustered: clustered, wastedShare: 1 - reached / visited }),
      contentType: "application/json",
    });
    expect(reached).toBeGreaterThan(2);
    expect(reached).toBeLessThan(12);
    // The clusters cut most of the iterations a pixel spends on lights out of its reach.
    expect(clustered).toBeLessThan(visited / 2);
  });
}
