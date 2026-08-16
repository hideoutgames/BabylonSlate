import { expect, type Page } from "@playwright/test";

/**
 * Dirty Play shows the Saving and compiling dialog before `play-overlay`
 * mounts. Default Playwright visibility (5s) is too tight once save, compile,
 * and Play asset collection (including materials) finish. iPad landscape under
 * a full suite can stay on Compiling for tens of seconds.
 */
export const PLAY_OVERLAY_TIMEOUT_MS = 60_000;

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
