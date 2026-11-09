import { expect, test } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";

// Chrome on a Mac and the macOS desktop app (Electron) send this kind of user agent. Babylon turns uniform buffers off
// for any agent matching "Mac OS.+Chrome", and the Scene's light block cannot draw without them.
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

test.use({ userAgent: MAC_CHROME });

test("opens a Scene in Chrome on macOS", async ({ page }) => {
  await openTestProject(page);
  expect(await page.evaluate(() => navigator.userAgent)).toBe(MAC_CHROME);
  await openMainScene(page);
});
