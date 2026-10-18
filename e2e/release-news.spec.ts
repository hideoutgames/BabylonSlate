import { expect, test, type Page } from "@playwright/test";
import declared from "../release/version.json" with { type: "json" };
import changelog from "../release/changelog.json" with { type: "json" };
import { patchNotesMarkdown } from "../scripts/distribution/changelog.mjs";

const RELEASES = "https://api.github.com/repos/hideoutgames/BabylonSlate/releases*";
const notes = changelog.releases.find(release => release.version === declared.version)!;

/** Release notes come from GitHub Releases; route them so the spec never reaches GitHub. */
async function routeReleases(page: Page, respond: "notes" | "fail") {
  const requests: string[] = [];
  // Context routes also see requests the COI service worker re-issues.
  await page.context().route(RELEASES, route => {
    requests.push(route.request().url());
    if (respond === "fail") return route.abort();
    return route.fulfill({
      json: [{
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00Z",
        body: `${patchNotesMarkdown(notes)}\n\nHaptic ${declared.version}\nChannel: Release`,
      }],
    });
  });
  return requests;
}

async function openChangelog(page: Page) {
  // The homepage mounts before its loading transition finishes.
  await expect(page.locator(".slate-loading")).toHaveCount(0, { timeout: 30_000 });
  await page.getByTestId("homepage-account").click();
  await page.getByRole("menuitem", { name: "Changelog" }).click();
  return page.getByRole("dialog", { name: "Changelog" });
}

test("release news from GitHub Releases shows once per version and the account menu reopens it", async ({ page }) => {
  const requests = await routeReleases(page, "notes");
  // Exercise the real web launch, including Pages' QA storage configuration.
  await page.goto("/");
  // News waits for the loading screen so it never opens behind it.
  await expect(page.locator(".slate-loading")).toHaveCount(0, { timeout: 30_000 });
  const news = page.getByRole("dialog", { name: "What's New" });
  await expect(news).toBeVisible();
  await expect(news).toContainText(declared.version);
  await expect(news).toContainText(notes.changes[0]);
  await news.getByRole("button", { name: "Done", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("babylonslate:engine-settings") ?? "{}").seenReleaseVersions)).toContain(declared.version);

  await page.reload();
  await expect(page.getByTestId("homepage")).toBeVisible();
  const history = await openChangelog(page);
  await expect(news).toHaveCount(0);
  await expect(history).toContainText(notes.changes[0]);
  const loads = requests.length;
  await history.getByRole("button", { name: "Done", exact: true }).click();
  await expect(history).toHaveCount(0);
  // Reopening reuses this launch's request instead of fetching again.
  await (await openChangelog(page)).getByRole("button", { name: "Done", exact: true }).click();
  expect(requests).toHaveLength(loads);
});

test("a failed release notes request shows no news and says so in the Changelog", async ({ page }) => {
  await routeReleases(page, "fail");
  await page.goto("/");
  const history = await openChangelog(page);
  await expect(history.getByTestId("release-news-failed")).toContainText("Failed To Load Patch Notes");
  await expect(page.getByRole("dialog", { name: "What's New" })).toHaveCount(0);
});
