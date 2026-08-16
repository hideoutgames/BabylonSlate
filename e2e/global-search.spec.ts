import { expect, test } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openTestProject } from "./open-test-project";

test.describe("Global project search", () => {
  test("toolbar search opens a dialog and focuses a scene actor", {
    tag: IPAD_TEST_TAG,
  }, async ({
    page,
  }) => {
    await openTestProject(page);

    const searchButton = page.getByTestId("global-search");
    await expect(searchButton).toBeVisible();
    const box = await searchButton.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(28);
    expect(box!.width).toBeGreaterThanOrEqual(28);

    await searchButton.click();
    await expect(page.getByTestId("global-search-dialog")).toBeVisible();
    await expect(page.getByTestId("global-search-empty")).toBeVisible();

    await page.getByTestId("global-search-query").fill("Cube");
    await expect(page.getByTestId("global-search-group-actor")).toBeVisible();
    await page.locator('[data-testid^="global-search-item-actor:"]').first().click();
    await expect(page.getByTestId("global-search-dialog")).toHaveCount(0);
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(page.getByTestId("tree-row-actor:actor-1")).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 10_000 },
    );
  });

  test("searching a graph node property opens the graph and focuses the node", async ({
    page,
  }) => {
    await openTestProject(page);
    await page.getByTestId("global-search").click();
    await page.getByTestId("global-search-query").fill("Event Begin Play");
    await expect(page.getByTestId("global-search-group-graph-node")).toBeVisible();
    await page
      .locator('[data-testid^="global-search-item-graph-node:"]')
      .first()
      .click();
    await expect(page.getByTestId("document-workspace-graph")).toBeVisible();
    await expect(
      page.locator('.react-flow__node.selected[data-id="event-begin-play"]'),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("dialog stays a fixed tall height and results scroll when they overflow", {
    tag: IPAD_TEST_TAG,
  }, async ({
    page,
  }) => {
    await openTestProject(page);
    await page.getByTestId("global-search").click();

    const dialog = page.getByTestId("global-search-dialog");
    await expect(dialog).toBeVisible();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    const expectedHeight = Math.min(viewport!.height * 0.9, 52 * 16);
    expect(box!.height).toBeGreaterThan(expectedHeight * 0.85);
    expect(box!.height).toBeLessThanOrEqual(expectedHeight + 16);

    await page.getByTestId("global-search-query").fill("a");
    const results = page.getByTestId("global-search-results");
    await expect(results.locator('[data-testid^="global-search-item-"]').first()).toBeVisible();

    const metrics = await results.evaluate((el) => ({
      itemCount: el.querySelectorAll('[data-testid^="global-search-item-"]').length,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(metrics.overflowY).toBe("auto");
    expect(metrics.itemCount).toBeGreaterThan(10);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await results.evaluate((el) => {
      el.scrollTop = 240;
    });
    expect(await results.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
});
