import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";

async function openGallerySlider(page: Page) {
  await page.goto("/?test=1&gallery=1");
  await page.waitForFunction(() => window.crossOriginIsolated, undefined, {
    timeout: 15_000,
  });
  await expect(page.locator(".slate-loading")).toHaveCount(0, {
    timeout: 30_000,
  });
  const slider = page.getByTestId("gallery-slider");
  await slider.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  return slider;
}

async function swipe(
  session: CDPSession,
  from: { x: number; y: number },
  delta: { x: number; y: number },
) {
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [from],
  });
  for (let step = 1; step <= 6; step++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: from.x + (delta.x * step) / 6, y: from.y + (delta.y * step) / 6 },
      ],
    });
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

test(
  "a touch swipe on a slider track scrolls the panel; only the thumb drags",
  { tag: IPAD_TEST_TAG },
  async ({ page }) => {
    const slider = await openGallerySlider(page);
    // The gallery nests ScrollAreas; read the one that contains this slider.
    const scrollTop = () =>
      slider.evaluate(
        (element) =>
          element.closest('[data-slot="scroll-area-viewport"]')!.scrollTop,
      );
    const input = slider.locator('input[type="range"]');
    await expect(input).toHaveValue("0.5");
    const session = await page.context().newCDPSession(page);

    const track = await slider
      .locator('[data-slot="slider-track"]')
      .boundingBox();
    expect(track).not.toBeNull();
    const scrollBefore = await scrollTop();
    // Start well away from the thumb (value 0.5 sits at the middle).
    await swipe(
      session,
      { x: track!.x + track!.width * 0.9, y: track!.y + track!.height / 2 },
      { x: 0, y: -90 },
    );
    await expect
      .poll(scrollTop)
      .toBeGreaterThan(scrollBefore + 30);
    await expect(input).toHaveValue("0.5");

    // Stop swipe inertia with a fresh contact, then drag the thumb itself.
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: track!.x + track!.width * 0.9, y: track!.y }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await slider.evaluate((element) =>
      element.scrollIntoView({ block: "center" }),
    );
    const thumb = await slider
      .locator('[data-slot="slider-thumb"]')
      .boundingBox();
    expect(thumb).not.toBeNull();
    await swipe(
      session,
      { x: thumb!.x + thumb!.width / 2, y: thumb!.y + thumb!.height / 2 },
      { x: track!.width * 0.25, y: 0 },
    );
    await session.detach();
    await expect
      .poll(async () => Number(await input.inputValue()))
      .toBeGreaterThan(0.6);
  },
);
