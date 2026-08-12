import { expect, test } from "@playwright/test";
import { openTestProject } from "./open-test-project";

test.describe("Windows menu", () => {
  test("sits left of Focus and is disabled on Content Browser", async ({
    page,
  }) => {
    await openTestProject(page);

    const windows = page.getByTestId("windows-menu");
    const focus = page.getByTestId("focus-layout");
    await expect(windows).toBeVisible();
    await expect(windows).toBeDisabled();
    await expect(focus).toBeDisabled();

    const windowsBox = await windows.boundingBox();
    const focusBox = await focus.boundingBox();
    expect(windowsBox).not.toBeNull();
    expect(focusBox).not.toBeNull();
    expect(windowsBox!.x + windowsBox!.width).toBeLessThanOrEqual(focusBox!.x + 1);
  });

  test("toggles Outliner and shows an empty Editor Utilities submenu", async ({
    page,
  }) => {
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible({
      timeout: 15_000,
    });

    const windows = page.getByTestId("windows-menu");
    await expect(windows).toBeEnabled();
    await windows.click();
    await expect(page.getByTestId("windows-menu-content")).toBeVisible();

    const outlinerItem = page.getByTestId("windows-menu-scene-outliner");
    await expect(outlinerItem).toHaveAttribute("aria-checked", "true");
    await outlinerItem.click();
    await expect(page.getByTestId("scene-outliner-panel")).toHaveCount(0);

    await windows.click();
    await expect(page.getByTestId("windows-menu-scene-outliner")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.getByTestId("windows-menu-scene-outliner").click();
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();

    await windows.click();
    await page.getByTestId("windows-editor-utilities").click();
    await expect(page.getByTestId("windows-editor-utilities-empty")).toBeVisible();
  });
});
