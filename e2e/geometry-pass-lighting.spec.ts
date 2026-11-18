import { expect, test, type Page } from "@playwright/test";
import type { runGeometryPassLightingProof } from "../apps/editor/src/testing/geometry-pass-lighting-proof";
import { SOFTWARE_GL_ARGS } from "./software-gl";

// HAPTIC_RENDER_NATIVE_GPU=1 runs it on the machine's GPU outside CI: `--config playwright.perf.config.ts --project perf-gpu`.
const SOFTWARE_GL = process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || Boolean(process.env.CI);
if (SOFTWARE_GL) test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });
// HAPTIC_LARGE_WORLD=1 builds the proof's Engine with Large World Rendering (Babylon's floating origin) on.
const LARGE_WORLD = process.env.HAPTIC_LARGE_WORLD === "1";

type Proof = typeof runGeometryPassLightingProof;

async function run(page: Page, keepGeometryLighting: boolean) {
  const errors: string[] = [];
  const listener = (message: { type(): string; text(): string }) => {
    if (["warning", "error"].includes(message.type()) && /shader|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
      errors.push(message.text());
  };
  page.on("console", listener);
  page.on("pageerror", (error) => errors.push(error.message));
  // A page of its own per run: nothing compiled in one is reused by the other.
  await page.goto("/?test=1&geometryPassLightingProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __geometryPassLightingProof?: unknown }).__geometryPassLightingProof === "function");
  const result = await page.evaluate((keep) => (window as unknown as { __geometryPassLightingProof: Proof }).__geometryPassLightingProof({ keepGeometryLighting: keep.keep, largeWorld: keep.largeWorld }), { keep: keepGeometryLighting, largeWorld: LARGE_WORLD });
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

test("the spatial geometry pass compiles no lighting and changes no pixel for it", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { captures: without, renderer } = await run(page, false);
  const { captures: kept } = await run(page, true);
  await testInfo.attach("geometry-pass-lighting", {
    body: JSON.stringify({ renderer, captures: without.map(({ mode, programs, tasks }) => ({ mode, programs, tasks })) }),
    contentType: "application/json",
  });
  console.log(`geometry pass lighting proof on ${renderer}`);
  for (const [index, capture] of without.entries()) {
    const reference = kept[index]!;
    // The guard holds where it should: lighting in every colour pass program, none in the geometry pass's, and
    // the reference build keeps it in both.
    for (const program of capture.programs) expect(program, `${capture.mode} ${program.name}`).toMatchObject({ geometryLit: false, colourLit: true });
    for (const program of reference.programs) expect(program, `${capture.mode} ${program.name} kept`).toMatchObject({ geometryLit: true, colourLit: true });
    // The geometry pass drew something of every attachment, and the frame is not blank.
    expect(capture.depth.values.some((value, at) => at % 4 === 0 && value > 0 && value < 60), `${capture.mode} depth`).toBe(true);
    expect(new Set(capture.frame).size, `${capture.mode} frame`).toBeGreaterThan(16);
    for (const key of ["depth", "normal", "reflectivity"] as const)
      expect(differences(capture[key].values, reference[key].values), `${capture.mode} ${key}`).toEqual({ count: 0, first: [] });
    expect(differences(capture.frame, reference.frame), `${capture.mode} frame`).toEqual({ count: 0, first: [] });
  }
});
