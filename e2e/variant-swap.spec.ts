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
  // A load that rehearsed its lights' changes and the light its Classes may spawn (each drawn once behind the loading
  // screen) links no program when a point switches off, a shadowed point spawns near the camera (until its map has
  // drawn) or a spot starts casting shadows, and never holds.
  const rehearsed = result.rehearsed;
  const change = (step: { links: number; held: number; changed: boolean }) => ({ links: step.links, held: step.held, changed: step.changed });
  expect({
    rehearsed: rehearsed.report.steps > 0 && rehearsed.report.timedOut.length === 0, compiled: rehearsed.report.variants > 0,
    pointOff: change(rehearsed.pointOff), spawned: change(rehearsed.spawned), spotShadows: change(rehearsed.spotShadows),
    glErrors: rehearsed.glErrors,
  }, JSON.stringify(rehearsed)).toEqual({
    rehearsed: true, compiled: true,
    pointOff: { links: 0, held: 0, changed: true }, spawned: { links: 0, held: 0, changed: true },
    spotShadows: { links: 0, held: 0, changed: true }, glErrors: [],
  });
  // A light that waits within reach of an admission has the variants it asks for compiled ahead: a spot entering the
  // Forward budget, one taking a point's shadow map and one taking the first spot map (its variants from a prediction
  // map) link no program when admitted. The four Materials' first draws
  // still spread two per frame (FIRST_DRAWS_PER_FRAME), as when the same admissions jump straight in, which link their
  // programs then.
  const predicted = result.predicted;
  const outcome = (admission: (typeof predicted)["forward"]["approached"]) => ({
    admitted: admission.admitted, links: admission.linksAtAdmission, late: admission.lateFrames, held: admission.held,
    glErrors: admission.glErrors,
  });
  const late = { forward: predicted.forward.jumped.lateFrames, shadow: predicted.shadow.jumped.lateFrames };
  expect({
    forward: outcome(predicted.forward.approached), shadow: outcome(predicted.shadow.approached),
    first: outcome(predicted.first.approached),
    aheadForward: predicted.forward.approached.linksAhead > 0, aheadShadow: predicted.shadow.approached.linksAhead > 0,
    jumpedForward: predicted.forward.jumped.admitted && predicted.forward.jumped.linksAtAdmission > 0 && late.forward === 1,
    jumpedShadow: predicted.shadow.jumped.admitted && predicted.shadow.jumped.linksAtAdmission > 0 && late.shadow === 1,
    aheadFirst: predicted.first.approached.linksAhead > 0,
    jumpedFirst: predicted.first.jumped.admitted && predicted.first.jumped.linksAtAdmission > 0,
  }, JSON.stringify(predicted)).toEqual({
    forward: { admitted: true, links: 0, late: 1, held: 0, glErrors: [] },
    shadow: { admitted: true, links: 0, late: 1, held: 0, glErrors: [] },
    first: { admitted: true, links: 0, late: 1, held: 0, glErrors: [] },
    aheadForward: true, aheadShadow: true, jumpedForward: true, jumpedShadow: true, aheadFirst: true, jumpedFirst: true,
  });
});
