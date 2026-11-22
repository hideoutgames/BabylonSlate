import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { EffectsReadback, runEffectsComposeProof } from "../apps/editor/src/testing/effects-compose-proof";
import { SOFTWARE_GL_ARGS } from "./software-gl";

// HAPTIC_RENDER_NATIVE_GPU=1 runs it on the machine's GPU outside CI: `--config playwright.perf.config.ts --project perf-gpu`.
// HAPTIC_PAIRED_BLURS_PROOF_OUT (an absolute path) also receives every target's digest per mode.
const SOFTWARE_GL = process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || Boolean(process.env.CI);
if (SOFTWARE_GL) test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });

type Proof = typeof runEffectsComposeProof;
type Capture = Awaited<ReturnType<Proof>>;

async function run(page: Page, mergedMarches: boolean, pairedBlurs: boolean): Promise<Capture> {
  const errors: string[] = [];
  const listener = (message: { type(): string; text(): string }) => {
    if (["warning", "error"].includes(message.type()) &&
      /shader|VALIDATE_STATUS|ERROR: 0:|INVALID_(?:ENUM|OPERATION|VALUE|FRAMEBUFFER_OPERATION)|context lost|not linked|Unable to compile|missing fragment shader outputs|fatal error/i.test(message.text()))
      errors.push(message.text());
  };
  page.on("console", listener);
  page.on("pageerror", (error) => errors.push(error.message));
  // A page of its own per run: nothing compiled in one is reused by the other.
  await page.goto("/?test=1&effectsComposeProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __effectsComposeProof?: unknown }).__effectsComposeProof === "function");
  // `marches`: ambient occlusion, reflections, volumetric lighting and Screen-Space Shadows, every march running.
  const result = await page.evaluate(({ merged, paired }) =>
    (window as unknown as { __effectsComposeProof: Proof }).__effectsComposeProof("marches", false, merged, paired),
  { merged: mergedMarches, paired: pairedBlurs });
  page.off("console", listener);
  expect(errors, `${mergedMarches ? "merged" : "separate"} marches, ${pairedBlurs ? "paired" : "separate"} blurs`).toEqual([]);
  return result;
}

const BLURS = ["Scene Ambient Occlusion Blur X", "Scene Ambient Occlusion Blur Y", "Scene Reflections Blur X", "Scene Reflections Blur Y"];
const SEPARATE_TASKS = BLURS;
const PAIRED_TASKS = ["Paired blurs X", "Paired blurs Y"];

const digest = (readback: EffectsReadback | null | undefined) => readback
  ? { size: `${readback.width}x${readback.height}`, type: readback.type, sha256: createHash("sha256").update(Buffer.from(readback.data, "base64")).digest("hex") }
  : null;

/** Where two readbacks of one target differ: the differing bytes and the largest difference, for a failed proof's log. */
function difference(a: EffectsReadback | null | undefined, b: EffectsReadback | null | undefined) {
  if (!a || !b) return null;
  const left = Buffer.from(a.data, "base64"), right = Buffer.from(b.data, "base64");
  let bytes = 0, max = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const delta = Math.abs(left[index]! - right[index]!);
    if (delta) { bytes++; max = Math.max(max, delta); }
  }
  return { bytes, max, lengths: [left.length, right.length] };
}

/**
 * The paired blur passes are a temporary measurement switch (`worlddebug pairedblurs on`), off by default until a native
 * GPU proves them: this compares the default (each blur in its own pass) with each axis's two blurs in one pass, with
 * the half-resolution marches in their own passes and merged (`worlddebug mergedmarches on`).
 */
test("the ambient occlusion and reflection blurs drawn in one pass per axis write the bytes their own passes write", async ({ page }) => {
  test.setTimeout(900_000);
  const summary: Record<string, unknown> = {};
  for (const mergedMarches of [false, true]) {
    const mode = mergedMarches ? "merged marches" : "separate marches";
    const separate = await run(page, mergedMarches, false);
    const paired = await run(page, mergedMarches, true);
    // The default draws four blur passes; paired, two, and nothing else changes: two passes fewer.
    expect(separate.tasks, mode).toEqual(expect.arrayContaining(SEPARATE_TASKS));
    for (const name of PAIRED_TASKS) expect(separate.tasks, mode).not.toContain(name);
    expect(paired.tasks, mode).toEqual(expect.arrayContaining(PAIRED_TASKS));
    for (const name of SEPARATE_TASKS) expect(paired.tasks, mode).not.toContain(name);
    expect(paired.tasks, mode).toHaveLength(separate.tasks.length - 2);
    expect(paired.passes, `${mode} passes`).toBe(separate.passes - 2);
    const targets: Record<string, [EffectsReadback | null | undefined, EffectsReadback | null | undefined]> = {
      frame: [paired.frame, separate.frame],
      composed: [paired.composed, separate.composed],
      ...Object.fromEntries(BLURS.map((name) => [name, [paired.blurs[name], separate.blurs[name]]])),
    };
    const digests = Object.fromEntries(Object.entries(targets).map(([name, [a, b]]) => [name, { paired: digest(a), separate: digest(b) }]));
    const differences = Object.fromEntries(Object.entries(targets)
      .filter(([name]) => JSON.stringify(digests[name]!.paired) !== JSON.stringify(digests[name]!.separate))
      .map(([name, [a, b]]) => [name, difference(a, b)]));
    summary[mode] = { renderer: paired.renderer, passes: { paired: paired.passes, separate: separate.passes }, digests, differences };
    console.log(`${mode} on ${paired.renderer}: ${paired.passes} passes paired, ${separate.passes} separate; ${JSON.stringify(digests)}; differences ${JSON.stringify(differences)}`);
    for (const name of Object.keys(targets)) {
      // Every target was read back, and is the same bytes either way.
      expect(digests[name]!.paired, `${mode} ${name}`).not.toBeNull();
      expect(digests[name]!.paired, `${mode} ${name}`).toEqual(digests[name]!.separate);
    }
    // Not blank: the frame shows the lit scene, and the reflection blur holds reflections.
    const colours = (readback: EffectsReadback) => {
      const bytes = Buffer.from(readback.data, "base64"), seen = new Set<string>();
      const stride = readback.type === "u8" ? 4 : readback.type === "u16" ? 8 : 16;
      for (let index = 0; index < bytes.length; index += stride) seen.add(bytes.subarray(index, index + stride).toString("hex"));
      return seen.size;
    };
    expect(colours(paired.frame), `${mode} frame`).toBeGreaterThan(16);
    expect(colours(paired.blurs["Scene Reflections Blur Y"]!), `${mode} reflection blur`).toBeGreaterThan(16);
  }
  if (process.env.HAPTIC_PAIRED_BLURS_PROOF_OUT) writeFileSync(process.env.HAPTIC_PAIRED_BLURS_PROOF_OUT, JSON.stringify(summary, null, 2));
});
