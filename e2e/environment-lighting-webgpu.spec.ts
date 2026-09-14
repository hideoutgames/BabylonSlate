import { expect, test } from "@playwright/test";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import type { runEnvironmentIrradianceWebGpuProof } from "../apps/editor/src/lib/environment-lighting-proof";

test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-webgpu",
      process.platform === "win32"
        ? "--use-angle=d3d11-warp"
        : "--use-angle=swiftshader",
      "--use-webgpu-adapter=swiftshader",
    ],
  },
});

test("WebGPU prepares directional base irradiance while preserving another target", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      /WebGPU uncaptured error|shader.*error|VALIDATE_STATUS|ERROR: 0:/i.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol.startsWith("http") &&
      !["127.0.0.1", "localhost"].includes(url.hostname)
    )
      externalRequests.push(request.url());
  });
  await openMinimalTestProject(page);
  await openMainScene(page);
  const result = await page.evaluate(() =>
    (
      window as unknown as {
        __babylonslateViewportTest: {
          environmentIrradianceWebGpuProof: typeof runEnvironmentIrradianceWebGpuProof;
        };
      }
    ).__babylonslateViewportTest.environmentIrradianceWebGpuProof(),
  );
  await testInfo.attach("webgpu-environment", {
    body: JSON.stringify({ ...result, errors, externalRequests }),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(result.failure).toBeUndefined();
  expect(result.retainedEngines).toBe(0);
  expect(result.states).toHaveLength(2);
  for (const state of result.states) {
    expect(state.restored).toBe(true);
    expect(state.retainedTargets).toBe(0);
    expect(state.previousPixel).toEqual([64, 128, 191, 255]);
  }
  expect(result.polynomials.sampled).toHaveLength(27);
  result.polynomials.sampled!.forEach((value, index) =>
    expect(Math.abs(value - result.polynomials.supplied![index]!)).toBeLessThan(
      0.02,
    ),
  );
  for (const rotation of [0, 90]) {
    const actual = result.captures[`sampled-${rotation}`]!;
    const reference = result.captures[`supplied-${rotation}`]!;
    expect(Math.max(...reference.slice(0, 3))).toBeGreaterThan(20);
    actual.forEach((value, index) =>
      expect(Math.abs(value - reference[index]!)).toBeLessThanOrEqual(2),
    );
  }
});
