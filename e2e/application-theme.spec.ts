import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { WEBKIT_SMOKE_TAG } from "./ipad-tag";
import { expect, test } from "./profile-context";

async function openApplicationSettings(page: Page) {
  await page.goto("/");
  await expect(page.locator(".slate-loading")).toHaveCount(0, { timeout: 30_000 });
  await page.getByTestId("homepage-account").click();
  await page.getByTestId("homepage-account-open").click();
  const center = page.getByTestId("homepage-account-center");
  await center.getByTestId("homepage-account-center-category-application").click();
  await expect(center.getByTestId("application-theme")).toBeVisible();
  return center;
}

// WebKit (iPad Safari and the iOS app) kept the header in the frame's border, where its
// touch-layout button took no taps; Chromium never showed it, so this runs in the WebKit lane too.
test("Application Settings opens and closes the theme Style section", { tag: WEBKIT_SMOKE_TAG }, async ({ page }) => {
  const center = await openApplicationSettings(page);
  const style = center.getByRole("button", { name: "Style", exact: true });
  const background = center.getByLabel("Background Hex", { exact: true });
  await expect(style).toHaveAttribute("aria-expanded", "false");
  await expect(background).toHaveCount(0);

  await style.click();
  await expect(style).toHaveAttribute("aria-expanded", "true");
  await expect(background).toBeVisible();
  await expect(center.getByRole("button", { name: "Surfaces", exact: true })).toBeVisible();

  await style.click();
  await expect(style).toHaveAttribute("aria-expanded", "false");
  await expect(background).toHaveCount(0);
});

test("Export Theme downloads the selected theme as a theme file", async ({ page }) => {
  const center = await openApplicationSettings(page);
  const downloading = page.waitForEvent("download");
  await center.getByTestId("application-theme-export").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("Haptic_Dark.haptic-theme.json");
  const theme = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(theme).toMatchObject({ format: "haptic-editor-theme", name: "Haptic Dark" });
  await expect(center.getByTestId("application-theme-notice")).toHaveText(
    "Haptic Dark downloaded. Check your downloads.",
  );

  // The file holds the colors the Style section shows.
  await center.getByRole("button", { name: "Style", exact: true }).click();
  expect(theme.colors.background).toBe(await center.getByLabel("Background Hex", { exact: true }).inputValue());
});
