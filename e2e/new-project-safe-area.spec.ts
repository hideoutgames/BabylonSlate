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

interface Layout {
  name: string;
  viewport: { width: number; height: number };
  safe: Insets;
  /** Roughly the software keyboard's height: keys, suggestions and, on iPhone, the form accessory bar. */
  keyboard: number;
}

const LAYOUTS: Layout[] = [
  { name: "iPad landscape", viewport: { width: 1194, height: 834 }, safe: { top: 24, right: 0, bottom: 20, left: 0 }, keyboard: 398 },
  { name: "iPhone portrait", viewport: { width: 393, height: 852 }, safe: { top: 59, right: 0, bottom: 34, left: 0 }, keyboard: 336 },
  { name: "iPhone landscape", viewport: { width: 852, height: 393 }, safe: { top: 0, right: 59, bottom: 21, left: 59 }, keyboard: 240 },
];

async function setSafeArea(page: Page, safe: Insets): Promise<void> {
  await page.addStyleTag({
    content: `:root, .dark { --safe-top: ${safe.top}px; --safe-right: ${safe.right}px; --safe-bottom: ${safe.bottom}px; --safe-left: ${safe.left}px; }`,
  });
}

async function openNewProject(page: Page, layout: Layout): Promise<void> {
  await page.setViewportSize(layout.viewport);
  await page.goto("/?test=1");
  await page.waitForFunction(() => window.crossOriginIsolated, undefined, { timeout: 15_000 });
  await setSafeArea(page, layout.safe);
  await page.getByTestId("create-project").tap();
  await expect(page.getByTestId("create-project-dialog")).toBeVisible();
}

test.describe("New Project within the iOS safe area", () => {
  test.use({ hasTouch: true });
  test.beforeEach(({ page }) => enableTouchLayout(page));

  for (const layout of LAYOUTS) {
    test(`keeps the close button in its header row, clear of the insets, on ${layout.name}`, async ({ page }) => {
      await openNewProject(page, layout);
      const dialog = page.getByTestId("create-project-dialog");
      const bottomInset = layout.viewport.height - layout.safe.bottom;

      for (const step of ["templates", "details"] as const) {
        if (step === "details") await page.getByTestId("create-project-empty").click();
        await expect
          .poll(async () => {
            const [close, header, frame, create] = await Promise.all([
              dialog.locator('[data-slot="dialog-close"]').boundingBox(),
              dialog.locator(".homepage-composer-header").boundingBox(),
              dialog.boundingBox(),
              step === "details" ? dialog.getByTestId("create-project-submit").boundingBox() : null,
            ]);
            if (!close || !header || !frame || (step === "details" && !create)) return null;
            return {
              step,
              belowStatusBar: close.y >= layout.safe.top,
              clearOfRightInset: close.x + close.width <= layout.viewport.width - layout.safe.right + 0.5,
              inHeaderRow: close.y >= header.y - 0.5 && close.y + close.height <= header.y + header.height + 0.5,
              inHeaderWidth: close.x + close.width <= header.x + header.width + 0.5,
              // The frame's padding holds the top inset once; the header row adds none of its own.
              headerOneRowTall: header.height <= 52,
              // Full screen at every size, phones held in landscape included.
              fillsScreen:
                Math.abs(frame.x) <= 0.5 &&
                Math.abs(frame.y) <= 0.5 &&
                Math.abs(frame.width - layout.viewport.width) <= 0.5 &&
                Math.abs(frame.height - layout.viewport.height) <= 0.5,
              // The frame's padding holds the bottom inset once: Create sits just above it, not a second inset higher.
              createOnBottomInset:
                !create || (create.y + create.height <= bottomInset + 0.5 && create.y + create.height >= bottomInset - 16.5),
            };
          })
          .toEqual({
            step,
            belowStatusBar: true,
            clearOfRightInset: true,
            inHeaderRow: true,
            inHeaderWidth: true,
            headerOneRowTall: true,
            fillsScreen: true,
            createOnBottomInset: true,
          });
      }
    });
  }
});

// iOS does not resize the layout viewport for the software keyboard: only the visual viewport shrinks, and
// WebKit pans it just far enough to show the focused field. New Project's frame follows the visual viewport, so
// it must also keep that field in view inside its own scrolling form. Chromium has no such keyboard: the page's
// visualViewport is replaced with one the test drives, over a layout viewport that keeps its size.
async function fakeKeyboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    let keyboard: { height: number; offsetTop: number } | null = null;
    Object.defineProperties(viewport, {
      width: { get: () => window.innerWidth },
      height: { get: () => keyboard?.height ?? window.innerHeight },
      offsetLeft: { get: () => 0 },
      offsetTop: { get: () => keyboard?.offsetTop ?? 0 },
      pageLeft: { get: () => window.scrollX },
      pageTop: { get: () => window.scrollY + (keyboard?.offsetTop ?? 0) },
      scale: { get: () => 1 },
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewport });
    window.addEventListener("resize", () => viewport.dispatchEvent(new Event("resize")));
    const change = (next: typeof keyboard) => {
      keyboard = next;
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
    };
    (window as unknown as { __testKeyboard: unknown }).__testKeyboard = {
      show: (height: number, offsetTop: number) => change({ height, offsetTop }),
      hide: () => change(null),
    };
  });
}

