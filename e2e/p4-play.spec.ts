import { expect, test } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";

test.describe("P4 Play overlay and session report", () => {
  test("Play opens overlay; fixture throw shows report and focuses node", async ({
    page,
  }) => {
    await openTestProject(page, "/?test=1&previewThrow=1");

    await openMainScene(page);

    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    await expect(page.getByTestId("play-frame-cap")).toHaveCount(0);

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("preview-session-report")).toBeVisible();
    await expect(page.getByTestId("play-last-runtime")).toHaveAttribute(
      "data-mode",
      /^(worker|in-process)$/,
    );
    await page.getByTestId("session-report-row").click();
    await expect(page.getByTestId("focused-graph-node")).toHaveAttribute(
      "data-node-id",
      "throw-node",
    );
  });

  test("clean Play skips the save-and-compile dialog", async ({ page }) => {
    await openTestProject(page);
    await openMainScene(page);

    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await expect(page.getByTestId("play-prepare-dialog")).toHaveCount(0);
    await expect(page.getByTestId("stats-hud-draws")).toBeVisible();
    await expect
      .poll(async () => {
        const attr = await page
          .getByTestId("stats-hud-draws")
          .getAttribute("data-draws");
        return Number(attr ?? "0");
      }, { timeout: 15_000 })
      .toBeGreaterThan(0);

    await page.getByTestId("play-overlay-close").click();
  });

  test("dirty graph Play shows the prepare dialog, then saves", async ({
    page,
  }) => {
    await openTestProject(page);
    await openMainScene(page);

    const nudged = await page.evaluate(async () => {
      const host = globalThis as unknown as {
        __babylonslateTest?: {
          ensureMainGraphOpen: () => Promise<boolean>;
          nudgeActiveGraphNode: () => Promise<boolean>;
          cancelDebouncedSave: () => void;
        };
      };
      if (!host.__babylonslateTest) return false;
      await host.__babylonslateTest.ensureMainGraphOpen();
      const ok = await host.__babylonslateTest.nudgeActiveGraphNode();
      host.__babylonslateTest.cancelDebouncedSave();
      return ok;
    });
    expect(nudged).toBe(true);

    await expect(page.getByTestId("save-all-project")).toBeEnabled();
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-prepare-dialog")).toBeVisible();
    await expect(page.getByTestId("play-overlay")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("play-prepare-dialog")).toHaveCount(0);

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("save-all-project")).toBeDisabled();
  });

  test("Play is disabled until a scene tab is open; creating a scene opens it exclusively", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("play-preview")).toBeDisabled();
    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="scene"]'),
    ).toHaveCount(0);

    await page.getByTestId("content-browser-new-asset").click();
    await expect(page.getByTestId("content-browser-new-asset-dialog")).toBeVisible();
    await page.getByTestId("new-asset-type").click();
    await page.getByTestId("new-asset-type-Scene").click();
    await page.getByTestId("new-asset-name").fill("LevelTwo");
    await page.getByTestId("content-browser-new-asset-create").click();
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(page.getByTestId("play-preview")).toBeEnabled();
    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="scene"]'),
    ).toHaveCount(1);

    await page
      .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
      .click();
    await expect(page.getByTestId("play-preview")).toBeEnabled();

    await page.locator('[data-asset-path="assets/main.scene.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="scene"]'),
    ).toHaveCount(1);
    await expect(page.getByTestId("play-preview")).toBeEnabled();
  });

  test("Project Settings author render resolution and a packaged startup scene", async ({
    page,
  }) => {
    await openTestProject(page);
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-rendering").click();
    await expect(page.getByTestId("setting-render-custom")).toBeVisible();
    await expect(page.getByTestId("setting-render-width")).toBeVisible();
    await expect(page.getByTestId("setting-render-height")).toBeVisible();
    await expect(page.getByTestId("setting-render-black-bars")).toBeVisible();
    await page.getByTestId("settings-modal-category-export").click();
    await expect(page.getByTestId("settings-startup-scene")).toBeVisible();
  });
});
