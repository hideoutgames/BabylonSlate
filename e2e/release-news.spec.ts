import { expect, test } from "@playwright/test";
import declared from "../release/version.json" with { type: "json" };
import changelog from "../release/changelog.json" with { type: "json" };

test("release news survives reload and the account menu reopens it offline", async ({ page }) => {
  // Exercise the real web launch, including Pages' QA storage configuration.
  await page.goto("/");
  // News waits for the loading screen so it never opens behind it.
  await expect(page.locator(".slate-loading")).toHaveCount(0, { timeout: 30_000 });
  const news = page.getByRole("dialog", { name: "What's New" });
  await expect(news).toBeVisible();
  await expect(news).toContainText(declared.version);
  const notes = changelog.releases.find(release => release.version === declared.version)!;
  await expect(news).toContainText(notes.changes[0]);
  await news.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("babylonslate:engine-settings") ?? "{}").seenReleaseVersions)).toContain(declared.version);

  await page.reload();
  await expect(page.getByTestId("homepage")).toBeVisible();
  // The homepage mounts before its loading transition finishes.
  await expect(page.locator(".slate-loading")).toHaveCount(0, { timeout: 30_000 });
  await expect(news).toHaveCount(0);
  await page.context().setOffline(true);
  await page.getByTestId("homepage-account").click();
  await page.getByRole("menuitem", { name: "Changelog" }).click();
  const history = page.getByRole("dialog", { name: "Changelog" });
  await expect(history).toContainText(notes.changes[0]);
  await history.getByRole("button", { name: "Done", exact: true }).click();
  await expect(history).toHaveCount(0);
});
