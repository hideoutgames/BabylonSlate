import type { Page } from "@playwright/test";

const handled = new WeakSet<Page>();

/**
 * Play asks before saving unsaved edits. Specs written before that prompt
 * expect Play to save first, so answer it with Save & Play whenever it
 * appears. A spec that exercises the prompt itself can remove the handler
 * with `page.removeLocatorHandler(unsavedPlayDialog(page))`.
 */
export async function acceptUnsavedPlayPrompts(page: Page): Promise<void> {
  if (handled.has(page)) return;
  handled.add(page);
  await page.addLocatorHandler(unsavedPlayDialog(page), async () => {
    await page.getByTestId("play-unsaved-save").click();
  });
}

export function unsavedPlayDialog(page: Page) {
  return page.getByTestId("play-unsaved-dialog");
}
