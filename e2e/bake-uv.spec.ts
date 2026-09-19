import { expect, test, type Page } from "@playwright/test";
import type {
  runBakeUvProof,
  runBakeUvProviderProof,
} from "../apps/editor/src/testing/bake-uv-proof";

// CI runs the bake on software GL, where real path tracing exceeds the two-minute
// provider deadline; the irradiance feed check needs BL_BAKE_QUALITY_E2E=1 on a GPU.
const QUALITY_ENABLED = process.env.BL_BAKE_QUALITY_E2E === "1";

test.use({
  launchOptions: {
    args: [
      process.platform === "win32"
        ? "--use-angle=d3d11-warp"
        : "--use-angle=swiftshader",
    ],
  },
});

function watchPage(page: Page) {
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
  return { errors, externalRequests };
}

async function openUvProof(page: Page) {
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
  await page.waitForFunction(
    () =>
      "__bakeUvProof" in window && "__bakeUvProviderProof" in (window as object),
  );
}

function liveWorkers(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __bakeUvWorkers: Set<Worker> }).__bakeUvWorkers
        .size,
  );
}

test("generates UVs offline, cancels its owned worker and preserves geometry into the provider input", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120_000);
  const { errors, externalRequests } = watchPage(page);
  await openUvProof(page);
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
  // Preserved geometry reaches the provider input: every per-corner position is
  // a source vertex and every uv2 stays in the generated atlas.
  expect(result.providerPositionsPreserved).toBe(true);
  expect(result.providerPositions).toHaveLength(result.indices.length * 3);
  expect(result.providerPositions.every(Number.isFinite)).toBe(true);
  expect(result.providerUv2).toHaveLength(result.indices.length * 2);
  expect(
    result.providerUv2.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ),
  ).toBe(true);
  expect(await liveWorkers(page)).toBe(0);
});

test("feeds preserved geometry into the irradiance provider", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    !QUALITY_ENABLED,
    "Real path-traced bake quality check; set BL_BAKE_QUALITY_E2E=1 on a GPU run.",
  );
  test.setTimeout(240_000);
  const { errors, externalRequests } = watchPage(page);
  await openUvProof(page);
  await context.setOffline(true);
  const result = await page.evaluate(() =>
    (
      window as unknown as {
        __bakeUvProviderProof: typeof runBakeUvProviderProof;
      }
    ).__bakeUvProviderProof(),
  );
  await testInfo.attach("bake-uv-provider", {
    body: JSON.stringify({ result, errors, externalRequests }),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(result.covered).toBeGreaterThan(100);
  expect(result.finite).toBe(true);
  // E = intensity * cos(theta) / distance²: square [-1,1]² beneath a light at y=2.
  expect(result.minimum).toBeGreaterThan(0.5);
  expect(result.maximum).toBeLessThanOrEqual(1.01);
  expect(result.maximum).toBeGreaterThan(0.9);
  expect(await liveWorkers(page)).toBe(0);
});
