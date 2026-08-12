import { expect, test } from "@playwright/test";

test.describe("Editor appearance theme", () => {
  test("Engine Settings Light and Dark toggle html.dark", async ({ page }) => {
    await page.goto("/?test=1");
    await expect(page.getByTestId("homepage")).toBeVisible();
    await expect(page.getByTestId("brand-logo")).toBeVisible();

    await page.getByTestId("engine-settings").click();
    await expect(page.getByTestId("engine-settings-modal")).toBeVisible();
    await expect(page.getByTestId("setting-theme")).toBeVisible();

    await page.getByTestId("setting-theme").click();
    await page.getByTestId("setting-theme-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await page.getByTestId("setting-theme").click();
    await page.getByTestId("setting-theme-dark").click();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("gallery stays readable in light mode", async ({ page }) => {
    await page.goto("/?test=1");
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page.getByTestId("engine-settings").click();
    await expect(page.getByTestId("engine-settings-modal")).toBeVisible();
    await page.getByTestId("setting-theme").click();
    await page.getByTestId("setting-theme-light").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);

    await page.goto("/?test=1&gallery=1");
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(page.getByTestId("component-gallery")).toBeVisible();
    await expect(page.getByTestId("gallery-panel-frame")).toBeVisible();
    await expect(page.getByText("Primary")).toBeVisible();
  });
});
