import { expect, test } from "@playwright/test";
import type { runColorGradingProof, runDisplayColorProof } from "../apps/editor/src/testing/color-grading-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

/** Mean absolute channel difference over RGB, ignoring alpha. */
function difference(a: number[], b: number[], map: (value: number) => number = (value) => value) {
  let sum = 0, count = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    sum += Math.abs(map(a[i]!) - b[i]!);
    count++;
  }
  return sum / count;
}

for (const backend of ["webgl2"] as const) {
  test(`LUT color grading remaps display color on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|INVALID_(?:ENUM|OPERATION|VALUE)|context lost|fatal error|LUT/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&colorGradingProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __colorGradingProof?: unknown }).__colorGradingProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __colorGradingProof: typeof runColorGradingProof;
    }).__colorGradingProof(backend), backend).catch(async (error: unknown) => {
      await testInfo.attach("grading-errors", { body: JSON.stringify(errors), contentType: "application/json" });
      throw error;
    });
    await testInfo.attach("grading-pixels", { body: JSON.stringify(result), contentType: "application/json" });
    expect(errors).toEqual([]);
    expect(result.captures).toHaveLength(1);
    const capture = result.captures[0]!;
    const { off } = capture;
    expect(off.some((value, i) => i % 4 === 0 && value > 150), "visible swatches").toBe(true);
    expect(difference(off, capture.identity), "an identity LUT preserves color").toBeLessThan(3);
    expect(difference(off, capture.inverted, (value) => 255 - value), "an inverting LUT inverts color").toBeLessThan(4);
    expect(difference(off, capture.linearInverted, (value) => 255 - value), "grading follows the Scene Linear display stage").toBeLessThan(6);
    expect(difference(off, capture.missing), "a missing LUT asset grades nothing").toBeLessThan(1);
    expect(difference(off, capture.disabled), "disabling restores color").toBeLessThan(1);
  });

  test(`Scene Linear encodes every scene color writer once on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type()) &&
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|INVALID_(?:ENUM|OPERATION|VALUE)|context lost|fatal error/i.test(message.text()))
        errors.push(message.text());
    });
    await page.goto("/?test=1&colorGradingProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __displayColorProof?: unknown }).__displayColorProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as {
      __displayColorProof: typeof runDisplayColorProof;
    }).__displayColorProof(backend), backend);
    // Mean RGB of a 3×3 block around each named center.
    const sample = (pixels: number[], [x, y]: [number, number]) => [0, 1, 2].map((channel) => {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) sum += pixels[((y + dy) * result.width + x + dx) * 4 + channel]!;
      return Math.round(sum / 9);
    });
    const levels = Object.fromEntries(Object.entries(result.captures).map(([mode, pixels]) => [mode,
      Object.fromEntries(Object.entries(result.points).map(([key, point]) => [key, sample(pixels, point)]))]));
    await testInfo.attach("display-levels", { body: JSON.stringify(levels), contentType: "application/json" });
    expect(errors).toEqual([]);
    const near = (actual: number[], expected: number[], tolerance: number) =>
      actual.every((value, channel) => Math.abs(value - expected[channel]!) <= tolerance);
    const describe = (mode: string, key: string) => `${mode} ${key}: ${JSON.stringify(levels[mode])}`;
    // Display-space mid gray writers: the tilemap tile, sprite, MSDF and
    // Text-domain glyphs and particle draw their display colors.
    const writers = ["tilemap", "sprite", "msdfText", "particle", "textMaterial"] as const;
    // Display mid gray (0.5) reads 128 without any tone mapping.
    for (const mode of ["legacy", "none"])
      for (const key of ["unlitGray", "nativeGray", "clear", ...writers])
        expect.soft(near(levels[mode]![key]!, [128, 128, 128], 3), describe(mode, key)).toBe(true);
    for (const key of ["litGray", "litRed"] as const)
      expect.soft(near(levels.none![key]!, levels.legacy![key]!, 3), describe("none", key)).toBe(true);
    // Every tone mapping treats each writer and the clear color like Babylon's
    // own linear surface of the same color.
    for (const mode of ["none", "standard", "aces", "neutral"])
      for (const key of ["unlitGray", "litGray", "clear", ...writers])
        expect.soft(near(levels[mode]![key]!, levels[mode]!.nativeGray!, 4), describe(mode, key)).toBe(true);
    // ACES is the reference fitted RRT+ODT (input matrix, rational curve,
    // output matrix) applied once to the linear scene color, which the
    // untone-mapped capture shows through Babylon's 2.2 display encoding.
    const acesInput = [[0.59719, 0.35458, 0.04823], [0.076, 0.90834, 0.01566], [0.0284, 0.13383, 0.83777]];
    const acesOutput = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
    const multiply = (matrix: number[][], rgb: number[]) => matrix.map((row) => row.reduce((sum, value, i) => sum + value * rgb[i]!, 0));
    const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
    const acesDisplay = (display: number[]) => multiply(acesOutput, multiply(acesInput, display.map((value) => (value / 255) ** 2.2)).map(fit))
      .map((value) => Math.round(255 * Math.min(1, Math.max(0, value)) ** (1 / 2.2)));
    for (const key of ["litGray", "litRed"] as const)
      expect.soft(near(levels.aces![key]!, acesDisplay(levels.none![key]!), 3), `${describe("aces", key)} vs reference ${JSON.stringify(acesDisplay(levels.none![key]!))}`).toBe(true);
  });
}
