import { expect, test } from "@playwright/test";
import type { runBakeUvProof } from "../apps/editor/src/testing/bake-uv-proof";

test.use({
  launchOptions: {
    args: [
      process.platform === "win32"
        ? "--use-angle=d3d11-warp"
        : "--use-angle=swiftshader",
    ],
  },
});

test("generates UVs offline, cancels its owned worker and feeds preserved geometry into the irradiance provider", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol.startsWith("http") &&
      !["localhost", "127.0.0.1"].includes(url.hostname)
    )
      externalRequests.push(request.url());
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const live = new Set<Worker>();
    Object.assign(window, { __bakeUvWorkers: live });
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        live.add(this);
      }
      terminate() {
        live.delete(this);
        super.terminate();
      }
    };
  });
  await page.goto("/?bakeUvProof");
  await page.waitForFunction(() => "__bakeUvProof" in window);
  await context.setOffline(true);
  const result = await page.evaluate(() =>
    (
      window as unknown as { __bakeUvProof: typeof runBakeUvProof }
    ).__bakeUvProof(),
  );
  await testInfo.attach("bake-uv", {
    body: JSON.stringify({ result, errors, externalRequests }),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(result.cancelled).toBe(true);
  expect(result.sourceUnchanged).toBe(true);
  expect(result.indices).toHaveLength(6);
  expect(result.cubeVertices).toBeGreaterThan(8);
  expect(result.chartCount).toBe(6);
  expect(result.minimumChartGap).toBeGreaterThanOrEqual(2 - 0.001);
  expect(
    result.uv2.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ),
  ).toBe(true);
  expect(result.covered).toBeGreaterThan(100);
  expect(result.finite).toBe(true);
  // E = intensity * cos(theta) / distance²: square [-1,1]² beneath a light at y=2.
  expect(result.minimum).toBeGreaterThan(0.5);
  expect(result.maximum).toBeLessThanOrEqual(1.01);
  expect(result.maximum).toBeGreaterThan(0.9);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __bakeUvWorkers: Set<Worker> }).__bakeUvWorkers
          .size,
    ),
  ).toBe(0);
});
