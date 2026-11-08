import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import {
  closeWindowsMenu,
  createContentBrowserAsset,
  openAssetFromBrowser,
  openContentBrowser,
  openListedTestProject,
  openTestProject,
  openWindowsMenu,
  pickAsset,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";
import { guidForPath } from "./material-graph";

const ALBEDO_PNG = path.join(process.cwd(), "e2e/fixtures/albedo.png");
const HELPER_PATH = "assets/DaySky.skyboxcreator.hasset";
const FACE_KEYS = ["px", "py", "pz", "nx", "ny", "nz"] as const;

test.describe("Skybox Creator helper", () => {
  test("creates six skybox Textures from a picked Texture", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openTestProject(page);
    await openContentBrowser(page);
    await page
      .getByTestId("content-browser-import-input")
      .setInputFiles([ALBEDO_PNG]);
    await page.getByTestId("content-browser-search").fill("albedo");
    await expect(
      page.locator('[data-asset-path="assets/albedo.hasset"]'),
    ).toBeVisible({ timeout: 30_000 });

    await createContentBrowserAsset(page, "SkyboxCreator", "DaySky");
    await openAssetFromBrowser(page, HELPER_PATH);
    await expect(
      page.getByTestId("document-workspace-skybox-creator"),
    ).toBeVisible();
    await expect(page.getByTestId("skybox-creator-preview")).toBeVisible();
    await expect(page.getByTestId("skybox-creator-net")).toBeVisible();
    await expect(page.getByText("Front", { exact: true })).toBeVisible();
    await expect(page.getByText("Back", { exact: true })).toBeVisible();
    await expect(page.getByText("Left", { exact: true })).toBeVisible();
    await expect(page.getByText("Right", { exact: true })).toBeVisible();
    await expect(page.getByText("Up", { exact: true })).toBeVisible();
    await expect(page.getByText("Down", { exact: true })).toBeVisible();
    await expect(page.getByTestId("skybox-creator-empty")).toBeVisible();

    await expect(page.getByTestId("windows-menu")).toBeEnabled();
    await openWindowsMenu(page);
    await expect(
      page.getByTestId("windows-menu-skybox-creator-preview"),
    ).toBeVisible();
    await expect(
      page.getByTestId("windows-menu-skybox-creator-cubemap"),
    ).toBeVisible();
    await expect(
      page.getByTestId("windows-menu-skybox-creator-details"),
    ).toBeVisible();
    await closeWindowsMenu(page);

    const albedoGuid = await guidForPath(page, "assets/albedo.hasset");
    expect(albedoGuid.length).toBeGreaterThan(0);
    await page.getByTestId("property-source").click();
    await pickAsset(page, "skybox-creator-texture-picker", albedoGuid);

    await page
      .getByTestId("skybox-creator-details-panel")
      .getByTestId("skybox-creator-create")
      .click();

    await openContentBrowser(page);
    await page.getByTestId("content-browser-search").fill("DaySky");
    for (const key of FACE_KEYS) {
      await expect(
        page.locator(`[data-asset-path="assets/DaySky_${key}.hasset"]`),
      ).toBeVisible({ timeout: 30_000 });
    }

    await openAssetFromBrowser(page, HELPER_PATH);
    await expect(page.getByTestId("property-source")).toContainText(/albedo/i);
    await expect(page.getByTestId("skybox-creator-empty")).toHaveCount(0);
    const netBox = await page.getByTestId("skybox-creator-net").boundingBox();
    expect(netBox).toBeTruthy();
    expect(netBox!.width / netBox!.height).toBeCloseTo(4 / 3, 1);
    expect(netBox!.y).toBeGreaterThanOrEqual(0);
    const frontBox = await page
      .getByTestId("skybox-creator-cell-front")
      .boundingBox();
    expect(frontBox).toBeTruthy();
    expect(frontBox!.width / netBox!.width).toBeCloseTo(0.25, 1);
    expect(frontBox!.height / netBox!.height).toBeCloseTo(1 / 3, 1);
    const cubemap = page.getByTestId("skybox-creator-cubemap-panel");
    const canvas = cubemap.getByTestId("skybox-creator-preview-canvas");
    await expect(canvas).toBeVisible();
    const canvasBox = await canvas.boundingBox();
    const cubemapBox = await cubemap.boundingBox();
    expect(canvasBox).toBeTruthy();
    expect(cubemapBox).toBeTruthy();
    expect(canvasBox!.x).toBeGreaterThanOrEqual(cubemapBox!.x - 1);
    expect(canvasBox!.y).toBeGreaterThanOrEqual(cubemapBox!.y - 1);
    expect(canvasBox!.x + canvasBox!.width).toBeLessThanOrEqual(
      cubemapBox!.x + cubemapBox!.width + 1,
    );
    expect(canvasBox!.y + canvasBox!.height).toBeLessThanOrEqual(
      cubemapBox!.y + cubemapBox!.height + 1,
    );
    await saveAllIfEnabled(page);

    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("homepage")).toBeVisible();
    await openListedTestProject(page);
    await openContentBrowser(page);
    await page.getByTestId("content-browser-search").fill("DaySky");
    await expect(
      page.locator(`[data-asset-path="${HELPER_PATH}"]`),
    ).toBeVisible();
    await openAssetFromBrowser(page, HELPER_PATH);
    await expect(page.getByTestId("property-source")).toContainText(/albedo/i);
    await expect(page.getByTestId("property-face-px")).toContainText(
      /DaySky_px/i,
    );
  });
});
