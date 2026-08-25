import { expect, type Page } from "@playwright/test";

/**
 * Dirty Play shows the Saving and compiling dialog before `play-overlay`
 * mounts. Default Playwright visibility (5s) is too tight once save, compile,
 * and Play asset collection (including materials) finish. iPad landscape under
 * a full suite can stay on Compiling for tens of seconds.
 */
export const PLAY_OVERLAY_TIMEOUT_MS = 60_000;
export const PREVIEW_BUILD_TIMEOUT_MS = 60_000;

export async function waitForPlayOverlay(page: Page): Promise<void> {
  await expect(page.getByTestId("play-overlay")).toBeVisible({
    timeout: PLAY_OVERLAY_TIMEOUT_MS,
  });
}

/** Click Play and wait until the overlay is up, including a prepare dialog. */
export async function clickPlayAndWaitForOverlay(page: Page): Promise<void> {
  await page.getByTestId("play-preview").click();
  await waitForPlayOverlay(page);
}

/**
 * Preview Build packs on the main thread (software GL may transcode PNG).
 * Wait for the overlay, then for the iframe player to tick — not for both
 * inside one 30s `data-booted` assertion from the Preview click.
 */
export async function waitForPreviewBuildBoot(page: Page) {
  await expect(page.getByTestId("preview-build-overlay")).toBeVisible({
    timeout: PREVIEW_BUILD_TIMEOUT_MS,
  });
  await expect(page.getByTestId("preview-build-error")).toHaveCount(0);
  const root = page
    .frameLocator('[data-testid="preview-build-iframe"]')
    .getByTestId("player-root");
  await expect(root).toHaveAttribute("data-booted", "true", {
    timeout: PREVIEW_BUILD_TIMEOUT_MS,
  });
  await expect(root).not.toHaveAttribute("data-error", /.+/);
  return root;
}
