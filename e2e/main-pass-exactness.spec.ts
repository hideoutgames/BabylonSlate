import { expect, test, type Page } from "@playwright/test";
import type { runMainPassExactnessProof } from "../apps/editor/src/testing/main-pass-exactness-proof";
import { SOFTWARE_GL_ARGS } from "./software-gl";

// HAPTIC_RENDER_NATIVE_GPU=1 runs it on the machine's GPU outside CI: `--config playwright.perf.config.ts --project perf-gpu`.
const SOFTWARE_GL = process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || Boolean(process.env.CI);
if (SOFTWARE_GL) test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });
// HAPTIC_LARGE_WORLD=1 builds the proof's Engine with Large World Rendering (Babylon's floating origin) on.
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
  await testInfo.attach("main-pass-exactness", {
    body: JSON.stringify({ renderer: current.renderer, stillTexelsPerFrame: { current: current.stillTexelsPerFrame, reference: reference.stillTexelsPerFrame } }),
    contentType: "application/json",
  });
  console.log(`main pass exactness proof on ${current.renderer}: shadow texels per still frame ${current.stillTexelsPerFrame} (reference ${reference.stillTexelsPerFrame})`);
  // The reference redraws the High Quality capture's own sun map in every still frame; the savings draw none.
  expect(reference.stillTexelsPerFrame).toBeGreaterThan(0);
  expect(current.stillTexelsPerFrame).toBe(0);
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
  }
});
