import { expect, type Page } from "@playwright/test";

/**
 * Click Save All when the project has unsaved documents; no-op when clean.
 * One click, then a short window that must stay clean so a post-save mutation
 * cannot hide behind retries.
 */
export async function saveAllIfEnabled(page: Page): Promise<void> {
  const button = page.getByTestId("save-all-project");
  await expect(button).toBeVisible();
  if (!(await button.isEnabled())) {
    return;
  }
  await page.evaluate(() => {
    (
      globalThis as {
        __babylonslateTest?: { clearDocumentDirtyTrace?: () => void };
      }
    ).__babylonslateTest?.clearDocumentDirtyTrace?.();
  });
  await button.click({ force: true });
  await expect(button).toBeDisabled({ timeout: 8_000 });
  try {
    await expect
      .poll(async () => button.isEnabled(), { timeout: 1_500 })
      .toBe(false);
  } catch (error) {
    const trace = await page.evaluate(() => {
      const host = globalThis as {
        __babylonslateTest?: {
          documentDirtyTrace?: () => { kind: string; id: string }[];
        };
      };
      return host.__babylonslateTest?.documentDirtyTrace?.() ?? [];
    });
    throw new Error(
      `Save All re-dirtied after markAllClean: ${JSON.stringify(trace)}`,
      { cause: error },
    );
  }
}
