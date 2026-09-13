import { expect, test } from "@playwright/test";

test("authored Post Process bindings preserve pixels through the opt-in FrameGraph adapter", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.goto("/?test=1&framegraphProof=1");
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __babylonslateFrameGraphProof?: unknown })
        .__babylonslateFrameGraphProof === "function",
  );
  const result = await page.evaluate(() =>
    (
      window as unknown as {
        __babylonslateFrameGraphProof: () => Promise<{
          captures: Array<{
            name: string;
            legacy: number[];
            graph: number[];
            width: number;
            height: number;
            passWidth: number;
            passHeight: number;
          }>;
          retainedPasses: number;
          retainedMaterials: number;
          ownedShaderSources: number;
          retainedShaderSources: number;
          diagnostics: Array<{ materialGuid?: string; message: string }>;
          webGLVersion: number;
          glInfo: unknown;
        }>;
      }
    ).__babylonslateFrameGraphProof(),
  );
  await testInfo.attach("framegraph-post-process-proof", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(result.webGLVersion).toBe(2);
  for (const capture of result.captures) {
    expect(capture.graph.length, capture.name).toBe(
      capture.width * capture.height * 4,
    );
    expect([capture.passWidth, capture.passHeight], capture.name).toEqual([
      capture.width,
      capture.height,
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
