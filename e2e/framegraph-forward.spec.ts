import { expect, test } from "@playwright/test";
import type { runFrameGraphForwardProof } from "../apps/editor/src/testing/framegraph-forward-proof";

test.use({ launchOptions: { args: ["--enable-unsafe-webgpu", process.platform === "win32" ? "--use-angle=d3d11-warp" : "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader"] } });

for (const backend of ["webgl2", "webgpu"] as const) {
test(`opt-in Forward FrameGraph preserves surface pixels and scene ownership on ${backend}`, async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  const externalRequests: string[] = [];
  await page.route(/https:\/\/cdn\.babylonjs\.com\/.*(?:glslang|twgsl)/, async (route) => {
    externalRequests.push(route.request().url());
    await route.abort();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (/WebGPU uncaptured error|shader.*error|VALIDATE_STATUS|ERROR: 0:/i.test(message.text())) errors.push(message.text());
  });
  await page.goto("/?test=1&framegraphForwardProof=1");
  await page.waitForFunction(
    () =>
      typeof (
        window as unknown as { __babylonslateFrameGraphForwardProof?: unknown }
      ).__babylonslateFrameGraphForwardProof === "function",
  );
  const result = await page.evaluate((backend) =>
    (
      window as unknown as {
        __babylonslateFrameGraphForwardProof: typeof runFrameGraphForwardProof;
      }
    ).__babylonslateFrameGraphForwardProof(backend), backend,
  );
  await testInfo.attach("framegraph-forward-proof", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(result.backend).toBe(backend);
  expect(result.webGLVersion).toBe(backend === "webgl2" ? 2 : null);
  expect(result.captures).toHaveLength(12);
  for (const capture of result.captures) {
    expect(capture.prepared, capture.name).toEqual({ path: "frameGraph" });
    expect(capture.result, capture.name).toEqual({ path: "frameGraph" });
    expect(capture.readinessDraws, capture.name).toBe(0);
    expect(capture.frames, capture.name).toEqual([1, 1]);
    expect(capture.classicDraws, capture.name).toBeGreaterThanOrEqual(4);
    expect(capture.graphDraws, capture.name).toBe(capture.classicDraws);
    expect(capture.graph.length, capture.name).toBe(
      capture.width * capture.height * 4,
    );
    let maxDifference = 0;
    for (let index = 0; index < capture.graph.length; index++) {
      maxDifference = Math.max(
        maxDifference,
        Math.abs(capture.graph[index]! - capture.classic[index]!),
      );
    }
    expect(maxDifference, capture.name).toBeLessThanOrEqual(1);
    if (!capture.name.endsWith("-surface"))
      expect(capture.frozen, capture.name).toBe(true);
  }
  for (const mode of ["pbr", "cel"]) {
    const pixels = (pose: string) =>
      result.captures.find((capture) => capture.name === `${mode}-${pose}`)!
        .graph;
    expect(pixels("frozen")).toEqual(pixels("surface"));
    expect(pixels("camera-switched")).not.toEqual(pixels("frozen"));
    expect(pixels("camera-moved")).not.toEqual(pixels("camera-switched"));
    expect(pixels("after-sibling")).toEqual(pixels("resized"));
  }
  expect(result.captures[0]!.graph).not.toEqual(result.captures[6]!.graph);
  for (const entry of result.lifecycle) {
    expect(entry.cameraFailures, entry.mode).toBe(0);
    expect(entry.retainedRenderers, entry.mode).toBe(0);
    expect(entry.retainedGraphs, entry.mode).toBe(0);
    expect(entry.siblingAfter, entry.mode).toEqual(entry.siblingBefore);
  }
});
}
