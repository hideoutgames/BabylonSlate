import { expect, test } from "@playwright/test";
import type { runClusteredLightProof } from "../apps/editor/src/testing/clustered-light-proof";

test("clustered point and spot contributions preserve native and graph PBR and CEL pixels", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" ||
      (message.type() === "warning" &&
        /shader|GL_INVALID|GL_OUT_OF_MEMORY|invalid|context lost/i.test(
          message.text(),
        ))
    )
      errors.push(message.text());
  });
  await page.goto("/?test=1&clusteredLightProof=1");
  await page.waitForFunction(
    () =>
      typeof (
        window as unknown as { __babylonslateClusteredLightProof?: unknown }
      ).__babylonslateClusteredLightProof === "function",
  );
  const result = await page.evaluate(() =>
    (
      window as unknown as {
        __babylonslateClusteredLightProof: typeof runClusteredLightProof;
      }
    ).__babylonslateClusteredLightProof(),
  );
  await testInfo.attach("clustered-light-proof", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  expect(errors).toEqual([]);
  expect(result.capabilities.supported).toBe(true);
  expect(result.captures).toHaveLength(36);
  for (const capture of result.captures) {
    expect(capture.prepared, capture.name).toEqual({ path: "frameGraph" });
    expect(capture.result, capture.name).toEqual({ path: "frameGraph" });
    expect(capture.readinessDraws, capture.name).toBe(0);
    expect(capture.status.clustered, capture.name).toBe(capture.count);
    expect(capture.draws, capture.name).toBeGreaterThanOrEqual(5);
    let difference = 0;
    let litPixels = 0;
    for (let index = 0; index < capture.clustered.length; index++) {
      difference = Math.max(
        difference,
        Math.abs(capture.clustered[index]! - capture.reference[index]!),
      );
      if (
        index % 4 === 0 &&
        Math.max(...capture.clustered.slice(index, index + 3)) > 25
      )
        litPixels++;
    }
    expect(litPixels, capture.name).toBeGreaterThan(100);
    expect(difference, capture.name).toBeLessThanOrEqual(2);
  }
  expect(result.ties).toHaveLength(4);
  for (const capture of result.ties) {
    expect(capture.prepared, capture.name).toEqual({ path: "frameGraph" });
    expect(capture.result, capture.name).toEqual({ path: "frameGraph" });
    expect(capture.readinessDraws, capture.name).toBe(0);
    const center =
      (Math.floor(capture.height / 2) * capture.width +
        Math.floor(capture.width / 2)) *
      4;
    expect(
      capture.reference[center]! - capture.reference[center + 1]!,
      capture.name,
    ).toBeGreaterThan(20);
    expect(
      Math.max(
        ...capture.clustered.map((value, index) =>
          Math.abs(value - capture.reference[index]!),
        ),
      ),
      capture.name,
    ).toBeLessThanOrEqual(2);
  }
  for (const mixing of ["pbr", "strongest", "additive", "blend"]) {
    const pixels = (pose: string) =>
      result.captures.find((capture) => capture.name === `${mixing}-${pose}`)!
        .clustered;
    expect(pixels("camera-moved")).not.toEqual(pixels("camera-switched"));
    expect(pixels("lights-moved")).not.toEqual(pixels("camera-moved"));
    expect(pixels("after-sibling")).toEqual(pixels("resized"));
  }
  for (const lifecycle of result.lifecycle) {
    expect(lifecycle.sameMask, lifecycle.mixing).toBe(true);
    expect(lifecycle.siblingAfter, lifecycle.mixing).toEqual(
      lifecycle.siblingBefore,
    );
    expect(lifecycle.liveLights, lifecycle.mixing).toBe(48);
    expect(lifecycle.clusteredTextures, lifecycle.mixing).toBe(0);
    expect(lifecycle.renderers, lifecycle.mixing).toBe(0);
  }
});
