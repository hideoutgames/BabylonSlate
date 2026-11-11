import { expect, test, type Page } from "@playwright/test";
import { openMinimalTestProject } from "./minimal-project";

async function openExportSettings(page: Page): Promise<void> {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-export").click();
}

async function packageWeb(page: Page): Promise<void> {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("packaging").click();
  await expect(page.getByTestId("packaging-dialog")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByTestId("packaging-package").click();
  await download;
  await expect(page.getByTestId("packaging-dialog").getByRole("status")).toHaveText("Game package downloaded. Check your downloads.", { timeout: 60_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("packaging-dialog")).toHaveCount(0);
}

test("App Identity holds Project Version, and Auto Increment Build Number locks the field and adds 1 after every package", async ({ page }, testInfo) => {
  await openMinimalTestProject(page);
  await openExportSettings(page);
  // Project Version sits in App Identity, under Display Name.
  await expect(page.getByTestId("settings-project-version")).toHaveValue("1.0.0");
  const displayBottom = (await page.getByTestId("setting-app-display-name").boundingBox())!;
  expect((await page.getByTestId("settings-project-version").boundingBox())!.y).toBeGreaterThan(displayBottom.y);
  const buildNumber = page.getByTestId("setting-app-build-number");
  const field = buildNumber.locator("input").or(buildNumber.and(page.locator("input"))).first();
  await expect(field).toHaveValue("1");
  await expect(field).toBeEnabled();
  const toggle = page.getByRole("switch", { name: "Auto Increment Build Number" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(field).toBeDisabled();
  await page.getByTestId("setting-app-build-number-auto").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("auto-build-number.png"), animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-modal")).toHaveCount(0);

  // Web packages carry no Build Number, but every platform's package counts.
  await packageWeb(page);
  await packageWeb(page);
  await openExportSettings(page);
  await expect(field).toHaveValue("3");
  await expect(field).toBeDisabled();
});
