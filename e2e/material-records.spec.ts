import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { runMainPassExactnessProof } from "../apps/editor/src/testing/main-pass-exactness-proof";
import { SOFTWARE_GL_ARGS } from "./software-gl";

// HAPTIC_RENDER_NATIVE_GPU=1 runs it on the machine's GPU outside CI: `--config playwright.perf.config.ts --project perf-gpu`.
// HAPTIC_MATERIAL_RECORDS_PROOF_OUT (an absolute path) also receives every image's digest per variant and mode.
const SOFTWARE_GL = process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || Boolean(process.env.CI);
if (SOFTWARE_GL) test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });

type Proof = typeof runMainPassExactnessProof;
type Run = Awaited<ReturnType<Proof>>;

async function run(page: Page, reference: boolean, parameters: boolean): Promise<Run> {
  const errors: string[] = [];
  const listener = (message: { type(): string; text(): string }) => {
    if (["warning", "error"].includes(message.type()) &&
      /shader|VALIDATE_STATUS|ERROR: 0:|INVALID_(?:ENUM|OPERATION|VALUE|FRAMEBUFFER_OPERATION)|uniform buffer|context lost|fatal error/i.test(message.text()))
      errors.push(message.text());
  };
  page.on("console", listener);
  page.on("pageerror", (error) => errors.push(error.message));
  // A page of its own per run: nothing compiled in one is reused by the other.
  await page.goto("/?test=1&mainPassExactnessProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __mainPassExactnessProof?: unknown }).__mainPassExactnessProof === "function");
  const result = await page.evaluate((value) => (window as unknown as { __mainPassExactnessProof: Proof }).__mainPassExactnessProof(value),
    { reference, parameters });
  page.off("console", listener);
  expect(errors, `${parameters ? "parameters" : "plain"}${reference ? " reference" : ""}`).toEqual([]);
  return result;
}

const sha = (bytes: number[]) => createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");
const digests = (images: Run["still"]) => ({ view: sha(images.view), fast: sha(images.captures.fast), highQuality: sha(images.captures.highQuality), atlas: images.atlas });

/**
 * Every Material-mode graph Material reads its parameters and hoisted literals from the per-Material `HapticMaterial`
 * uniform block (and environment lighting from `HapticEnvironment`). This verifies the parameterized Materials draw
 * cleanly with zero GL/UBO errors, bind their uniform buffers, and match the reference pass byte for byte.
 */
test("parameterised Materials reading the Material record match the reference pass byte for byte", async ({ page }) => {
  test.setTimeout(900_000);
  const current = await run(page, false, true);
  const reference = await run(page, true, true);
  const stages = Object.fromEntries((["still", "moved", "rewritten"] as const).map((stage) => [stage, { current: digests(current[stage]), reference: digests(reference[stage]) }]));
  const summary = {
    parameters: { renderer: current.renderer, stages, programs: { current: current.glFrame.calls.useProgram ?? 0, reference: reference.glFrame.calls.useProgram ?? 0 } },
  };
  console.log(`parameters on ${current.renderer}: ${JSON.stringify(stages)}`);
  for (const stage of ["still", "moved", "rewritten"] as const) {
    // Not blank: the view shows the lit scene.
    expect(new Set(current[stage].view).size, `parameters ${stage} view`).toBeGreaterThan(32);
    expect(stages[stage]!.current, `parameters ${stage}`).toEqual(stages[stage]!.reference);
  }
  // Uniform blocks (`HapticLights`, `HapticClusters`, `HapticEnvironment`, `HapticMaterial`) were bound.
  expect(current.glFrame.calls.bindBufferBase ?? 0).toBeGreaterThan(0);
  if (process.env.HAPTIC_MATERIAL_RECORDS_PROOF_OUT) writeFileSync(process.env.HAPTIC_MATERIAL_RECORDS_PROOF_OUT, JSON.stringify(summary));
});
