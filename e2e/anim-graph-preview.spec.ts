import { expect, test, type Locator } from "@playwright/test";
import { openAssetFromBrowser, openTestProject } from "./open-test-project";

const ANIM_PATH = "assets/Mannequin/Mannequin.anim3d.hasset";

/** The Preview's readout time in seconds, from "State · 1.23 s". */
async function readoutSeconds(readout: Locator): Promise<number> {
  const match = /([\d.]+) s$/.exec((await readout.textContent()) ?? "");
  return match ? Number(match[1]) : Number.NaN;
}

test.describe("Animation Graph Preview", () => {
  test("plays the Mannequin graph beside the Inspector, pauses, steps and shows bones", async ({ page }, testInfo) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, ANIM_PATH);

    const panel = page.getByTestId("anim-preview-panel");
    const values = page.getByTestId("anim-preview-values");
    await expect(panel).toBeVisible();
    await expect(values).toBeVisible();
    // Preview stacks above the Inspector and Preview Values below Variables, leaving the Graph the centre.
    const [previewBox, detailsBox, valuesBox, addVariableBox, graphBox] = await Promise.all([
      panel.boundingBox(),
      page.getByTestId("anim-graph-details").first().boundingBox(),
      values.boundingBox(),
      page.getByTestId("anim-graph-add-variable").boundingBox(),
      page.getByTestId("anim-graph-editor").boundingBox(),
    ]);
    expect(previewBox && detailsBox && valuesBox && addVariableBox && graphBox).toBeTruthy();
    expect(previewBox!.y + previewBox!.height).toBeLessThanOrEqual(detailsBox!.y + 1);
    expect(previewBox!.x).toBeGreaterThanOrEqual(graphBox!.x + graphBox!.width - 1);
    expect(valuesBox!.y).toBeGreaterThanOrEqual(addVariableBox!.y + addVariableBox!.height - 1);
    expect(valuesBox!.x + valuesBox!.width).toBeLessThanOrEqual(graphBox!.x + 1);

    const canvas = page.getByTestId("anim-preview-canvas");
    await expect(canvas).not.toHaveAttribute("data-clips", "0", { timeout: 30_000 });
    const readout = page.getByTestId("anim-preview-state");
    await expect(readout).toHaveText(/\S · \d+\.\d\d s$/);
    const started = await readoutSeconds(readout);
    await expect.poll(() => readoutSeconds(readout)).toBeGreaterThan(started);

    await page.getByTestId("anim-preview-pause").click();
    await expect(page.getByTestId("anim-preview-play")).toBeVisible();
    const paused = await readoutSeconds(readout);
    await page.waitForTimeout(300);
    expect(await readoutSeconds(readout)).toBe(paused);

    await page.getByTestId("anim-preview-step").click();
    await expect.poll(() => readoutSeconds(readout)).toBeCloseTo(paused + 1 / 60, 1);
    await expect(page.getByTestId("anim-preview-play")).toBeVisible();

    await page.getByTestId("anim-preview-bones").click();
    await expect(canvas).toHaveAttribute("data-bones", "true");
    await canvas.screenshot({ path: testInfo.outputPath("anim-graph-preview-bones.png") });

    await page.getByTestId("anim-preview-restart").click();
    await expect.poll(() => readoutSeconds(readout)).toBe(0);
  });
});
