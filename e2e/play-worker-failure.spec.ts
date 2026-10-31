import { WEBKIT_SMOKE_TAG } from "./ipad-tag";
import { openMainScene, openTestProject } from "./open-test-project";
import { acceptUnsavedPlayPrompts } from "./unsaved-play";
import { expect, test } from "./profile-context";

test("Play ends with its cause when the game worker's module throws while evaluating, instead of waiting at Preparing Scene", {
  tag: WEBKIT_SMOKE_TAG,
}, async ({ page }) => {
  test.setTimeout(90_000);
  // The game worker's module loads, then throws at its top level, so its own error handlers never install. (Request
  // routing does not reach a module worker's script, so the page swaps the module the game worker is created from.)
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        const failing = String(url).includes("worker-entry")
          ? URL.createObjectURL(new Blob(["throw new Error(\"worker module evaluation failed\");\n"], { type: "text/javascript" }))
          : url;
        super(failing, options);
      }
    };
  });
  await openTestProject(page);
  await openMainScene(page);
  await acceptUnsavedPlayPrompts(page);
  await page.getByTestId("play-preview").click();
  // The session ends on its own and the report names the cause.
  await expect(page.getByTestId("preview-session-report")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  await expect(page.getByTestId("play-last-runtime")).toHaveAttribute("data-mode", "worker");
  for (const toggle of await page.getByTestId("session-report-group-toggle").all()) await toggle.click();
  await expect(page.getByTestId("session-report-row").filter({ hasText: "The Play worker failed to start" })).toHaveCount(1);
  await expect(page.getByTestId("session-report-row").filter({ hasText: "worker module evaluation failed" })).toHaveCount(1);
  // The live build is this page's own: the report keeps the worker's own cause and offers no Reload.
  await expect(page.getByTestId("session-report-row").filter({ hasText: "out of date" })).toHaveCount(0);
  await expect(page.getByTestId("session-report-reload")).toHaveCount(0);
});

test("Play says the editor is out of date and offers Reload when a newer deploy removed its worker's files", async ({ page }) => {
  test.setTimeout(90_000);
  // A deploy since this page loaded: the worker's hashed file is gone (a real 404), and the live index names a new entry.
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(String(url).includes("worker-entry") ? new URL("/assets/worker-entry-removed0.js", location.href) : url, options);
      }
    };
  });
  await openTestProject(page);
  await openMainScene(page);
  const origin = new URL(page.url()).origin;
  const deployed = async (route: import("@playwright/test").Route) => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><script type="module" crossorigin src="/assets/index-NewBuild1.js"></script>',
  });
  // A context route: the editor's cross-origin-isolation service worker makes the page's fetches, and only a context
  // route reaches a service worker's requests.
  await page.context().route(`${origin}/`, deployed);
  await acceptUnsavedPlayPrompts(page);
  await page.getByTestId("play-preview").click();
  await expect(page.getByTestId("preview-session-report")).toBeVisible({ timeout: 30_000 });
  for (const toggle of await page.getByTestId("session-report-group-toggle").all()) await toggle.click();
  await expect(page.getByTestId("session-report-row").filter({ hasText: "The editor is out of date" })).toHaveCount(1);
  // Reload loads the deployed build into this tab.
  await page.context().unroute(`${origin}/`, deployed);
  await page.evaluate(() => { (window as unknown as { beforeReload?: boolean }).beforeReload = true; });
  await Promise.all([page.waitForEvent("load"), page.getByTestId("session-report-reload").click()]);
  expect(await page.evaluate(() => (window as unknown as { beforeReload?: boolean }).beforeReload)).toBeUndefined();
});
