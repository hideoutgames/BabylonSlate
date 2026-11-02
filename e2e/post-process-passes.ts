import type { Page } from "@playwright/test";

/**
 * The editor viewport's post-process passes: the project's own (a Scene Linear project's Display Color, effects the
 * project turns on) plus the open Scene's stack. Null until the viewport has a world renderer.
 */
export async function viewportPostProcessPassCount(page: Page): Promise<number | null> {
  return page.evaluate(
    () =>
      (
        globalThis as {
          __hapticViewportTest?: {
            postProcessPassCount: () => number | null;
          };
        }
      ).__hapticViewportTest?.postProcessPassCount() ?? null,
  );
}
