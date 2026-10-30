import { expect, test } from "@playwright/test";
import type { runVariantSwapProof } from "../apps/editor/src/testing/variant-swap-proof";

test("a world view keeps drawing while new variants compile, without a GL error", async ({ page }, testInfo) => {
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
  // Fog switches on: each of the three Materials drew its previous Effect in every steady frame while its fogged
  // variant was held back (the frame as before the change, float rounding only), with no GL error, then drew the new
  // variant once released, and the fog shows.
  const fog = result.fog;
  expect({
    drawn: fog.drawn, held: fog.held, previous: fog.previous, unchangedWhileHeld: fog.heldDifference <= 2, adopted: fog.adopted,
    fogged: fog.fogged > 400, glErrors: fog.glErrors,
  }, JSON.stringify(fog)).toEqual({ drawn: 3, held: 0, previous: 3, unchangedWhileHeld: true, adopted: 3, fogged: true, glErrors: [] });
  // A light starts casting shadows: no receiver asked for a variant (the light block reads every shadow from its
  // records and the atlas), the new map stayed neutral while its casters' depth variants were held back, and once they
  // linked it drew and the boxes' shadows darkened the floors. Unlike the legacy path, whose receivers drew their
  // previous Effects meanwhile, a world view holds its frames until those casters link (Play compiles them during its
  // load, `ShadowCasterVariants`); `held` and `heldBecause` record it.
  expect(result.shadowGains.map((gain) => gain.name)).toEqual(["a spot starts casting shadows", "a point light starts casting shadows"]);
  for (const gain of result.shadowGains) {
    expect({
      casters: gain.casters > 0, neutralWhileHeld: gain.neutralWhileHeld, unchangedWhileHeld: gain.heldDifference <= 2,
      mapDrawn: gain.mapDrawn, receiversKept: gain.receiversKept, shadowed: gain.shadowPixels > 8, glErrors: gain.glErrors,
    }, JSON.stringify(gain)).toEqual({
      casters: true, neutralWhileHeld: true, unchangedWhileHeld: true, mapDrawn: true, receiversKept: true, shadowed: true, glErrors: [],
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
