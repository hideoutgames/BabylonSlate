import { expect, test } from "@playwright/test";

for (const device of [
  { name: "phone", viewport: { width: 390, height: 844 } },
  { name: "short landscape", viewport: { width: 844, height: 390 } },
  { name: "desktop", viewport: { width: 1280, height: 800 } },
]) {
  test.describe(`Empty Project Browser on ${device.name}`, () => {
    test.use({ viewport: device.viewport });

    test("loads the Metal 3D cards when there are no projects", async ({ page }) => {
      await page.goto("/?test=1");
      // Match the other launcher routes: the COI bootstrap may reload the page
      // after an initial sculpture has already started its reveal transition.
      await page.waitForFunction(() => window.crossOriginIsolated, undefined, {
        timeout: 15_000,
      });
      const empty = page.getByTestId("homepage-projects-empty");
      await expect(empty).toBeVisible();
      const sculpture = empty.locator(".homepage-sculpture");
      await expect(sculpture).toHaveAttribute("data-ready", "true", {
        timeout: 30_000,
      });
      await expect(sculpture).toHaveCSS("opacity", "1");
      await expect(sculpture.locator("canvas")).toBeVisible();
      await expect(empty.locator("img")).toHaveCount(0);
      await expect(page.locator(".slate-loading")).toHaveCount(0);
    });
  });
}
