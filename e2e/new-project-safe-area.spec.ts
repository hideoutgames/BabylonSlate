import { expect, test, type Page } from "@playwright/test";
import { enableTouchLayout } from "./open-test-project";

// iOS draws the status bar, notch and home indicator over the web view. New Project is a full-screen frame
// padded by the safe-area insets, and absolute positioning ignores padding, so its close button must add the
// insets itself to stay in its header row instead of under the status bar.

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const LAYOUTS: { name: string; viewport: { width: number; height: number }; safe: Insets }[] = [
  { name: "iPad landscape", viewport: { width: 1194, height: 834 }, safe: { top: 24, right: 0, bottom: 20, left: 0 } },
  { name: "iPhone portrait", viewport: { width: 393, height: 852 }, safe: { top: 59, right: 0, bottom: 34, left: 0 } },
  { name: "iPhone landscape", viewport: { width: 852, height: 393 }, safe: { top: 0, right: 59, bottom: 21, left: 59 } },
];

async function setSafeArea(page: Page, safe: Insets): Promise<void> {
  await page.addStyleTag({
    content: `:root, .dark { --safe-top: ${safe.top}px; --safe-right: ${safe.right}px; --safe-bottom: ${safe.bottom}px; --safe-left: ${safe.left}px; }`,
  });
}

test.describe("New Project within the iOS safe area", () => {
  test.use({ hasTouch: true });
  test.beforeEach(({ page }) => enableTouchLayout(page));

  for (const layout of LAYOUTS) {
    test(`keeps the close button in its header row, clear of the insets, on ${layout.name}`, async ({ page }) => {
      await page.setViewportSize(layout.viewport);
      await page.goto("/?test=1");
      await page.waitForFunction(() => window.crossOriginIsolated, undefined, { timeout: 15_000 });
      await setSafeArea(page, layout.safe);
      await page.getByTestId("create-project").click();
      const dialog = page.getByTestId("create-project-dialog");
      await expect(dialog).toBeVisible();

      for (const step of ["templates", "details"] as const) {
        if (step === "details") await page.getByTestId("create-project-empty").click();
        await expect
          .poll(async () => {
            const [close, header] = await Promise.all([
              dialog.locator('[data-slot="dialog-close"]').boundingBox(),
              dialog.locator(".homepage-composer-header").boundingBox(),
            ]);
            if (!close || !header) return null;
            return {
              step,
              belowStatusBar: close.y >= layout.safe.top,
              clearOfRightInset: close.x + close.width <= layout.viewport.width - layout.safe.right + 0.5,
              inHeaderRow: close.y >= header.y - 0.5 && close.y + close.height <= header.y + header.height + 0.5,
              inHeaderWidth: close.x + close.width <= header.x + header.width + 0.5,
              // The frame's padding holds the top inset once; the header row adds none of its own.
              headerOneRowTall: header.height <= 52,
            };
          })
          .toEqual({
            step,
            belowStatusBar: true,
            clearOfRightInset: true,
            inHeaderRow: true,
            inHeaderWidth: true,
            headerOneRowTall: true,
          });
      }
    });
  }
});
