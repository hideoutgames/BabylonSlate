import type { Page } from "@playwright/test";

/** Open Project Settings from the chrome dropdown and close the project. */
export async function closeProjectViaSettings(page: Page): Promise<void> {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-project").click();
  await page.getByTestId("close-project").click();
}
