import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { runShadowAtlasProof } from "../apps/editor/src/testing/shadow-atlas-proof";
import { SOFTWARE_GL_ARGS } from "./software-gl";

// HAPTIC_RENDER_NATIVE_GPU=1 runs it on the machine's GPU outside CI: `--config playwright.perf.config.ts --project perf-gpu`.
// HAPTIC_SHADOW_ATLAS_PROOF_OUT (an absolute path) also receives the captured frames, to compare two builds byte for byte.
const SOFTWARE_GL = process.env.HAPTIC_RENDER_NATIVE_GPU !== "1" || Boolean(process.env.CI);
if (SOFTWARE_GL) test.use({ launchOptions: { args: SOFTWARE_GL_ARGS } });

type Proof = typeof runShadowAtlasProof;

test("the shadow atlas's pages draw and sample every shadowed light's map, filtered with PCF and Contact Hardening", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()) && /shader|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error|GL_INVALID/i.test(message.text()))
      errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?test=1&shadowAtlasProof=1");
  await page.waitForFunction(() => typeof (window as unknown as { __shadowAtlasProof?: unknown }).__shadowAtlasProof === "function");
  const { captures, sampling, renderer } = await page.evaluate(() => (window as unknown as { __shadowAtlasProof: Proof }).__shadowAtlasProof());
  const hashes = captures.map(({ filter, frame }) => ({ filter, sha256: createHash("sha256").update(Uint8Array.from(frame)).digest("hex") }));
  const summary = { renderer, sampling, hashes, maps: captures[0]!.maps, cascadeEnds: captures[0]!.cascadeEnds };
  await testInfo.attach("shadow-atlas-proof", { body: JSON.stringify(summary), contentType: "application/json" });
  console.log(`shadow atlas proof ${JSON.stringify(summary)}`);
  if (process.env.HAPTIC_SHADOW_ATLAS_PROOF_OUT) writeFileSync(process.env.HAPTIC_SHADOW_ATLAS_PROOF_OUT, JSON.stringify({ renderer, sampling, captures }));
  expect(errors).toEqual([]);
  for (const capture of captures) {
    // The sun's four cascades, the spot light's tile and the point light's six faces.
    expect(capture.maps.map(({ tiles }) => tiles.length), capture.filter).toEqual([4, 1, 6]);
    expect(capture.cascadeEnds.filter((end) => end > 0), capture.filter).toHaveLength(4);
    expect(new Set(capture.frame).size, `${capture.filter} frame`).toBeGreaterThan(16);
  }
  // Contact Hardening reads the pages plainly as well: its penumbrae differ from PCF's.
  expect(hashes[0]!.sha256).not.toBe(hashes[1]!.sha256);
});
