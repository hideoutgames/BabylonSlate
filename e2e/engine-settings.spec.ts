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
