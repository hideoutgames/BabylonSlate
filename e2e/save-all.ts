import { expect, type Page } from "@playwright/test";

/**
 * Click Save All when the project has unsaved documents; no-op when clean.
 *
 * Viewport load, camera pose, and layout writes can mark the project dirty
 * again immediately after a successful save, so keep saving until the button
 * stays disabled.
 */
export async function saveAllIfEnabled(page: Page): Promise<void> {
  const button = page.getByTestId("save-all-project");
  await expect(button).toBeVisible();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await button.isEnabled())) {
      return;
    }
    await button.click({ force: true });
    try {
      await expect(button).toBeDisabled({ timeout: 3_000 });
      return;
    } catch {
      // Saved, then something else dirtied the project. Save again.
    }
  }
  await expect(button).toBeDisabled();
}
