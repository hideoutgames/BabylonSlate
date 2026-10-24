import { expect, test } from "@playwright/test";
import { buildRadianceHdrFixture } from "../packages/test-kit/src/environment-fixtures";
import { openAssetFromBrowser, openContentBrowser, openTestProject } from "./open-test-project";

test("an HDR import shows the Importing dialog, Cancel leaves no asset behind, and Face Size converts again", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openTestProject(page);

  // The largest Face Size keeps the conversion running long enough to cancel.
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-assets").click();
  await page.getByTestId("setting-hdr-import-face-size").click();
  await page.getByRole("option", { name: "512 × 512" }).click();
  await expect(page.getByTestId("setting-hdr-import-face-size")).toHaveText(/512 × 512/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("engine-settings-modal")).toHaveCount(0);

  await openContentBrowser(page);
  // Numeric RGBE data, no artwork: one colour run-length encodes to a small file.
  const panorama = buildRadianceHdrFixture({ width: 4096, height: 2048, color: () => [1, 0.8, 0.6], runLength: true });
  await page.getByTestId("content-browser-import-input").setInputFiles({
    name: "Sky.hdr",
    mimeType: "image/vnd.radiance",
    buffer: Buffer.from(panorama),
  });

  const dialog = page.getByTestId("importing-overlay");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Sky.hdr")).toBeVisible();
  // Progress arrives from the import worker while the conversion runs.
  await expect
    .poll(async () => Number(await page.getByTestId("importing-progress").getAttribute("aria-valuenow")))
    .toBeGreaterThan(0);
  await page.getByTestId("importing-cancel").click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Import Failed")).toHaveCount(0);
  await expect(page.locator('[data-asset-path="assets/Sky.hasset"]')).toHaveCount(0);
  const guid = await page.evaluate(() =>
    (globalThis as { __hapticTest?: { guidForPath: (path: string) => string | null | Promise<string | null> } })
      .__hapticTest?.guidForPath("assets/Sky.hasset") ?? null);
  expect(guid).toBeNull();

  // A completed import keeps the panorama, so its Face Size converts again from the Inspector.
  const smaller = buildRadianceHdrFixture({ width: 1024, height: 512, color: () => [1, 0.8, 0.6], runLength: true });
  await page.getByTestId("content-browser-import-input").setInputFiles({
    name: "Sky.hdr",
    mimeType: "image/vnd.radiance",
    buffer: Buffer.from(smaller),
  });
  await expect(page.locator('[data-asset-path="assets/Sky.hasset"]')).toBeVisible({ timeout: 60_000 });
  await expect(dialog).toHaveCount(0);
  await openAssetFromBrowser(page, "assets/Sky.hasset");
  // 512 asked for, but faces stay at a quarter of the 1024-wide panorama.
  await expect(page.getByText("Cube · 256 × 256")).toBeVisible();
  await page.getByTestId("property-faceSize").click();
  await page.getByRole("option", { name: "128 × 128" }).click();
  await expect(page.getByText("Cube · 128 × 128")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("property-faceSize")).toHaveText(/128 × 128/);
  expect(errors).toEqual([]);
});
