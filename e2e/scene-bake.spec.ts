import { expect, test } from "@playwright/test";
import type { runSceneBakeProof } from "../apps/editor/src/testing/scene-bake-proof";

test.use({
  launchOptions: {
    args: [
      process.platform === "win32"
        ? "--use-angle=d3d11-warp"
        : "--use-angle=swiftshader",
    ],
  },
});

// The real path-traced bake cannot finish on CI software GL inside its
// deadline; run this numerical proof locally on a GPU with BL_BAKE_QUALITY_E2E=1.
const QUALITY_ENABLED = process.env.BL_BAKE_QUALITY_E2E === "1";

test("prepares authored Scene sources and bakes Static full plus Stationary indirect without duplicate direct energy", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    !QUALITY_ENABLED,
    "Real path-traced bake quality check; set BL_BAKE_QUALITY_E2E=1 on a GPU run.",
  );
  test.setTimeout(180_000);
  const errors: string[] = [];
  const external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol.startsWith("http") &&
      !["localhost", "127.0.0.1"].includes(url.hostname)
    )
      external.push(url.href);
  });
  await page.goto("/?sceneBakeProof");
  await page.waitForFunction(() => "__sceneBakeProof" in window);
  await context.setOffline(true);
  const result = await page.evaluate(() =>
    (
      window as unknown as { __sceneBakeProof: typeof runSceneBakeProof }
    ).__sceneBakeProof(),
  );
  await testInfo.attach("prepared-scene-bake", {
    body: JSON.stringify({ result, errors, external }),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  expect(result.sceneGuid).toBe("authored-bake-scene");
  expect(result.receiver).toEqual({
    actorId: "receiver-actor",
    componentId: "receiver-component",
    primitive: { kind: "mesh" },
  });
  expect(result.realtimeCount).toBe(2);
  expect(result.sourceCount).toBe(2);
  const full = result.results.find((entry) => entry.mode === "full")!;
  const indirect = result.results.find((entry) => entry.mode === "indirect")!;
  // A planar receiver has no indirect bounce surface. Static E = 8/(4+x²+z²)^1.5.
  expect(full.minimum).toBeGreaterThan(0.5);
  expect(full.maximum).toBeGreaterThan(0.9);
  expect(full.maximum).toBeLessThanOrEqual(1.01);
  expect(full.colorDelta).toBeLessThan(0.001); // Receiver RGB albedo must not be baked into E.
  expect(indirect.maximum).toBeLessThan(0.0001);
  for (const entry of result.results) {
    expect(entry.covered).toBeGreaterThan(100);
    expect(entry.released).toBe(true);
  }
  expect(full.sources).not.toEqual(indirect.sources);
});