type TestKeyboard = { __testKeyboard: { show(height: number, offsetTop: number): void; hide(): void } };

/** Shows the keyboard under the focused field as WebKit does; returns the visible area in page coordinates. */
async function showKeyboard(page: Page, layout: Layout, fieldTestId: string): Promise<{ top: number; bottom: number }> {
  const field = await page.getByTestId(fieldTestId).boundingBox();
  if (!field) throw new Error(`${fieldTestId} is not laid out`);
  const height = layout.viewport.height - layout.keyboard;
  const top = Math.max(0, Math.min(layout.keyboard, field.y + field.height + 8 - height));
  await page.evaluate(([visible, pan]) => (window as unknown as TestKeyboard).__testKeyboard.show(visible, pan), [height, top] as const);
  return { top, bottom: top + height };
}

function visibleLayout(page: Page, fieldTestId: string, visible: { top: number; bottom: number }) {
  return page.evaluate(
    ({ id, top, bottom }) => {
      const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const frame = box('[data-testid="create-project-dialog"]');
      const close = box('[data-testid="create-project-dialog"] [data-slot="dialog-close"]');
      const form = box('[data-testid="create-project-form"]');
      const field = box(`[data-testid="${id}"]`);
      if (!frame || !close || !form || !field) return null;
      const within = (inner: DOMRect, low: number, high: number) => inner.top >= low - 0.5 && inner.bottom <= high + 0.5;
      return {
        frameIsVisibleArea: Math.abs(frame.top - top) <= 0.5 && Math.abs(frame.bottom - bottom) <= 0.5,
        closeVisible: within(close, top, bottom),
        fieldFocused: document.activeElement?.getAttribute("data-testid") === id,
        // Inside the form's scrollport: above the footer, not scrolled out of the form.
        fieldInForm: within(field, form.top, form.bottom),
        fieldVisible: within(field, top, bottom),
        pageScrolled: window.scrollY !== 0 || (document.scrollingElement?.scrollTop ?? 0) !== 0,
      };
    },
    { id: fieldTestId, ...visible },
  );
}

test.describe("New Project above the iOS keyboard", () => {
  test.use({ hasTouch: true });
  test.beforeEach(async ({ page }) => {
    await enableTouchLayout(page);
    await fakeKeyboard(page);
  });

  for (const layout of LAYOUTS) {
    for (const fieldTestId of ["create-project-name", "create-project-remote-name"]) {
      test(`keeps ${fieldTestId} and the close button in view with Remote chosen, on ${layout.name}`, async ({ page }) => {
        await openNewProject(page, layout);
        await page.getByTestId("create-project-empty").tap();
        // Remote, signed in to test mode's fake GitHub: Host, Owner, Repository Name and Visibility make the form tall.
        await page.getByTestId("create-project-hosting-remote").tap();
        await page.getByTestId("create-project-remote-sign-in-github").tap();
        await page.getByTestId("source-control-link-accept").tap();
        await expect(page.getByTestId("create-project-remote-host")).toContainText("GitHub · test-user", { timeout: 30_000 });

        const field = page.getByTestId(fieldTestId);
        await field.scrollIntoViewIfNeeded();
        await field.tap();
        await expect(field).toBeFocused();
        const visible = await showKeyboard(page, layout, fieldTestId);
        await expect
          .poll(() => visibleLayout(page, fieldTestId, visible))
          .toEqual({
            frameIsVisibleArea: true,
            closeVisible: true,
            fieldFocused: true,
            fieldInForm: true,
            fieldVisible: true,
            pageScrolled: false,
          });

        if (fieldTestId !== "create-project-name") return;
        // Options, tapped while the keyboard is up, opens in place; the keyboard then closes.
        const dialog = page.getByTestId("create-project-dialog");
        const options = dialog.locator(".homepage-project-options");
        await options.locator("summary").scrollIntoViewIfNeeded();
        await options.locator("summary").tap();
        await page.evaluate(() => (window as unknown as TestKeyboard).__testKeyboard.hide());
        await expect(options).toHaveAttribute("open", "");
        await expect(dialog).toBeVisible();
        await expect(dialog.getByTestId("create-project-width")).toBeVisible();
      });
    }
  }
});
