import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { EffectsComposeVariant, runEffectsComposeProof } from "../apps/editor/src/testing/effects-compose-proof";
import { SOFTWARE_GL_ARGS } from "./software-gl";

// HAPTIC_RENDER_NATIVE_GPU=1 runs it on the machine's GPU outside CI: `--config playwright.perf.config.ts --project perf-gpu`.
// HAPTIC_MERGED_MARCHES_PROOF_OUT (an absolute path) also receives every target's digest per variant and mode.
const SOFTWARE_GL = process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || Boolean(process.env.CI);
if (SOFTWARE_GL) test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });
const LARGE_WORLD = process.env.HAPTIC_LARGE_WORLD === "1";

type Proof = typeof runEffectsComposeProof;
type Capture = Awaited<ReturnType<Proof>>;

async function run(page: Page, variant: EffectsComposeVariant, mergedMarches: boolean): Promise<Capture> {
  const errors: string[] = [];
  const listener = (message: { type(): string; text(): string }) => {
    if (["warning", "error"].includes(message.type()) &&
      /shader|VALIDATE_STATUS|ERROR: 0:|INVALID_(?:ENUM|OPERATION|VALUE|FRAMEBUFFER_OPERATION)|context lost|fatal error/i.test(message.text()))
      errors.push(message.text());
  };
  page.on("console", listener);
  page.on("pageerror", (error) => errors.push(error.message));
  // A page of its own per run: nothing compiled in one is reused by the other.
  await page.goto("/?test=1&effectsComposeProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __effectsComposeProof?: unknown }).__effectsComposeProof === "function");
  const result = await page.evaluate(({ name, largeWorld, merged }) =>
    (window as unknown as { __effectsComposeProof: Proof }).__effectsComposeProof(name, largeWorld, merged),
  { name: variant, largeWorld: LARGE_WORLD, merged: mergedMarches });
  page.off("console", listener);
  expect(errors, `${variant}${mergedMarches ? " merged" : ""}`).toEqual([]);
  return result;
}

type Target = "frame" | "composed" | "screenShadows" | "occlusion" | "fog";

/**
 * Per variant, the targets a reader samples that frame: an idle march's target is read by no one (the objects bind the
 * placeholder for idle screen shadows; the compose leaves an idle fog out), and it holds the merged pass's clear where
 * its own pass would have left it untouched.
 */
const VARIANTS: { variant: EffectsComposeVariant; read: Target[] }[] = [
  { variant: "marches", read: ["frame", "composed", "screenShadows", "occlusion", "fog"] },
  { variant: "marches-fog-idle", read: ["frame", "composed", "screenShadows", "occlusion"] },
  { variant: "marches-sun-unshadowed", read: ["frame", "composed", "occlusion", "fog"] },
];

const MERGED = "Half-resolution marches";

/**
 * The merged march pass is an opt-in (`worlddebug mergedmarches on`) until a native GPU proves it: the default graph
 * draws each march in its own pass, and this compares that default with the merged pass.
 */
test("the ambient occlusion and volumetric marches drawn in the Screen-Space Shadows pass write the bytes their own passes write", async ({ page }) => {
  test.setTimeout(900_000);
  const summary: Record<string, unknown> = {};
  for (const { variant, read } of VARIANTS) {
    const separate = await run(page, variant, false);
    const merged = await run(page, variant, true);
    // The default (separate) run draws the three marches in three passes; the merged run in one before the objects.
    expect(merged.tasks, variant).toContain(MERGED);
    expect(merged.tasks.filter((name) => ["Screen shadows", "Scene Ambient Occlusion", "Scene Volumetric Lighting"].includes(name)), variant).toEqual([]);
    expect(separate.tasks, variant).not.toContain(MERGED);
    expect(separate.tasks, variant).toEqual(expect.arrayContaining(["Screen shadows", "Scene Ambient Occlusion", "Scene Volumetric Lighting"]));
    expect(merged.passes, `${variant} passes`).toBeLessThan(separate.passes);
    const sha = (target: Target, capture: Capture) => {
      const readback = capture[target];
      if (!readback) return null;
      return { size: `${readback.width}x${readback.height}`, type: readback.type, sha256: createHash("sha256").update(Buffer.from(readback.data, "base64")).digest("hex") };
    };
    const digests = Object.fromEntries(read.map((target) => [target, { merged: sha(target, merged), separate: sha(target, separate) }]));
    summary[variant] = { passes: { merged: merged.passes, separate: separate.passes }, digests };
    console.log(`${variant} on ${merged.renderer}: ${merged.passes} passes merged, ${separate.passes} separate; ${JSON.stringify(digests)}`);
    for (const target of read) {
      // Every target a reader samples was read back, and is the same bytes either way.
      expect(digests[target]!.merged, `${variant} ${target}`).not.toBeNull();
      expect(digests[target]!.merged, `${variant} ${target}`).toEqual(digests[target]!.separate);
    }
    // Not blank: the frame shows the lit scene.
    const frame = Buffer.from(merged.frame.data, "base64");
    const colours = new Set<number>();
    for (let index = 0; index < frame.length; index += 4) colours.add(frame.readUInt32LE(index));
    expect(colours.size, `${variant} frame`).toBeGreaterThan(16);
  }
  if (process.env.HAPTIC_MERGED_MARCHES_PROOF_OUT) writeFileSync(process.env.HAPTIC_MERGED_MARCHES_PROOF_OUT, JSON.stringify(summary, null, 2));
});
