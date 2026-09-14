import { expect, test } from "@playwright/test";
import type { runFrameGraphPostProcessProof } from "../apps/editor/src/testing/framegraph-post-process-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {

test(`authored Post Process bindings preserve pixels through the opt-in FrameGraph adapter on ${backend}`, async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  const externalRequests: string[] = [];
  await page.route(/https:\/\/cdn\.babylonjs\.com\/.*(?:glslang|twgsl)/, async (route) => {
    externalRequests.push(route.request().url());
    await route.abort();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
  });
  await page.goto("/?test=1&framegraphProof=1");
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __babylonslateFrameGraphProof?: unknown })
        .__babylonslateFrameGraphProof === "function",
  );
  const result = await page.evaluate((backend) =>
    (window as unknown as {
      __babylonslateFrameGraphProof: typeof runFrameGraphPostProcessProof;
    }).__babylonslateFrameGraphProof(backend), backend,
  );
  await testInfo.attach("framegraph-post-process-proof", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(result.backend).toBe(backend);
  if (backend === "webgl2") expect(result.webGLVersion).toBe(2);
  for (const capture of result.captures) {
    expect(capture.graph.length, capture.name).toBe(
      capture.width * capture.height * 4,
    );
    const scale = capture.name === "half-resolution" ? 0.5 : 1;
    expect([capture.passWidth, capture.passHeight], capture.name).toEqual([
      capture.width * scale,
      capture.height * scale,
    ]);
    const maxDifference = Math.max(
      ...capture.graph.map((value, index) =>
        Math.abs(value - capture.legacy[index]!),
      ),
    );
    expect(maxDifference, capture.name).toBeLessThanOrEqual(1);
  }
  const pixels = (name: string) =>
    result.captures.find((capture) => capture.name === name)!.graph;
  expect(pixels("color").slice(0, 3)).toEqual([80, 40, 20]);
  expect(pixels("parameter").slice(0, 3)).toEqual([120, 60, 30]);
  expect(pixels("hot-rebuild")).toEqual(pixels("parameter"));
  expect(pixels("nested-function").slice(0, 3)).toEqual([40, 20, 10]);
  expect(pixels("time-next")).not.toEqual(pixels("time-first"));
  expect(pixels("texture-updated")).not.toEqual(pixels("texture"));
  expect(pixels("ordered-stack")).not.toEqual(pixels("disabled-middle"));
  expect(pixels("binding-failed-middle")).toEqual(pixels("disabled-middle"));
  expect(pixels("failed-middle")).toEqual(pixels("disabled-middle"));
  expect(pixels("enabled-gain")).not.toEqual(pixels("initial-disabled-gain"));
  expect(pixels("re-enabled-gain")).toEqual(pixels("enabled-gain"));
  expect(pixels("disabled-gain-again")).toEqual(
    pixels("initial-disabled-gain"),
  );
  expect(pixels("disabled-missing").slice(0, 3)).toEqual([160, 80, 40]);
  expect(result.disabledResources).toEqual([
    { phase: "initial", materials: 0, passes: 0, shaderSources: 0 },
    { phase: "disabled-again", materials: 0, passes: 0, shaderSources: 0 },
    { phase: "missing", materials: 0, passes: 0, shaderSources: 0 },
  ]);
  expect(result.retainedPasses).toBe(0);
  expect(result.retainedMaterials).toBe(0);
  expect(result.ownedShaderSources).toBeGreaterThan(0);
  expect(result.retainedShaderSources).toBe(0);
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      materialGuid: "proof-1",
      message: expect.stringContaining("Proof binding failure"),
    }),
    expect.objectContaining({
      materialGuid: "proof-1",
      message: expect.stringContaining("missing"),
    }),
  ]);
});

}
