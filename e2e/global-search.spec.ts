import { expect, test } from "@playwright/test";
import { openTestProject } from "./open-test-project";

test.describe("Global project search", () => {
  test("toolbar search opens a dialog and focuses a scene actor", async ({
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
    await expect(page.getByTestId("tree-row-actor-1")).toHaveAttribute(
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
});
