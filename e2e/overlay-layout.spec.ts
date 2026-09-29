import { expect, test } from "@playwright/test";
import type { runOverlayLayoutProof } from "../apps/editor/src/testing/overlay-layout-proof";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });
for (const backend of ["webgl2", "webgpu"] as const) {
  test(`ScrollBox clips editor and runtime pixels on ${backend}, including render targets`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|context lost/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&overlayLayoutProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __overlayLayoutProof?: unknown }).__overlayLayoutProof === "function");
    const result = await page.evaluate(backend => (window as unknown as { __overlayLayoutProof: typeof runOverlayLayoutProof }).__overlayLayoutProof(backend), backend);
    expect(errors).toEqual([]);
    expect(result.captures).toHaveLength(4);
    for (const capture of result.captures) {
      const label = `${capture.host} ${capture.target}`;
      expect(capture.inside, label).toEqual([255, 0, 0]);
      expect(capture.outsideY, label).toEqual([0, 0, 0]);
      expect(capture.outsideX, label).toEqual([0, 0, 0]);
      expect(capture.marker, label).toEqual([0, 255, 0]);
    }
  });
}
