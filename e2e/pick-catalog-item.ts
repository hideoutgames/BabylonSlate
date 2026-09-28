import { expect, type Page } from "@playwright/test";

/**
 * Catalog menus window their rows, so an item below the first screen is not
 * mounted until search brings it into the list.
 */
export async function pickCatalogItem(
  page: Page,
  catalogTestId: string,
  itemId: string,
  query: string,
): Promise<void> {
  await page.getByTestId(`${catalogTestId}-search`).fill(query);
  const item = page.getByTestId(`${catalogTestId}-item-${itemId}`);
  await expect(item).toBeVisible();
  await item.click();
}
