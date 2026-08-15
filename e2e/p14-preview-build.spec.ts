import { expect, test } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";

test.describe("P14 Preview Build", () => {
  test("default overlay Play is unchanged when Preview Build is off", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("play-preview")).toBeDisabled();
    await page.getByTestId("debug-menu").click();
    await expect(page.getByTestId("preview-build-toggle")).toBeVisible();
    await page.keyboard.press("Escape");
    await openMainScene(page);
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await expect(page.getByTestId("preview-build-overlay")).toHaveCount(0);
    await page.getByTestId("play-overlay-close").click();
  });

  test("Preview Build Play does not require a scene tab and boots startupSceneGuid", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("play-preview")).toBeDisabled();
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await expect(page.getByTestId("play-preview")).toBeEnabled();
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("preparing-preview-dialog")).toBeVisible();
    await expect(page.getByTestId("preview-build-overlay")).toBeVisible({
      timeout: 30_000,
    });
    const frame = page.frameLocator('[data-testid="preview-build-iframe"]');
    await expect(frame.getByTestId("player-root")).toBeVisible({ timeout: 30_000 });
    await expect(frame.getByTestId("player-root")).not.toHaveAttribute(
      "data-startup-scene",
      "assets/main.scene.babasset",
    );
    await page.getByTestId("preview-build-close").click();
    await expect(page.getByTestId("preview-build-overlay")).toHaveCount(0);
  });

  test("missing startup scene alerts and overlay Play still requires a scene tab when off", async ({
    page,
  }) => {
    await openTestProject(page);
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-export").click();
    await page.getByTestId("settings-startup-scene").click();
    await page.getByTestId("search-item-__none__").click();
    await page
      .getByTestId("settings-modal")
      .locator('[data-slot="dialog-close"]')
      .click();
    await expect(page.getByTestId("settings-modal")).toHaveCount(0);
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("startup-scene-alert")).toBeVisible();
    await expect(page.getByTestId("startup-scene-alert")).toContainText(
      "Set Startup Scene in Project Settings.",
    );
    await page.getByTestId("startup-scene-alert-ok").click();
    await expect(page.getByTestId("startup-scene-alert")).toHaveCount(0);
    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await expect(page.getByTestId("play-preview")).toBeDisabled();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  });
});
