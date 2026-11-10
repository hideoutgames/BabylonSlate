import { expect, test } from "@playwright/test";
import type { runRetainedShadowProof } from "../apps/editor/src/testing/retained-shadow-proof";

type Proof = typeof runRetainedShadowProof;

test("shadow maps drawn from the shared caster buffer match Babylon's own draws pixel for pixel, in far fewer calls", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|retained|VALIDATE_STATUS|GL_INVALID|INVALID_|ERROR: 0:|context lost|fatal error/i.test(message.text())) errors.push(message.text());
  });
  await page.goto("/?test=1&retainedShadowProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __retainedShadowProof?: unknown }).__retainedShadowProof === "function");
  const result = await page.evaluate(() => (window as unknown as { __retainedShadowProof: Proof }).__retainedShadowProof());
  await testInfo.attach("retained-shadow-proof", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(errors).toEqual([]);
  // Five stages: the settled scene; a caster moved; casters added, removed, hidden, mirrored and stretched; the hidden
  // one shown and another faded (Babylon draws it); the faded one back in the shared buffer and a caster moved. Each
  // differs from the one before it.
  expect(result.compared).toHaveLength(5);
  expect(result.changed).toEqual([true, true, true, true]);
  for (const image of result.compared) {
    // The scene does cast shadows: a blank or unshadowed pair would match too.
    expect(image.dark).toBeGreaterThan(500);
    expect(image).toMatchObject({ differing: 0, largest: 0 });
  }
  // Every caster of the scene is rigid and opaque, the two instances too: at the end all ten are retained (nine, two
  // arrivals, one gone), and none in the run that turns it off.
  expect(result.retained.casters).toMatchObject({ casters: 10, draws: 10 });
  // The arrivals outgrew the buffers' first room, so the images after them were drawn from rebuilt buffers.
  expect(result.retained.casters!.vertices).toBeGreaterThan(4096);
  expect(result.retained.casters!.drawn).toBeGreaterThan(result.retained.casters!.calls);
  expect(result.drawnByBabylon.casters).toMatchObject({ casters: 0, calls: 0 });
  // The frames after the first stage redraw the maps their changes reach: a call per map layer and cull state against
  // a draw per caster and layer.
  expect(result.retained.mapDraws).toBeGreaterThan(0);
  expect(result.retained.mapDraws * 2).toBeLessThan(result.drawnByBabylon.mapDraws);
});
