import { expect, test } from "@playwright/test";
import type { runColorGradingProof } from "../apps/editor/src/testing/color-grading-proof";
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
        /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost|fatal error|LUT/i.test(message.text()))
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
}
