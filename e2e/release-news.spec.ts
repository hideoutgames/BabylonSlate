import { expect, test } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import declared from "../release/version.json" with { type: "json" };
import changelog from "../release/changelog.json" with { type: "json" };

test("release news survives reload and the account menu reopens it offline", { tag: IPAD_TEST_TAG }, async ({ page }) => {
  // Exercise the real web launch, including Pages' QA storage configuration.
  await page.goto("/");
  const news = page.getByRole("dialog", { name: "What's New" });
  await expect(news).toBeVisible();
  await expect(news).toContainText(declared.version);
  const notes = changelog.releases.find(release => release.version === declared.version)!;
  await expect(news).toContainText(notes.changes[0]);
  await news.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("babylonslate:engine-settings") ?? "{}").seenReleaseVersions)).toContain(declared.version);

  await page.reload();
  await expect(page.getByTestId("homepage")).toBeVisible();
  await expect(page.locator(".slate-loading")).toHaveCount(0);
  await expect(news).toHaveCount(0);
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Changelog" }).click();
  const history = page.getByRole("dialog", { name: "Changelog" });
  await expect(history).toContainText(notes.changes[0]);
  await history.getByRole("button", { name: "Done", exact: true }).click();
  await expect(history).toHaveCount(0);
});
