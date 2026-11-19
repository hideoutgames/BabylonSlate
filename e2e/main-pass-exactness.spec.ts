import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { runMainPassExactnessProof } from "../apps/editor/src/testing/main-pass-exactness-proof";
import { SOFTWARE_GL_ARGS } from "./software-gl";

// HAPTIC_RENDER_NATIVE_GPU=1 runs it on the machine's GPU outside CI: `--config playwright.perf.config.ts --project perf-gpu`.
const SOFTWARE_GL = process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || Boolean(process.env.CI);
if (SOFTWARE_GL) test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });
// HAPTIC_LARGE_WORLD=1 builds the proof's Engine with Large World Rendering (Babylon's floating origin) on.
// HAPTIC_MAIN_PASS_PROOF_OUT (an absolute path) also receives the digests of every image and atlas page, to compare two
// builds byte for byte.
const LARGE_WORLD = process.env.HAPTIC_LARGE_WORLD === "1";

type Proof = typeof runMainPassExactnessProof;

async function run(page: Page, reference: boolean) {
  const errors: string[] = [];
  const listener = (message: { type(): string; text(): string }) => {
    if (["warning", "error"].includes(message.type()) && /shader|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
      errors.push(message.text());
  };
  page.on("console", listener);
  page.on("pageerror", (error) => errors.push(error.message));
  // A page of its own per run: nothing compiled in one is reused by the other.
  await page.goto("/?test=1&mainPassExactnessProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __mainPassExactnessProof?: unknown }).__mainPassExactnessProof === "function");
  const result = await page.evaluate((value) => (window as unknown as { __mainPassExactnessProof: Proof }).__mainPassExactnessProof({ reference: value.reference, largeWorld: value.largeWorld }), { reference, largeWorld: LARGE_WORLD });
  page.off("console", listener);
  expect(errors).toEqual([]);
  return result;
}

/** Indices where two readbacks differ, and the first few of them. */
function differences(a: number[], b: number[]) {
  const at: number[] = [];
  for (let index = 0; index < Math.max(a.length, b.length); index++) if (!Object.is(a[index], b[index])) at.push(index);
  return { count: at.length, first: at.slice(0, 8) };
}

test("the main pass's and the captures' GPU savings change no pixel", async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const current = await run(page, false);
  const reference = await run(page, true);
  const sha = (bytes: number[]) => createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");
  const digest = ({ view, captures, atlas }: typeof current.still) =>
    ({ view: sha(view), fast: sha(captures.fast), highQuality: sha(captures.highQuality), atlas });
  const summary = {
    renderer: current.renderer, stillTexelsPerFrame: { current: current.stillTexelsPerFrame, reference: reference.stillTexelsPerFrame },
    movedCounters: { current: current.movedCounters, reference: reference.movedCounters },
    current: { still: digest(current.still), moved: digest(current.moved) }, reference: { still: digest(reference.still), moved: digest(reference.moved) },
  };
  await testInfo.attach("main-pass-exactness", { body: JSON.stringify(summary), contentType: "application/json" });
  if (process.env.HAPTIC_MAIN_PASS_PROOF_OUT) writeFileSync(process.env.HAPTIC_MAIN_PASS_PROOF_OUT, JSON.stringify(summary));
  console.log(`main pass exactness proof on ${current.renderer}: shadow texels per still frame ${current.stillTexelsPerFrame} (reference ${reference.stillTexelsPerFrame})`);
  // The reference redraws the High Quality capture's own sun map in every still frame; the savings draw none.
  expect(reference.stillTexelsPerFrame).toBeGreaterThan(0);
  expect(current.stillTexelsPerFrame).toBe(0);
  // The moved frames took the shadow stage's lean path: tiles of one page share a bind (the point light's faces), the
  // retained casters drew as instances of fewer draws, and every row they read was uploaded before the first map.
  for (const counters of [current.movedCounters, reference.movedCounters]) {
    expect(counters.passes).toBeGreaterThan(0);
    expect(counters.passes).toBeLessThan(counters.tiles);
    expect(counters.retainedDraws).toBeGreaterThan(0);
    expect(counters.casterDraws).toBeGreaterThanOrEqual(counters.retainedDraws);
    expect(counters.lateUploads).toBe(0);
  }
  for (const stage of ["still", "moved"] as const) {
    const images = current[stage];
    const before = reference[stage];
    // Not blank: the view and each capture show the lit scene.
    expect(new Set(images.view).size, `${stage} view`).toBeGreaterThan(32);
    expect(differences(images.view, before.view), `${stage} view`).toEqual({ count: 0, first: [] });
    for (const quality of ["fast", "highQuality"] as const) {
      expect(new Set(images.captures[quality]).size, `${stage} ${quality}`).toBeGreaterThan(16);
      expect(differences(images.captures[quality], before.captures[quality]), `${stage} ${quality}`).toEqual({ count: 0, first: [] });
    }
    // The shadow maps themselves, every texel's depth bits: a frame can hide a difference in them. Some pages hold depth.
    expect(images.atlas.some((page) => page.written > 0), `${stage} atlas`).toBe(true);
    expect(images.atlas, `${stage} atlas`).toEqual(before.atlas);
  }
});
