import { expect, test } from "@playwright/test";
import type { runNativeOutlineProof } from "../apps/editor/src/testing/native-outline-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`records stock outline consumer ownership qualification on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/?test=1&nativeOutlineProof=1");
    await page.waitForFunction(() => "__babylonslateNativeOutlineProof" in window);
    const report = await page.evaluate((backend) => (window as unknown as {
      __babylonslateNativeOutlineProof: typeof runNativeOutlineProof;
    }).__babylonslateNativeOutlineProof(backend), backend);
    for (const capture of report.captures)
      await testInfo.attach(capture.name, { body: Buffer.from(capture.image.split(",")[1]!, "base64"), contentType: "image/png" });
    await testInfo.attach("native-outline-qualification", {
      body: JSON.stringify({ ...report, captures: report.captures.map(({ name, redPixels, selectionBuffer }) => ({ name, redPixels, selectionBuffer })), errors }),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
    expect(report.captures[0]!.redPixels).toBeGreaterThan(0);
    expect(report.captures[1]!.redPixels).toBe(report.captures[0]!.redPixels);
    // A passing harness run is evidence of the pinned native limitation, not
    // production feature acceptance. Requalification is required on upgrades.
    expect(report.blockers).toContain("Clearing a disjoint component consumer deletes the shared CEL instance selection buffer.");
  });
}
