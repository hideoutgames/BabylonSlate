import { expect, test } from "@playwright/test";
import type { runFrameGraphShadowProof } from "../apps/editor/src/testing/framegraph-shadow-proof";

test("Forward FrameGraph borrows admitted shadows with pixel, refresh and scene ownership parity", async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /shader|ERROR: 0:|VALIDATE_STATUS|context lost/i.test(message.text())
    )
      errors.push(message.text());
  });
  await page.goto("/?test=1&framegraphShadowProof=1");
  await page.waitForFunction(
    () =>
      typeof (
        window as unknown as { __babylonslateFrameGraphShadowProof?: unknown }
      ).__babylonslateFrameGraphShadowProof === "function",
  );
  const result = await page.evaluate(() =>
    (
      window as unknown as {
        __babylonslateFrameGraphShadowProof: typeof runFrameGraphShadowProof;
      }
    ).__babylonslateFrameGraphShadowProof(),
  );
  await testInfo.attach("framegraph-managed-shadow-proof", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(result.webGLVersion).toBe(2);
  expect(result.captures).toHaveLength(54);
  const difference = (a: number[], b: number[]) => {
    expect(a.length).toBe(b.length);
    let maximum = 0;
    for (let i = 0; i < a.length; i++)
      maximum = Math.max(maximum, Math.abs(a[i]! - b[i]!));
    return maximum;
  };
  for (const capture of result.captures) {
    expect(capture.prepared, capture.name).toEqual({ path: "frameGraph" });
    expect(capture.graph.result, capture.name).toEqual({ path: "frameGraph" });
    expect(capture.forceGraph.result, capture.name).toEqual({
      path: "frameGraph",
    });
    expect(capture.readinessDraws, capture.name).toBe(0);
    expect(capture.readinessFaces, capture.name).toBe(0);
    expect(capture.classic.classicReadyBefore, capture.name).toBe(true);
    expect(capture.sameMap, capture.name).toBe(true);
    expect(capture.graph.pixels.length, capture.name).toBe(
      capture.width * capture.height * 4,
    );
    expect(capture.classic.draws, capture.name).toBeGreaterThanOrEqual(4);
    expect(capture.forceGraph.draws, capture.name).toBe(capture.classic.draws);
    const disabled = capture.name.endsWith("-disabled");
    const sun = capture.name.includes("-sun-");
    const faces = disabled
      ? 0
      : capture.name.includes("-point-")
        ? 6
        : sun
          ? 2
          : 1;
    expect(capture.allocations, capture.name).toBe(disabled ? 0 : 1);
    expect(capture.generatorEntries, capture.name).toBe(disabled ? 0 : 1);
    expect(capture.classic.faces, capture.name).toBe(faces);
    expect(capture.forceGraph.faces, capture.name).toBe(faces);
    expect(capture.settled.faces, capture.name).toBe(sun && !disabled ? 2 : 0);
    if (sun && !disabled) expect(capture.cascades, capture.name).toBe(2);
    for (const frame of [capture.graph, capture.settled, capture.forceGraph]) {
      expect(
        difference(frame.pixels, capture.classic.pixels),
        capture.name,
      ).toBeLessThanOrEqual(1);
    }
    if (/-initial$|-caster-moved$|-light-moved$|-reloaded$/.test(capture.name))
      expect(capture.graph.faces, capture.name).toBe(faces);
  }
  for (const entry of result.lifecycle) {
    expect(entry.stableAllocation, entry.name).toBe(true);
    expect(entry.ownedAfterGraphDispose, entry.name).toBe(true);
    expect(entry.retainedGraphObjects, entry.name).toBe(0);
    expect(entry.siblingPreserved, entry.name).toBe(true);
    expect(entry.remainingScenes, entry.name).toBe(0);
    expect(
      difference(entry.siblingBefore.pixels, entry.siblingAfter.pixels),
      entry.name,
    ).toBeLessThanOrEqual(1);
    expect(
      difference(entry.initial, entry.reload),
      entry.name,
    ).toBeLessThanOrEqual(1);
    let shadowPixels = 0;
    for (let i = 0; i < entry.unshadowed.length; i += 4) {
      const green = entry.unshadowed[i + 1]!;
      if (
        green > 30 &&
        green > entry.unshadowed[i]! * 1.4 &&
        green > entry.unshadowed[i + 2]! * 1.2 &&
        green - entry.shadowed[i + 1]! > 8
      )
        shadowPixels++;
    }
    expect(
      shadowPixels,
      `${entry.name} must show real receiver shadows`,
    ).toBeGreaterThan(10);
    const pose = (name: string) =>
      result.captures.find(
        (capture) => capture.name === `${entry.name}-${name}`,
      )!.graph.pixels;
    expect(pose("caster-moved"), entry.name).not.toEqual(pose("initial"));
    expect(pose("light-moved"), entry.name).not.toEqual(pose("caster-moved"));
  }
});
