import { expect, test } from "@playwright/test";
import type { runShadowFilterProof } from "../apps/editor/src/testing/shadow-filter-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

type Proof = typeof runShadowFilterProof;
type Capture = Awaited<ReturnType<Proof>>["captures"][number];

/** Per capture: the edge's profile across each pixel row, and its 50% contour's straightness. */
function measure(capture: Capture, width: number, height: number) {
  let rise = 0, fall = 0;
  const widths: number[] = [];
  const crossing = new Map<number, number>();
  for (let row = 0; row < height; row++) {
    const lit = capture.lit.slice(row * width, (row + 1) * width);
    if (lit.some((value) => value < 0)) continue;
    for (let x = 0; x + 1 < width; x++) {
      rise = Math.max(rise, lit[x + 1]! - lit[x]!);
      fall = Math.max(fall, lit[x]! - lit[x + 1]!);
      if (!crossing.has(row) && lit[x]! < 0.5 && lit[x + 1]! >= 0.5) crossing.set(row, x + (0.5 - lit[x]!) / (lit[x + 1]! - lit[x]!));
    }
    let dark = -1;
    lit.forEach((value, x) => { if (value < 0.1) dark = x; });
    const bright = lit.findIndex((value) => value > 0.9);
    if (dark >= 0 && bright > dark) widths.push(bright - dark);
  }
  // Stair steps bend the contour within a texel or two; a straight edge's contour is the mean of its neighbours'.
  let stairs = 0;
  for (const [row, x] of crossing) {
    const above = crossing.get(row - 3), below = crossing.get(row + 3);
    if (above !== undefined && below !== undefined) stairs = Math.max(stairs, Math.abs(x - (above + below) / 2));
  }
  return { rows: crossing.size, rise, fall, width: Math.min(...widths), stairs, pixelsPerTexel: capture.pixelsPerTexel };
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`a shadow edge across texels wider than pixels is smooth and monotonic, on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) &&
        /shader|WGSL|WebGPU uncaptured|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&shadowFilterProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __shadowFilterProof?: unknown }).__shadowFilterProof === "function");
    const result = await page.evaluate((backend) =>
      (window as unknown as { __shadowFilterProof: Proof }).__shadowFilterProof(backend), backend);
    const report = Object.fromEntries(result.captures.map((capture) => [capture.quality, measure(capture, result.width, result.height)]));
    await testInfo.attach(`shadow-filter-${backend}`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    expect(errors).toEqual([]);
    const { low, medium, high } = report as Record<"low" | "medium" | "high", ReturnType<typeof measure>>;
    // Texels several pixels wide, and the edge crossing every row.
    expect(high.pixelsPerTexel).toBeGreaterThan(3);
    for (const entry of [low, medium, high]) expect(entry.rows).toBeGreaterThan(100);
    // Medium (5 × 5 texels) and High (7 × 7): monotonic across the edge, no pixel-sized jump, a straight contour.
    for (const entry of [medium, high]) {
      expect(entry.fall).toBeLessThan(0.01);
      expect(entry.rise).toBeLessThan(0.09);
      expect(entry.stairs).toBeLessThan(0.1 * entry.pixelsPerTexel);
    }
    // Their ramps (10% to 90%) span several texels, High's the wider.
    expect(medium.width).toBeGreaterThan(3 * medium.pixelsPerTexel);
    expect(high.width).toBeGreaterThan(3.5 * high.pixelsPerTexel);
    expect(high.width).toBeGreaterThan(medium.width);
    // The measures see stairs where they are: Low's single bilinear tap steps with the texels.
    expect(low.rise).toBeGreaterThan(0.15);
    expect(low.stairs).toBeGreaterThan(0.3 * low.pixelsPerTexel);
  });
}
