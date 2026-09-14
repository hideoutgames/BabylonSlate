import {
  expect,
  test,
  type CDPSession,
  type Locator,
  type Page,
} from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";

// Headless Chromium hides native scrollbars by default; exercise the real thumb.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

async function openTrees(page: Page) {
  await page.goto("/?test=1&gallery=1");
  await page.waitForFunction(() => window.crossOriginIsolated, undefined, {
    timeout: 15_000,
  });
  await expect(page.locator(".slate-loading")).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.getByTestId("gallery-tree-examples").scrollIntoViewIfNeeded();
}

async function center(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

async function touch(
  session: CDPSession,
  type: "touchStart" | "touchMove",
  point: { x: number; y: number },
) {
  await session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: [point],
  });
}

test("TreeView mouse row drag starts immediately while its scrollbar only scrolls", async ({
  page,
}) => {
  await openTrees(page);
  const source = page.getByTestId("tree-row-player-mesh");
  const target = page.getByTestId("tree-row-player-camera");
  const start = await center(source);
  const end = await center(target);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 2 });
  await page.mouse.up();
  await expect(source).toHaveAttribute("aria-level", "4");
  await expect(target).toHaveAttribute("aria-expanded", "true");

  const tree = page.getByTestId("gallery-tree-touch");
  const scrollbar = await tree.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      x: box.right - (box.width - element.clientWidth) / 2,
      y: box.top + 40,
      width: box.width - element.clientWidth,
      scrollable: element.scrollHeight > element.clientHeight,
    };
  });
  expect(scrollbar.scrollable).toBe(true);
  expect(scrollbar.width).toBeGreaterThan(0);
  await page.mouse.move(scrollbar.x, scrollbar.y);
  await page.mouse.down();
  await page.mouse.move(scrollbar.x, scrollbar.y + 90, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(() => tree.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(page.getByTestId("tree-row-touch-player-mesh")).toHaveAttribute(
    "aria-level",
    "3",
  );
  await expect(tree.locator('[data-drop-target="true"]')).toHaveCount(0);
});

test(
  "TreeView native touch swipes scroll and a short hold reparents without scrolling",
  { tag: IPAD_TEST_TAG },
  async ({ page }) => {
    await openTrees(page);
    const tree = page.getByTestId("gallery-tree-touch");
    const source = page.getByTestId("tree-row-touch-player-mesh");
    const target = page.getByTestId("tree-row-touch-player-camera");
    const session = await page.context().newCDPSession(page);
    const swipeStart = await center(target);
    await touch(session, "touchStart", swipeStart);
    for (let step = 1; step <= 6; step++) {
      await touch(session, "touchMove", {
        x: swipeStart.x,
        y: swipeStart.y - step * 15,
      });
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(() => tree.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(30);
    await expect(source).toHaveAttribute("aria-level", "3");
    await expect(target).not.toHaveAttribute("aria-expanded");

    // Stop swipe inertia with a fresh contact, then reset the scroll position for
    // a separate held gesture over two visible rows.
    await touch(session, "touchStart", swipeStart);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await tree.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(() => tree.evaluate((element) => element.scrollTop))
      .toBe(0);
    const start = await center(source);
    const end = await center(target);
    await touch(session, "touchStart", start);
    await page.waitForTimeout(320);
    for (let step = 1; step <= 4; step++) {
      await touch(session, "touchMove", {
        x: start.x + ((end.x - start.x) * step) / 4,
        y: start.y + ((end.y - start.y) * step) / 4,
      });
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await session.detach();
    await expect(source).toHaveAttribute("aria-level", "4");
    await expect(target).toHaveAttribute("aria-expanded", "true");
    expect(await tree.evaluate((element) => element.scrollTop)).toBe(0);
  },
);
