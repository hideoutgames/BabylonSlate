import { expect, test } from "@playwright/test";
import type { runCascadeShimmerProof } from "../apps/editor/src/testing/cascade-shimmer-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Proof = typeof runCascadeShimmerProof;

/** Per pixel, the Chebyshev distance to the nearest pixel where `source` holds (a breadth-first search over 8 neighbours). */
function chebyshevDistance(source: boolean[], width: number, height: number): number[] {
  const distance = source.map((held) => (held ? 0 : Infinity));
  const queue = source.flatMap((held, pixel) => (held ? [pixel] : []));
  for (let head = 0; head < queue.length; head++) {
    const pixel = queue[head]!, row = Math.floor(pixel / width), column = pixel % width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const y = row + dy, x = column + dx;
        if (y < 0 || y >= height || x < 0 || x >= width) continue;
        const neighbour = y * width + x;
        if (distance[neighbour]! <= distance[pixel]! + 1) continue;
        distance[neighbour] = distance[pixel]! + 1;
        queue.push(neighbour);
      }
    }
  }
  return distance;
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`the sun's log-split cascades keep shadow edges where they belong while the camera slides, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?test=1&cascadeShimmerProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __cascadeShimmerProof?: unknown }).__cascadeShimmerProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __cascadeShimmerProof: Proof }).__cascadeShimmerProof(backend), backend);
    const { width, height } = result;
    let previous: { drawn: number[]; blocked: number[] } | null = null;
    const report = { lambda: result.lambda, cascades: result.cascades, misplaced: 0, farthestMisplaced: 0, shimmering: 0, edgePixels: 0 };
    for (const frame of result.frames) {
      // How far each floor pixel lies from the ray-cast shadow's outline.
      const toBlocked = chebyshevDistance(frame.blocked.map((kind) => kind === 1), width, height);
      const toOpen = chebyshevDistance(frame.blocked.map((kind) => kind === 0), width, height);
      frame.blocked.forEach((kind, pixel) => {
        if (kind < 0) return;
        const edge = kind === 1 ? toOpen[pixel]! : toBlocked[pixel]!;
        if (edge === 1) report.edgePixels++;
        if (frame.drawn[pixel] !== kind) {
          report.misplaced++;
          report.farthestMisplaced = Math.max(report.farthestMisplaced, edge);
        }
        // A pixel whose drawn shadow changes from the last frame while what blocks it does not, away from the outline.
        if (previous && previous.blocked[pixel] === kind && previous.drawn[pixel]! >= 0 && previous.drawn[pixel] !== frame.drawn[pixel] && edge > 1)
          report.shimmering++;
      });
      previous = frame;
    }
    await testInfo.attach(`cascade-shimmer-${backend}`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    console.log(JSON.stringify(report));
    expect(errors).toEqual([]);
    // Medium's log split: the first cascade ends at 4 · (250 / 4)^(1/3) m.
    expect(report.lambda).toBe(1);
    expect(result.cascades[0]!.end).toBeCloseTo(15.874, 2);
    // Every frame draws the shadows' outlines (thousands of edge pixels over the run) within a pixel of the ray-cast one,
    // and no pixel off an outline flickers as the camera moves.
    expect(report.edgePixels).toBeGreaterThan(1000);
    expect(report.farthestMisplaced).toBeLessThanOrEqual(1);
    expect(report.shimmering).toBe(0);
  });
}
