import type { Page } from "@playwright/test";

/** Close the project with Project Browser in the chrome Settings dropdown. */
export async function closeProjectViaSettings(page: Page): Promise<void> {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-browser").click();
}
