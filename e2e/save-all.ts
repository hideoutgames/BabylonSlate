import { expect, type Page } from "@playwright/test";

/** Click Save All when the project has unsaved documents; no-op when clean. */
export async function saveAllIfEnabled(page: Page): Promise<void> {
  const button = page.getByTestId("save-all-project");
  await expect(button).toBeVisible();
  if (await button.isEnabled()) {
    await button.click();
  }
}
