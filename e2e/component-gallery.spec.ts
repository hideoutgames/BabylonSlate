import { expect, test } from "@playwright/test";

test("component gallery renders shadcn primitives in test mode", async ({
  page,
}) => {
  await page.goto("/?test=1&gallery=1");
  await expect(page.getByTestId("component-gallery")).toBeVisible();
  await expect(page.getByTestId("gallery-panel-frame")).toBeVisible();
  await expect(page.getByTestId("gallery-toolbar-strip")).toBeVisible();
  await expect(page.getByText("Primary")).toBeVisible();
  await expect(page.getByTestId("gallery-touch-button")).toBeVisible();
  await expect(page.getByTestId("gallery-toggle-group")).toBeVisible();
  await expect(page.getByTestId("gallery-prefab-tab-note")).toBeVisible();
});

test("gallery catalog dialog does not autofocus search", async ({ page }) => {
  await page.goto("/?test=1&gallery=1");
  await page.getByTestId("gallery-open-catalog").click();
  await expect(page.getByTestId("gallery-catalog")).toBeVisible();
  await expect(page.getByTestId("gallery-catalog").getByText("Rendering")).toBeVisible();
  await expect(page.getByTestId("gallery-catalog-search")).not.toHaveAttribute(
    "data-autofocus-search",
  );
  await expect(page.getByTestId("gallery-catalog-search")).not.toBeFocused();
  await expect(page.getByTestId("gallery-catalog-body")).toBeVisible();
});

test("component gallery renders every editor-kit composite", async ({
  page,
}) => {
  await page.goto("/?test=1&gallery=1");
  await expect(page.getByTestId("gallery-property-grid")).toBeVisible();
  await expect(page.getByTestId("gallery-tree-view")).toBeVisible();
  await expect(page.getByTestId("gallery-tree")).toBeVisible();
  await expect(page.getByTestId("property-gallery-position-x")).toBeVisible();
  await expect(page.getByTestId("gallery-numeric-drag")).toBeVisible();
  await expect(page.getByTestId("gallery-parameter-list")).toBeVisible();

  await page.getByRole("button", { name: "Open search sheet" }).click();
  await expect(page.getByTestId("gallery-search-sheet")).toBeVisible();
});

test("gallery composites meet the minimum touch target size", async ({
  page,
}) => {
  await page.goto("/?test=1&gallery=1");
  const targets = [
    "property-gallery-position-x",
    "property-gallery-speed",
    "property-gallery-mesh",
    "gallery-numeric-drag",
  ];

  for (const testId of targets) {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box, `${testId} should be laid out`).not.toBeNull();
    expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(28);
  }

  const treeRow = page.getByTestId("tree-row-player");
  const rowBox = await treeRow.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(rowBox!.height).toBeGreaterThanOrEqual(32);
});
