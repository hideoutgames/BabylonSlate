import { expect, test, type Page } from "@playwright/test";
import { openAssetFromBrowser, openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

const E2E_TIMEOUT_MS = 180_000;

async function openClassPrefab(page: Page): Promise<void> {
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await expect(page.getByTestId("document-workspace-graph")).toBeVisible();
  await page.locator(".dv-tab").filter({ hasText: "Prefab" }).click();
  await expect(page.getByTestId("prefab-viewport-panel")).toBeVisible();
  await expect(page.getByTestId("prefab-preview-canvas")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.describe("P18 iPad editor optimisation", () => {
  test("Prefab Preview, Play overlay, and Scene viewport share one session", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await openMainScene(page);
    await expect(page.getByTestId("viewport-canvas")).toBeVisible({
      timeout: 15_000,
    });

    await openClassPrefab(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    await expect(page.getByTestId("prefab-preview-canvas")).toBeVisible();

    await openMainScene(page);
    await expect(page.getByTestId("viewport-canvas")).toBeVisible({
      timeout: 15_000,
    });
  });
});
