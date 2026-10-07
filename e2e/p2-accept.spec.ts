import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import { openAssetFromBrowser, openContentBrowser, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

const fixtures = path.join(process.cwd(), "e2e/fixtures");

// Shared TestProject OPFS name — keep these serial to avoid cross-test stomps.
test.describe.configure({ mode: "serial" });

test.describe("P2 acceptance proofs", () => {
  test("imports PNG + GLB, survives reload, keeps assets browsable", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();

    await page
      .getByTestId("content-browser-import-input")
      .setInputFiles([
        path.join(fixtures, "albedo.png"),
        path.join(fixtures, "hero.glb"),
      ]);

    await expect(page.getByTestId("importing-overlay")).toBeVisible();
    await expect(page.getByTestId("importing-count")).toBeVisible();

    await expect(
      page.locator('[data-asset-path="assets/albedo.babasset"]'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("importing-overlay")).toHaveCount(0);
    await expect(
      page.locator('[data-asset-path="assets/hero.babasset"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-asset-path="assets/hero_HeroMat.babasset"]'),
    ).toBeVisible();

    await openAssetFromBrowser(page, "assets/hero.babasset");
    await expect(page.getByTestId("model-preview")).toBeVisible();
    await expect(page.getByTestId("model-colliders-panel")).toBeVisible();
    await expect(page.getByTestId("model-show-collision")).toBeVisible();
    await expect(page.getByTestId("model-details-panel")).toBeVisible();
    await expect(page.getByTestId("property-slot-0")).toBeVisible();
    await expect(page.getByTestId("property-materialCount")).toHaveCount(0);

    await openContentBrowser(page);
    const albedo = page.locator('[data-asset-path="assets/albedo.babasset"]');
    await expect(async () => {
      await expect(albedo.getByText("Encoding")).toHaveCount(0);
      await expect(albedo.getByText("Compress pending")).toHaveCount(0);
      const readable = await page.evaluate(async () => {
        const api = (
          globalThis as {
            __babylonslateTest?: {
              textureEncodeState?: (path: string) => {
                compressionState: string | null;
                encodeError: string | null;
                hasPixels: boolean;
              } | null;
              readAssetChunk?: (
                path: string,
                chunkId: string,
              ) => Promise<Uint8Array | null>;
            };
          }
        ).__babylonslateTest;
        const pathName = "assets/albedo.babasset";
        const state = api?.textureEncodeState?.(pathName);
        if (!state?.hasPixels) return false;
        if (
          state.compressionState === "encoding" ||
          state.compressionState === "pending"
        ) {
          return false;
        }
        const bytes = await api?.readAssetChunk?.(pathName, "pixels");
        return Boolean(bytes && bytes.byteLength > 0);
      });
      expect(readable).toBe(true);
    }).toPass({ timeout: 60_000 });
    const importErrors = page.getByTestId("import-errors-dialog");
    if (await importErrors.isVisible()) {
      await page.getByTestId("import-errors-dismiss").click();
    }
    await expect(async () => {
      const openError = page.getByTestId("content-browser-open-error");
      if (await openError.count()) {
        await page.getByTestId("content-browser-open-error-dismiss").click();
        await expect(openError).toHaveCount(0);
      }
      await albedo.dblclick();
      await expect(page.getByTestId("texture-preview")).toBeVisible({
        timeout: 5_000,
      });
    }).toPass({ timeout: 30_000 });

    await saveAllIfEnabled(page);
    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page
      .getByTestId("open-listed-project-TestProject")
      .click();
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
    await expect(
      page.locator('[data-asset-path="assets/albedo.babasset"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-asset-path="assets/hero.babasset"]'),
    ).toBeVisible();
  });
});
