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

async function run(page: Page, materialRecords: boolean, parameters: boolean): Promise<Run> {
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
    { reference: false, materialRecords, parameters });
  page.off("console", listener);
  expect(errors, `${parameters ? "parameters" : "plain"}${materialRecords ? " records" : ""}`).toEqual([]);
  return result;
}

const sha = (bytes: number[]) => createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");
const digests = (images: Run["still"]) => ({ view: sha(images.view), fast: sha(images.captures.fast), highQuality: sha(images.captures.highQuality), atlas: images.atlas });

/**
 * The Material record (`worlddebug materialrecords on`: parameters and hoisted literals read from a per-Material uniform
 * block, the Material Output's literals among them) is an opt-in until a native GPU proves it: this draws the main-pass
 * exactness scene with it off (the default) and on, with the scene's own Materials (their Output literals hoisted) and
 * with a Color and a Float parameter each times a literal, and compares the view, both captures and the shadow atlas
 * byte for byte, still, after the casters moved and after notified geometry writes.
 */
test("Materials reading the Material record draw the bytes their uniforms and literals draw", async ({ page }) => {
  test.setTimeout(900_000);
  const summary: Record<string, unknown> = {};
  for (const parameters of [false, true]) {
    const variant = parameters ? "parameters" : "plain";
    const off = await run(page, false, parameters);
    const on = await run(page, true, parameters);
    const stages = Object.fromEntries((["still", "moved", "rewritten"] as const).map((stage) => [stage, { off: digests(off[stage]), on: digests(on[stage]) }]));
    summary[variant] = { renderer: on.renderer, stages, programs: { off: off.glFrame.calls.useProgram ?? 0, on: on.glFrame.calls.useProgram ?? 0 } };
    console.log(`${variant} on ${on.renderer}: ${JSON.stringify(stages)}`);
    for (const stage of ["still", "moved", "rewritten"] as const) {
      // Not blank: the view shows the lit scene.
      expect(new Set(on[stage].view).size, `${variant} ${stage} view`).toBeGreaterThan(32);
      expect(stages[stage]!.on, `${variant} ${stage}`).toEqual(stages[stage]!.off);
    }
    // The record path ran: the still frame binds the records, which the default path never does.
    expect(on.glFrame.calls.bindBufferBase ?? 0, variant).toBeGreaterThan(off.glFrame.calls.bindBufferBase ?? 0);
  }
  if (process.env.HAPTIC_MATERIAL_RECORDS_PROOF_OUT) writeFileSync(process.env.HAPTIC_MATERIAL_RECORDS_PROOF_OUT, JSON.stringify(summary));
});
