import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { encodeProjectZip } from "../packages/assets/src/hproject";
import { buildRadianceHdrFixture } from "../packages/test-kit/src/environment-fixtures";
import { openAssetFromBrowser, openContentBrowser, openTestProject } from "./open-test-project";

const fixtures = path.join(process.cwd(), "e2e/fixtures");

test("a ZIP imports into a folder named after it, keeping its folders and listing what it skipped", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openTestProject(page);
  await openContentBrowser(page);
  // As macOS Compress writes it: one wrapping folder, plus __MACOSX metadata.
  const archive = encodeProjectZip([
    { path: "Props/Chair/albedo.png", data: readFileSync(path.join(fixtures, "albedo.png")) },
    { path: "Props/hero.glb", data: readFileSync(path.join(fixtures, "hero.glb")) },
    { path: "Props/notes.txt", data: new TextEncoder().encode("Not an asset.") },
    { path: "__MACOSX/Props/._hero.glb", data: new Uint8Array([0, 5, 22, 7]) },
  ]);
  await page.getByTestId("content-browser-import-input").setInputFiles({
    name: "Props.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });

  const issues = page.getByTestId("import-errors-dialog");
  await expect(issues).toBeVisible({ timeout: 60_000 });
  await expect(issues.getByText("Import Partially Completed")).toBeVisible();
  await expect(issues.getByText(/Props\.zip: Skipped 1 file .*Props\/notes\.txt/)).toBeVisible();
  await expect(issues.getByText(/Props\.zip: Skipped 1 macOS .*__MACOSX/)).toBeVisible();
  await page.getByTestId("import-errors-dismiss").click();

  await expect(page.locator('[data-folder-path="assets/Props"]')).toBeVisible();
  const guids = await page.evaluate(async () => {
    const api = (globalThis as { __hapticTest?: { guidForPath: (path: string) => string | null | Promise<string | null> } }).__hapticTest!;
    return Promise.all(["assets/Props/Chair/albedo.hasset", "assets/Props/hero.hasset"].map((path) => api.guidForPath(path)));
  });
  expect(guids.every(Boolean)).toBe(true);
  expect(errors).toEqual([]);
});

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
