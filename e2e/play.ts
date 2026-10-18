import { expect, type ConsoleMessage, type Page } from "@playwright/test";
import { acceptUnsavedPlayPrompts } from "./unsaved-play";

/**
 * Dirty Play shows the Preparing Play dialog before `play-overlay`
 * mounts. Default Playwright visibility (5s) is too tight once save, compile,
 * and Play asset collection (including materials) finish. iPad landscape under
 * a full suite can stay on Compiling for tens of seconds.
 */
const PLAY_OVERLAY_TIMEOUT_MS = 60_000;
export const PREVIEW_BUILD_TIMEOUT_MS = 60_000;

export async function waitForPlayOverlay(page: Page): Promise<void> {
  await expect(page.getByTestId("play-overlay")).toBeVisible({
    timeout: PLAY_OVERLAY_TIMEOUT_MS,
  });
}

/**
 * Turn on Debug-menu overlay buttons beyond the default Stats before Play or
 * Preview Build. The choice persists in Engine Settings for the session.
 */
export async function showOverlayButtons(
  page: Page,
  buttons: readonly ("console" | "inspector" | "profiler")[],
): Promise<void> {
  const trigger = page.getByTestId("debug-menu");
  const submenu = page.getByTestId("play-overlays-submenu");
  for (const button of buttons) {
    const item = page.getByTestId(`overlay-${button}-toggle`);
    // Overlays live in the Debug menu's Overlays submenu.
    if (!(await item.isVisible())) {
      if (!(await submenu.isVisible())) await trigger.click();
      await submenu.click();
    }
    if ((await item.getAttribute("aria-checked")) !== "true") await item.click();
    await expect(item).toHaveAttribute("aria-checked", "true");
  }
  // Escape closes the submenu, then the Debug menu.
  for (let step = 0; step < 3 && (await submenu.isVisible()); step += 1) await page.keyboard.press("Escape");
  await expect(submenu).toBeHidden();
}

/** Click Play and wait until the overlay is up, including a prepare dialog. */
export async function clickPlayAndWaitForOverlay(page: Page): Promise<void> {
  await acceptUnsavedPlayPrompts(page);
  await page.getByTestId("play-preview").click();
  await waitForPlayOverlay(page);
}

type PreviewPlayerState = {
  booted: string | null;
  ticks: number;
  sceneLoading: string | null;
  error: string | null;
  hostError: string | null;
};

const previewPlayerRoot = (page: Page) =>
  page.frameLocator('[data-testid="preview-build-iframe"]').getByTestId("player-root");

/** The player root's boot attributes and the host's error banner; null while the page cannot answer. */
async function previewPlayerState(page: Page): Promise<PreviewPlayerState | null> {
  try {
    const state = await previewPlayerRoot(page).evaluate(
      (root) => ({
        booted: root.dataset.booted ?? null,
        ticks: Number(root.dataset.ticks ?? 0),
        sceneLoading: root.dataset.sceneLoading ?? null,
        error: root.dataset.error ?? null,
      }),
      undefined,
      { timeout: 5_000 },
    );
    const banner = page.getByTestId("preview-build-error");
    const hostError = (await banner.count()) > 0 ? await banner.first().innerText({ timeout: 5_000 }) : null;
    return { ...state, hostError };
  } catch {
    // A page whose thread is held cannot answer; the next poll asks again.
    return null;
  }
}

/**
 * Preview Build packs on the main thread (software GL may transcode PNG).
 * Wait for the overlay, then for the iframe player to be booted with its Scene
 * loaded — not for both inside one 30s `data-booted` assertion from the Preview
 * click.
 *
 * The player reports `data-booted` from its first tick, while its Scene is still
 * loading, and software GL links the Scene's effects on the page's only thread
 * for many seconds, so an assertion made in that window cannot be answered
 * within the 5 s default. The wait polls one snapshot instead, and fails at once
 * with it when the host shows an error, the player records a launch error, or
 * the player stops after ticking (a failed Scene load stops the player and
 * resets `data-booted`, without `data-error`).
 */
export async function waitForPreviewBuildBoot(page: Page) {
  await expect(page.getByTestId("preview-build-overlay")).toBeVisible({
    timeout: PREVIEW_BUILD_TIMEOUT_MS,
  });
  const seen: { state: PreviewPlayerState | null } = { state: null };
  // The player logs why a Scene load failed before it stops.
  const playerErrors: string[] = [];
  const collect = (message: ConsoleMessage) => {
    const text = message.text();
    if (message.type() === "error" && text.startsWith("[player]")) playerErrors.push(text.split("\n")[0]!);
  };
  page.on("console", collect);
  try {
    await expect
      .poll(
        async () => {
          const state = await previewPlayerState(page);
          if (!state) return false;
          seen.state = state;
          if (state.hostError !== null) throw new Error(`Preview Build reported an error: ${state.hostError}`);
          if (state.error) throw new Error(`The Preview Build player failed to start: ${state.error}`);
          if (state.ticks > 0 && state.booted === "false")
            throw new Error("The Preview Build player stopped after it ticked, as a failed Scene load leaves it");
          return state.booted === "true" && state.sceneLoading === "false";
        },
        { timeout: PREVIEW_BUILD_TIMEOUT_MS },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `Preview Build player did not boot and finish loading its Scene: ${error instanceof Error ? error.message : String(error)}; last state ${JSON.stringify(seen.state)}; player errors ${JSON.stringify(playerErrors)}`,
      { cause: error },
    );
  } finally {
    page.off("console", collect);
  }
  return previewPlayerRoot(page);
}
