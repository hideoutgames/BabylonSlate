import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test as base, type BrowserContext } from "@playwright/test";

export { expect };

/**
 * Safari's engine gives an ephemeral browser context no origin-private file
 * system: `navigator.storage.getDirectory()` rejects, so the editor, which
 * never falls back to volatile project storage, cannot create a project, and
 * Playwright makes every test context ephemeral. The WebKit smoke lane sets
 * `profileContext` so each test runs in an on-disk profile instead, the way a
 * Safari window stores its data. Chromium needs none of this.
 */
export const test = base.extend<{ profileContext: boolean }>({
  profileContext: [false, { option: true }],
  // The second argument is Playwright's `use`; the name differs so the React
  // hooks lint rule does not mistake it for a hook.
  context: async ({ baseURL, browser, browserName, playwright, profileContext }, provide) => {
    if (!profileContext) {
      const context = await browser.newContext();
      await provide(context);
      await context.close();
      return;
    }
    const profile = await mkdtemp(path.join(tmpdir(), "bl-profile-"));
    const context = await playwright[browserName].launchPersistentContext(profile);
    try {
      await emptyOriginPrivateFileSystem(context, baseURL);
      await provide(context);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
});

/**
 * WebKit keeps the origin-private file system outside the profile directory, so
 * every profile of one browser installation shares it for an origin. Empty it
 * so a test never finds the project a previous test created.
 */
async function emptyOriginPrivateFileSystem(
  context: BrowserContext,
  baseURL: string | undefined,
): Promise<void> {
  if (!baseURL) throw new Error("profileContext requires a baseURL.");
  const origin = new URL(baseURL).origin;
  const page = await context.newPage();
  try {
    await page.route(`${origin}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto(`${origin}/`);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const entries = root as unknown as { keys(): AsyncIterable<string> };
      const names: string[] = [];
      for await (const name of entries.keys()) names.push(name);
      for (const name of names) await root.removeEntry(name, { recursive: true });
    });
  } finally {
    await page.close();
  }
}
