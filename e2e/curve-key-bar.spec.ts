import { expect, test } from "@playwright/test";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { createDefaultCurveAssetPayload } from "../packages/core/src/curve-assets";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, waitForEditorInteractive } from "./open-test-project";

// The key fields are taller than the step controls: selecting a key used to grow the bar and nudge the plot above.
test("a curve window's key bar keeps its height when a key is selected", async ({ page }) => {
  test.setTimeout(120_000);
  const files = await minimalProjectFiles();
  files.set("assets/Falloff.floatcurve.hasset", await encodeAssetDocument({
    guid: "falloff", type: "FloatCurve", name: "Falloff", version: 1,
    payload: createDefaultCurveAssetPayload("float") as unknown as Record<string, unknown>,
  }));
  await openMinimalTestProject(page, files);
  await waitForEditorInteractive(page);
  await openAssetFromBrowser(page, "assets/Falloff.floatcurve.hasset");
  const bar = page.getByTestId("curve-asset-editor-key-bar");
  const count = page.getByTestId("curve-asset-editor-key-count");
  await expect(bar).toBeVisible();
  // A tap on empty plot space, above the rising line, clears the selection.
  const plot = (await page.getByTestId("curve-asset-editor-plot").boundingBox())!;
  await page.mouse.click(plot.x + plot.width * 0.3, plot.y + plot.height * 0.3);
  await expect(count).toHaveText("No Key Selected");
  const idle = (await bar.boundingBox())!.height;
  await page.getByTestId("curve-asset-editor-next-key").click();
  await expect(count).toHaveText("Key 1 of 2");
  await expect(page.getByTestId("curve-asset-editor-time")).toBeVisible();
  expect((await bar.boundingBox())!.height).toBe(idle);
});
