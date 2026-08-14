import { expect, test } from "@playwright/test";

test("viewport frame cap can be emptied then retyped", async ({ page }) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-viewport").click();

  const field = page.getByTestId("setting-frame-cap");
  await expect(field).toHaveValue("60");
  await field.click();
  await field.press("End");
  await field.press("Backspace");
  await field.press("Backspace");
  await expect(field).toHaveValue("");
  await field.pressSequentially("30");
  await expect(field).toHaveValue("30");
});

test("graph default zoom shows 0.5", async ({ page }) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-graph").click();

  const field = page.getByTestId("setting-graph-default-zoom");
  await expect(field).toHaveValue("0.5");
});

test("User Interface category can add a custom designer preset", async ({
  page,
}) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-ui").click();

  await expect(page.getByTestId("ui-preset-builtin-desktop-16-9")).toBeVisible();
  await page.getByTestId("ui-preset-add").click();
  await expect(page.locator('[data-testid^="ui-preset-custom-"]')).toHaveCount(1);
});

test("Focus keep-list can add a Class tab", async ({ page }) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-focus").click();

  await expect(page.getByTestId("focus-keep-graph-graph")).toBeVisible();
  await expect(page.getByTestId("focus-keep-scene-viewport")).toBeVisible();
  await page.getByTestId("focus-keep-graph-add").click();
  await page.getByTestId("focus-keep-graph-add-inspector").click();
  await expect(page.getByTestId("focus-keep-graph-inspector")).toBeVisible();
});

test("create project dialog defaults to 1920×1080 stretch", async ({ page }) => {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("create-project").click();
  await expect(page.getByTestId("create-project-width")).toHaveValue("1920");
  await expect(page.getByTestId("create-project-height")).toHaveValue("1080");
  await expect(page.getByTestId("create-project-black-bars")).toBeVisible();
});
