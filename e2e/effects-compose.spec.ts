import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { EffectsComposeVariant, runEffectsComposeProof } from "../apps/editor/src/testing/effects-compose-proof";
import { SOFTWARE_GL_ARGS } from "./software-gl";

// HAPTIC_RENDER_NATIVE_GPU=1 runs it on the machine's GPU outside CI: `--config playwright.perf.config.ts --project perf-gpu`.
// HAPTIC_EFFECTS_PROOF_OUT (an absolute folder) keeps each variant's frame as `<HAPTIC_EFFECTS_PROOF_LABEL>-<variant>.png`
// and its raw readbacks beside it, so two builds' frames can be compared.
const SOFTWARE_GL = process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || Boolean(process.env.CI);
if (SOFTWARE_GL) test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });
// HAPTIC_LARGE_WORLD=1 builds the proof's Engine with Large World Rendering (Babylon's floating origin) on.
const LARGE_WORLD = process.env.HAPTIC_LARGE_WORLD === "1";

type Proof = typeof runEffectsComposeProof;
const VARIANTS: EffectsComposeVariant[] = ["ao", "fog", "reflections", "ao-fog", "all", "screen-shadows"];
const OLD_COMPOSES = ["Scene Ambient Occlusion Compose", "Scene Reflections Compose", "Scene Volumetric Compose"];

async function run(page: Page, variant: EffectsComposeVariant) {
  const errors: string[] = [];
  const listener = (message: { type(): string; text(): string }) => {
    if (["warning", "error"].includes(message.type()) && /shader|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error/i.test(message.text()))
      errors.push(message.text());
  };
  page.on("console", listener);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?test=1&effectsComposeProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __effectsComposeProof?: unknown }).__effectsComposeProof === "function");
  const result = await page.evaluate(({ name, largeWorld }) => (window as unknown as { __effectsComposeProof: Proof }).__effectsComposeProof(name, largeWorld), { name: variant, largeWorld: LARGE_WORLD });
  page.off("console", listener);
  return { result, errors };
}

function keep(capture: Awaited<ReturnType<Proof>>) {
  const out = process.env.HAPTIC_EFFECTS_PROOF_OUT;
  if (!out) return;
  const label = process.env.HAPTIC_EFFECTS_PROOF_LABEL ?? "run";
  mkdirSync(out, { recursive: true });
  const base = join(out, `${label}-${capture.variant}`);
  writeFileSync(`${base}.png`, Buffer.from(capture.png.slice(capture.png.indexOf(",") + 1), "base64"));
  for (const key of ["frame", "composed", "reflectivity", "screenShadows"] as const) {
    const readback = capture[key];
    if (readback) writeFileSync(`${base}.${key}.${readback.width}x${readback.height}.${readback.type}.bin`, Buffer.from(readback.data, "base64"));
  }
  const { variant, renderer, passes, texelsCovered, passList, tasks } = capture;
  writeFileSync(`${base}.json`, JSON.stringify({ variant, renderer, passes, texelsCovered, passList, tasks }, null, 2));
}

test("composes ambient occlusion, reflections and volumetric lighting in one pass, and marches Screen-Space Shadows at half resolution",async ({ page }) => {
  test.setTimeout(600_000);
  for (const variant of VARIANTS) {
    const { result, errors } = await run(page, variant);
    keep(result);
    console.log(`${variant} on ${result.renderer}: ${result.passes} passes, ${result.texelsCovered} texels covered`);
    expect.soft(errors, variant).toEqual([]);
    const frame = Buffer.from(result.frame.data, "base64");
    const colours = new Set<number>();
    for (let index = 0; index < frame.length; index += 4) colours.add(frame.readUInt32LE(index));
    expect.soft(colours.size, `${variant} frame`).toBeGreaterThan(16);
    // One full-resolution compose takes every enabled screen-space effect.
    const composes = result.tasks.filter((name) => name === "Scene Effects Compose").length;
    expect.soft(composes, `${variant} composes`).toBe(variant === "screen-shadows" ? 0 : 1);
    expect.soft(result.tasks.filter((name) => OLD_COMPOSES.includes(name)), variant).toEqual([]);
    // Screen-Space Shadows march at half the 944 x 630 render size.
    if (variant === "screen-shadows")
      expect.soft([result.screenShadows?.width, result.screenShadows?.height], "half-resolution screen shadows").toEqual([472, 315]);
  }
});
