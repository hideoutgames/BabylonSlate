import { expect, test } from "@playwright/test";
import type { runVariantSwapProof } from "../apps/editor/src/testing/variant-swap-proof";

test("a world view draws each Material's previous Effect with the changed lights while its new variant compiles, without a GL error", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error|too small/i.test(message.text())) errors.push(message.text());
  });
  await page.goto("/?test=1&variantSwapProof=1");
  await page.waitForFunction(() =>
    typeof (window as unknown as { __hapticVariantSwapProof?: unknown }).__hapticVariantSwapProof === "function");
  const result = await page.evaluate(() =>
    (window as unknown as { __hapticVariantSwapProof: typeof runVariantSwapProof }).__hapticVariantSwapProof());
  await testInfo.attach("variant-swap-proof", { body: JSON.stringify(result), contentType: "application/json" });
  expect(errors).toEqual([]);
  const materials = ["native pbr", "native standard", "cel source:CEL", "graph"];
  expect(result.steps.map((step) => step.name)).toEqual([
    "a spot gives way to a point", "the sun is removed", "a spot stops casting shadows", "a point light stops casting shadows",
  ]);
  for (const step of result.steps) {
    // Each Material drew its previous Effect in every steady frame while its new variant was held back, with no GL
    // error, then drew the new variant once released.
    expect(step.drawn, step.name).toBe(3);
    expect(step.previousDrawn.sort(), step.name).toEqual([...materials].sort());
    expect(step.glErrors, step.name).toEqual([]);
    expect(step.adopted.sort(), step.name).toEqual([...materials].sort());
    expect(step.litPixels, step.name).toBeGreaterThan(400);
  }
  // Each previous Effect drew what its reference shows (float rounding only). With no spot left, the spot slot binds
  // an empty spot: the frame is the sun and the near point alone. A light that stopped casting shadows still lights
  // through its map's placeholder, which reads as an empty map: the frame is the new variant's.
  expect(Object.fromEntries(result.steps.flatMap((step) =>
    step.referenceDifference === undefined ? [] : [[step.name, step.referenceDifference <= 2]]))).toEqual({
    "a spot gives way to a point": true, "a spot stops casting shadows": true, "a point light stops casting shadows": true,
  });
  // A light starts casting shadows: no frame held, each Material drew its previous Effect, then its shadowed variant
  // sampled the new map before the map ever drew and read it as lit (the frame unchanged), and once the casters linked
  // the map drew and the boxes' shadows darkened the floors (sharp shadows: a few pixels at this size).
  expect(result.shadowGains.map((gain) => gain.name)).toEqual(["a spot starts casting shadows", "a point light starts casting shadows"]);
  for (const gain of result.shadowGains) {
    expect({
      held: gain.drawn.held, previous: gain.drawn.previous, adopted: [...gain.adopted].sort(), casters: gain.casters > 0,
      mapDrawn: gain.mapDrawn, unchangedWhileHeld: gain.heldDifference <= 2, litBeforeFirstDraw: gain.neutralDifference <= 2,
      shadowed: gain.shadowPixels > 8, glErrors: gain.glErrors,
    }, JSON.stringify(gain)).toEqual({
      held: 0, previous: 3, adopted: [...materials].sort(), casters: true,
      mapDrawn: true, unchangedWhileHeld: true, litBeforeFirstDraw: true, shadowed: true, glErrors: [],
    });
  }
  // An actor spawns with a variant nothing compiled: every frame draws, the box shows nowhere while its variant
  // compiles (the frame is the one before the spawn: no colour, depth or shadow of it), then it appears.
  const spawn = result.spawn;
  expect({
    drawn: spawn.frames.drawn, compiling: spawn.compiling, unchangedWhileHidden: spawn.hiddenDifference <= 2,
    appeared: spawn.appeared > 20, glErrors: spawn.glErrors,
  }, JSON.stringify(spawn)).toEqual({ drawn: 3, compiling: true, unchangedWhileHidden: true, appeared: true, glErrors: [] });
  // An actor spawns with a Material the load warmed on a staged box, since disposed: no program links on the real
  // context and the box draws in its first frame.
  const warm = result.warmSpawn;
  expect({ staged: warm.staged, links: warm.links, drawn: warm.drawn, appeared: warm.appeared > 20, glErrors: warm.glErrors },
    JSON.stringify(warm)).toEqual({ staged: 0, links: 0, drawn: true, appeared: true, glErrors: [] });
});
