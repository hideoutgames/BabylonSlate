import { expect, test } from "@playwright/test";

test("gallery primitives, dialogs, and editor composites", async ({ page }) => {
  await page.goto("/?test=1&gallery=1");
  await test.step("component gallery renders shadcn primitives in test mode", async () => {
    await expect(page.getByTestId("component-gallery")).toBeVisible();
    await expect(page.getByTestId("gallery-panel-frame")).toBeVisible();
    await expect(page.getByTestId("gallery-toolbar-strip")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Primary", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("gallery-touch-button")).toBeVisible();
    await expect(page.getByTestId("gallery-toggle-group")).toBeVisible();
    await expect(page.getByTestId("gallery-prefab-tab-note")).toBeVisible();
    await expect(page.getByTestId("property-gallery-mesh-open")).toHaveCount(0);
    await expect(
      page.getByTestId("property-gallery-texture-open"),
    ).toBeVisible();
    await expect(page.getByTestId("gallery-texture-picker-open")).toBeVisible();
  });
  await test.step("gallery danger dialog uses a solid destructive confirm", async () => {
    await page.getByTestId("gallery-danger-dialog-open").click();
    const dialog = page.getByTestId("gallery-danger-dialog");
    const confirm = page.getByTestId("gallery-danger-dialog-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("data-variant", "destructive");
    await expect(page.getByTestId("gallery-danger-dialog-media")).toBeVisible();
    await expect(confirm).toHaveClass(/bg-destructive/);
    await expect(confirm).not.toHaveClass(/bg-destructive\/10/);
    await expect(confirm).toHaveClass(/text-destructive-foreground/);
    await page.keyboard.press("Escape");
  });
  await test.step("gallery catalog dialog does not autofocus search", async () => {
    await page.getByTestId("gallery-open-catalog").click();
    await expect(page.getByTestId("gallery-catalog")).toBeVisible();
    await expect(
      page.getByTestId("gallery-catalog").getByText("Rendering"),
    ).toBeVisible();
    await expect(page.getByTestId("gallery-catalog-search")).not.toBeFocused();
    await expect(page.getByTestId("gallery-catalog-body")).toBeVisible();
    await page.keyboard.press("Escape");
  });
  await test.step("component gallery renders every editor-kit composite", async () => {
    await expect(page.getByTestId("gallery-property-grid")).toBeVisible();
    await expect(page.getByTestId("gallery-atlas-tile-grid")).toBeVisible();
    await expect(page.getByTestId("gallery-type-visuals")).toBeVisible();
    await expect(page.getByTestId("gallery-tree-view")).toBeVisible();
    await expect(page.getByTestId("gallery-tree")).toBeVisible();
    await expect(page.getByTestId("property-gallery-position-x")).toBeVisible();
    await expect(
      page.getByTestId("property-gallery-friction-slider"),
    ).toBeVisible();
    await expect(
      page.getByTestId("property-gallery-layer-bit-0"),
    ).toBeVisible();
    await expect(page.getByTestId("property-gallery-tint-hex")).toBeVisible();
    await expect(page.getByTestId("gallery-slider")).toBeVisible();
    await expect(page.getByTestId("gallery-numeric-drag")).toBeVisible();
    await expect(page.getByTestId("gallery-parameter-list")).toBeVisible();
    await expect(
      page.getByTestId("gallery-variable-type-fields"),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("gallery-variable-type-fields")
        .locator('[data-pin-shape="list"]'),
    ).toBeVisible();
    await expect(
      page
        .getByTestId("gallery-variable-type-fields")
        .locator('[data-pin-shape="map"]'),
    ).toBeVisible();
    await expect(page.getByTestId("gallery-entry-list")).toBeVisible();
    await expect(page.getByTestId("gallery-entry-list-count")).toHaveText(
      "2 items",
    );
    await expect(page.getByTestId("gallery-nested-menu")).toBeVisible();
    await expect(page.getByTestId("gallery-nested-overlay")).toBeVisible();

    await page.getByRole("button", { name: "Open search dropdown" }).click();
    await expect(page.getByTestId("gallery-search-dropdown")).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(page.getByTestId("gallery-markup-autocomplete")).toBeVisible();
    await page.getByTestId("gallery-markup-autocomplete").click();
    await expect(
      page.getByTestId("gallery-markup-autocomplete-editor-suggestions"),
    ).toBeVisible();
    await expect(page.getByTestId("search-item-tag:b")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Open search dialog" }).click();
    await expect(page.getByTestId("gallery-search-dialog")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByTestId("gallery-nested-menu").click();
    await expect(page.getByTestId("gallery-nested-menu-content")).toBeVisible();
    await page.getByTestId("context-menu-item-more").click();
    await expect(page.getByTestId("context-menu-sub-more")).toBeVisible();
  });
});
