import { expect, test } from "@playwright/test";
import type { runWorldSpriteBatchingProof } from "../apps/editor/src/testing/world-sprite-batching-proof";
import { encodeRgbaPng } from "../packages/render/src/png-encode";
import { SOFTWARE_GL_ARGS } from "./software-gl";

test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });

type Proof = typeof runWorldSpriteBatchingProof;

/** Pixels whose channels differ at all, and the first few of them. */
function differences(a: number[], b: number[], width: number) {
  const first: string[] = [];
  let count = 0;
  for (let pixel = 0; pixel < a.length / 4; pixel += 1) {
    let same = true;
    for (let channel = 0; channel < 4; channel += 1) if (a[pixel * 4 + channel] !== b[pixel * 4 + channel]) same = false;
    if (same) continue;
    count += 1;
    if (first.length < 8) first.push(`(${pixel % width}, ${Math.floor(pixel / width)}): ${a.slice(pixel * 4, pixel * 4 + 4)} vs ${b.slice(pixel * 4, pixel * 4 + 4)}`);
  }
  return { count, first };
}

test("batched Play world sprites draw the same image as each sprite drawn alone, in fewer draws", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type()) &&
      /shader|VALIDATE_STATUS|GL_INVALID|ERROR: 0:|context lost|fatal error/i.test(message.text()))
      errors.push(message.text());
  });
  await page.goto("/?test=1&worldSpriteBatchingProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __worldSpriteBatchingProof?: unknown }).__worldSpriteBatchingProof === "function");
  const run = (batching: boolean) => page.evaluate((batching) =>
    (window as unknown as { __worldSpriteBatchingProof: Proof }).__worldSpriteBatchingProof(batching), batching);
  const batched = await run(true);
  const unbatched = await run(false);
  const report = (["still", "moved"] as const).map((name) => ({
    name,
    draws: { batched: batched[name].draws, unbatched: unbatched[name].draws },
    batches: { batches: batched[name].batches, sprites: batched[name].batched, unbatched: unbatched[name].batches },
    differences: differences(unbatched[name].pixels, batched[name].pixels, batched.width),
  }));
  await testInfo.attach("world-sprite-batching", { body: JSON.stringify({ renderer: batched.renderer, report }, null, 2), contentType: "application/json" });
  for (const name of ["still", "moved"] as const) {
    for (const [label, result] of [["batched", batched], ["unbatched", unbatched]] as const) {
      await testInfo.attach(`${name}-${label}.png`, {
        body: Buffer.from(encodeRgbaPng(result.width, result.height, new Uint8Array(result[name].pixels))), contentType: "image/png",
      });
    }
  }
  expect(errors).toEqual([]);
  for (const entry of report) {
    // Exactly the same image, every channel of every pixel.
    expect(entry.differences, entry.name).toEqual({ count: 0, first: [] });
    // Batching drew: sprites through batches (the caster on its own), in fewer draws; off, none.
    expect(entry.batches.sprites, entry.name).toBeGreaterThan(5);
    expect(entry.batches.unbatched, entry.name).toBe(0);
    expect(entry.draws.batched, entry.name).toBeLessThan(entry.draws.unbatched);
  }
  // The sprites drew: the frame is not the clear colour alone.
  const clear = batched.still.pixels.slice(0, 4);
  expect(batched.still.pixels.filter((_, index) => index % 4 === 0 && Math.abs(batched.still.pixels[index]! - clear[0]!) > 20).length)
    .toBeGreaterThan(batched.width * batched.height / 50);
});
