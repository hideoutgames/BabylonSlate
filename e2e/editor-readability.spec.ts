import { expect, test } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openMinimalTestProject } from "./minimal-project";

test.describe("Editor modal readability", { tag: IPAD_TEST_TAG }, () => {
  test("unsaved actions share a height on desktop and touch", async ({
    page,
  }) => {
    await openMinimalTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.class.babasset"]')
      .dblclick();
    await page.getByTestId("prefab-add-component").click();
    await page
      .getByTestId("prefab-add-component-catalog-item-LightComponent")
      .click();
    await page
      .locator('[data-testid="document-tab"][data-document-kind="graph"]')
      .getByTestId("document-tab-close")
      .click();
    await expect(page.getByTestId("dirty-close-dialog")).toBeVisible();
    const buttons = await Promise.all(
      ["dirty-cancel", "dirty-discard", "dirty-save"].map((id) =>
        page.getByTestId(id).boundingBox(),
      ),
    );
    const coarse = await page.evaluate(
      () => matchMedia("(pointer: coarse)").matches,
    );
    for (const button of buttons) {
      expect(button).not.toBeNull();
      expect(button!.height).toBe(buttons[0]!.height);
      expect(button!.height).toBeGreaterThanOrEqual(coarse ? 44 : 28);
      if (!coarse) expect(button!.height).toBeLessThan(44);
    }
    await page.screenshot({
      path: test.info().outputPath("unsaved-actions.png"),
    });
    await page.getByTestId("dirty-cancel").click();
    await expect(page.getByTestId("actor-prefab-panel")).toBeVisible();
  });

  test("dark settings and Add Node use readable boundaries and alternating rows", async ({
    page,
  }) => {
    await openMinimalTestProject(page);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    const settings = page.getByTestId("settings-modal");
    await expect(settings).toBeVisible();
    const selected = settings.locator('.catalog-sidebar [aria-current="true"]');
    const borderWidths = await selected.evaluate((el) => {
      const style = getComputedStyle(el);
      return [style.borderLeftWidth, style.borderRightWidth];
    });
    expect(borderWidths[0]).toBe(borderWidths[1]);
    await page.screenshot({
      path: test.info().outputPath("dark-project-settings.png"),
    });
    await settings.locator('[data-slot="dialog-close"]').click();
    await page
      .locator('[data-asset-path="assets/main.class.babasset"]')
      .dblclick();
    await page.getByTestId("graph-add-node").click();
    const rows = page.locator('[data-testid^="node-palette-item-"]');
    await expect(rows.nth(2)).toBeVisible();
    const colors = await rows.evaluateAll((elements) =>
      elements.slice(0, 3).map((el) => getComputedStyle(el).backgroundColor),
    );
    expect(colors[0]).toBe(colors[2]);
    expect(colors[0]).not.toBe(colors[1]);
    await page.screenshot({
      path: test.info().outputPath("dark-add-node.png"),
    });
  });
});
