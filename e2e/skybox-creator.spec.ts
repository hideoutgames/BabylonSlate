import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openContentBrowser,
  openListedTestProject,
  openTestProject,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";
import {
  createActor,
  createDefaultScene,
  createSkyboxComponent,
  type SerializedScene,
} from "../packages/core/src/index.ts";
import { collectExportClosure } from "../packages/exporter/src/index.ts";
import type { ExportIndexedAsset } from "../packages/exporter/src/types.ts";

const ALBEDO_PNG = path.join(process.cwd(), "e2e/fixtures/albedo.png");
const HELPER_PATH = "assets/DaySky.skyboxcreator.babasset";
const FACE_KEYS = ["px", "py", "pz", "nx", "ny", "nz"] as const;

async function guidForPath(page: Page, assetPath: string): Promise<string> {
  return page.evaluate((target) => {
    const host = globalThis as {
      __babylonslateTest?: { guidForPath: (path: string) => string | null };
    };
    return host.__babylonslateTest?.guidForPath(target) ?? "";
  }, assetPath);
}

async function pickAsset(
  page: Page,
  pickerTestId: string,
  guid: string,
): Promise<void> {
  await expect(page.getByTestId(pickerTestId)).toBeVisible();
  await page.getByTestId(`search-item-${guid}`).click();
  await expect(page.getByTestId(pickerTestId)).toHaveCount(0);
}

async function openWindowsMenu(page: Page): Promise<void> {
  const content = page.getByTestId("windows-menu-content");
  if (await content.isVisible()) return;
  await page.getByTestId("windows-menu").click();
  await expect(content).toBeVisible();
}

async function closeWindowsMenu(page: Page): Promise<void> {
  const content = page.getByTestId("windows-menu-content");
  if (!(await content.isVisible())) return;
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  if (await content.isVisible()) {
    await page.mouse.click(12, 12);
  }
  await expect(content).toHaveCount(0);
}

function exportAsset(
  partial: Partial<ExportIndexedAsset> &
    Pick<ExportIndexedAsset, "guid" | "type" | "name">,
): ExportIndexedAsset {
  return {
    dependencies: [],
    rootId: "project",
    parentClass: null,
    ...partial,
  };
}

test.describe.configure({ mode: "serial" });

test.describe("Skybox Creator helper", () => {
  test("packed export closure omits the helper and keeps referenced faces", () => {
    const skybox = createSkyboxComponent("sky-1");
    skybox.properties.faces = {
      px: "face-px",
      py: "face-py",
      pz: "face-pz",
      nx: "face-nx",
      ny: "face-ny",
      nz: "face-nz",
    };
    const scene: SerializedScene = {
      ...createDefaultScene(),
      actors: [
        createActor("sky", "Skybox", {
          components: [skybox],
        }),
      ],
    };
    const result = collectExportClosure({
      startupSceneGuid: "scene-1",
      assets: [
        exportAsset({
          guid: "scene-1",
          type: "Scene",
          name: "Main",
          dependencies: ["helper-1"],
        }),
        exportAsset({
          guid: "helper-1",
          type: "SkyboxCreator",
          name: "DaySky",
          dependencies: ["src-tex", "face-px"],
        }),
        exportAsset({ guid: "src-tex", type: "Texture", name: "Source" }),
        exportAsset({ guid: "face-px", type: "Texture", name: "DaySky_px" }),
        exportAsset({ guid: "face-py", type: "Texture", name: "DaySky_py" }),
        exportAsset({ guid: "face-pz", type: "Texture", name: "DaySky_pz" }),
        exportAsset({ guid: "face-nx", type: "Texture", name: "DaySky_nx" }),
        exportAsset({ guid: "face-ny", type: "Texture", name: "DaySky_ny" }),
        exportAsset({ guid: "face-nz", type: "Texture", name: "DaySky_nz" }),
      ],
      pluginEnabledGuids: new Set(),
      parentOf: () => null,
      sceneByGuid: () => scene,
      graphByGuid: () => null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toContain("helper-1");
    expect(result.value).not.toContain("src-tex");
    expect(result.value).toEqual(
      expect.arrayContaining([
        "scene-1",
        "face-px",
        "face-py",
        "face-pz",
        "face-nx",
        "face-ny",
        "face-nz",
      ]),
    );
  });

  test("creates six skybox Textures from a picked Texture", async ({ page }) => {
    test.setTimeout(240_000);
    await openTestProject(page);
    await openContentBrowser(page);
    await page
      .getByTestId("content-browser-import-input")
      .setInputFiles([ALBEDO_PNG]);
    await page.getByTestId("content-browser-search").fill("albedo");
    await expect(
      page.locator('[data-asset-path="assets/albedo.babasset"]'),
    ).toBeVisible({ timeout: 30_000 });

    await createContentBrowserAsset(page, "SkyboxCreator", "DaySky");
    await openAssetFromBrowser(page, HELPER_PATH);
    await expect(
      page.getByTestId("document-workspace-skybox-creator"),
    ).toBeVisible();
    await expect(page.getByTestId("skybox-creator-preview")).toBeVisible();
    await expect(page.getByTestId("skybox-creator-net")).toBeVisible();
    await expect(page.getByText("FRONT", { exact: true })).toBeVisible();
    await expect(page.getByText("BACK", { exact: true })).toBeVisible();
    await expect(page.getByText("LEFT", { exact: true })).toBeVisible();
    await expect(page.getByText("RIGHT", { exact: true })).toBeVisible();
    await expect(page.getByText("UP", { exact: true })).toBeVisible();
    await expect(page.getByText("DOWN", { exact: true })).toBeVisible();
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

    const albedoGuid = await guidForPath(page, "assets/albedo.babasset");
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
        page.locator(`[data-asset-path="assets/DaySky_${key}.babasset"]`),
      ).toBeVisible({ timeout: 30_000 });
    }

    await openAssetFromBrowser(page, HELPER_PATH);
    await expect(page.getByTestId("property-source")).toContainText(/albedo/i);
    await expect(page.getByTestId("skybox-creator-empty")).toHaveCount(0);
    const netBox = await page.getByTestId("skybox-creator-net").boundingBox();
    expect(netBox).toBeTruthy();
    expect(netBox!.width / netBox!.height).toBeCloseTo(4 / 3, 1);
    expect(netBox!.y).toBeGreaterThanOrEqual(0);
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
    await expect(page.locator(`[data-asset-path="${HELPER_PATH}"]`)).toBeVisible();
    await openAssetFromBrowser(page, HELPER_PATH);
    await expect(page.getByTestId("property-source")).toContainText(/albedo/i);
    await expect(page.getByTestId("property-face-px")).toContainText(/DaySky_px/i);
  });
});
