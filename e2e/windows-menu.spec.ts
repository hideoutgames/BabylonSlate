import { expect, test, type Page } from "@playwright/test";
import { openTestProject } from "./open-test-project";

async function openWindowsMenu(page: Page) {
  const content = page.getByTestId("windows-menu-content");
  if (await content.isVisible()) return;
  await page.getByTestId("windows-menu").click();
  await expect(content).toBeVisible();
}

async function clickWindowItem(page: Page, id: string) {
  const item = page.getByTestId(`windows-menu-${id}`);
  await expect(item).toBeVisible();
  await item.evaluate((el: HTMLElement) => el.click());
}

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
    expect(windowsBox!.x + windowsBox!.width).toBeLessThanOrEqual(
      focusBox!.x + 1,
    );
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

    await expect(page.getByTestId("windows-menu")).toBeEnabled();
    await openWindowsMenu(page);
    await expect(page.getByTestId("windows-menu-scene-outliner")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await clickWindowItem(page, "scene-outliner");
    await expect(page.getByTestId("scene-outliner-panel")).toHaveCount(0);

    await openWindowsMenu(page);
    await expect(page.getByTestId("windows-menu-scene-outliner")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await clickWindowItem(page, "scene-outliner");
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible({
      timeout: 10_000,
    });

    await openWindowsMenu(page);
    await page
      .getByTestId("windows-editor-utilities")
      .evaluate((el: HTMLElement) => el.click());
    await expect(page.getByTestId("windows-editor-utilities-empty")).toBeVisible();
  });
});
