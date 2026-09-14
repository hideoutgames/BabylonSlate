import { expect, test } from "@playwright/test";

test("opt-in Forward FrameGraph preserves surface pixels and scene ownership", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?test=1&framegraphForwardProof=1");
  await page.waitForFunction(
    () =>
      typeof (
        window as unknown as { __babylonslateFrameGraphForwardProof?: unknown }
      ).__babylonslateFrameGraphForwardProof === "function",
  );
  const result = await page.evaluate(() =>
    (
      window as unknown as {
        __babylonslateFrameGraphForwardProof: () => Promise<{
          webGLVersion: number;
          captures: Array<{
            name: string;
            classic: number[];
            graph: number[];
            classicDraws: number;
            graphDraws: number;
            readinessDraws: number;
            prepared: { path: string };
            result: { path: string };
            width: number;
            height: number;
            frames: number[];
            frozen: boolean;
          }>;
          lifecycle: Array<{
            mode: string;
            cameraFailures: number;
            retainedRenderers: number;
            retainedGraphs: number;
            siblingBefore: number[];
            siblingAfter: number[];
          }>;
        }>;
      }
    ).__babylonslateFrameGraphForwardProof(),
  );
  await testInfo.attach("framegraph-forward-proof", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(result.webGLVersion).toBe(2);
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
