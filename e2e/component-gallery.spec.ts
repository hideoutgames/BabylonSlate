import { expect, test } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";

test("component gallery renders shadcn primitives in test mode", async ({
  page,
}) => {
  await page.goto("/?test=1&gallery=1");
  await expect(page.getByTestId("component-gallery")).toBeVisible();
  await expect(page.getByTestId("gallery-panel-frame")).toBeVisible();
  await expect(page.getByTestId("gallery-toolbar-strip")).toBeVisible();
  await expect(page.getByText("Primary")).toBeVisible();
  await expect(page.getByTestId("gallery-touch-button")).toBeVisible();
  await expect(page.getByTestId("gallery-toggle-group")).toBeVisible();
  await expect(page.getByTestId("gallery-prefab-tab-note")).toBeVisible();
});

test("gallery danger dialog uses a solid destructive confirm", async ({
  page,
}) => {
  await page.goto("/?test=1&gallery=1");
  await page.getByTestId("gallery-danger-dialog-open").click();
  const dialog = page.getByTestId("gallery-danger-dialog");
  const confirm = page.getByTestId("gallery-danger-dialog-confirm");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-variant", "destructive");
  await expect(page.getByTestId("gallery-danger-dialog-media")).toBeVisible();
  await expect(confirm).toHaveClass(/bg-destructive/);
  await expect(confirm).not.toHaveClass(/bg-destructive\/10/);
  await expect(confirm).toHaveClass(/text-destructive-foreground/);
});

test("gallery catalog dialog does not autofocus search", async ({ page }) => {
  await page.goto("/?test=1&gallery=1");
  await page.getByTestId("gallery-open-catalog").click();
  await expect(page.getByTestId("gallery-catalog")).toBeVisible();
  await expect(page.getByTestId("gallery-catalog").getByText("Rendering")).toBeVisible();
  await expect(page.getByTestId("gallery-catalog-search")).not.toHaveAttribute(
    "data-autofocus-search",
  );
  await expect(page.getByTestId("gallery-catalog-search")).not.toBeFocused();
  await expect(page.getByTestId("gallery-catalog-body")).toBeVisible();
});

test("component gallery renders every editor-kit composite", async ({
  page,
}) => {
  await page.goto("/?test=1&gallery=1");
  await expect(page.getByTestId("gallery-property-grid")).toBeVisible();
  await expect(page.getByTestId("gallery-atlas-tile-grid")).toBeVisible();
  await expect(page.getByTestId("gallery-type-visuals")).toBeVisible();
  await expect(page.getByTestId("gallery-tree-view")).toBeVisible();
  await expect(page.getByTestId("gallery-tree")).toBeVisible();
  await expect(page.getByTestId("property-gallery-position-x")).toBeVisible();
  await expect(page.getByTestId("property-gallery-friction-slider")).toBeVisible();
  await expect(page.getByTestId("property-gallery-layer-bit-0")).toBeVisible();
  await expect(page.getByTestId("property-gallery-tint-hex")).toBeVisible();
  await expect(page.getByTestId("gallery-slider")).toBeVisible();
  await expect(page.getByTestId("gallery-numeric-drag")).toBeVisible();
  await expect(page.getByTestId("gallery-parameter-list")).toBeVisible();
  await expect(page.getByTestId("gallery-nested-menu")).toBeVisible();
  await expect(page.getByTestId("gallery-nested-overlay")).toBeVisible();

  await page.getByRole("button", { name: "Open search dropdown" }).click();
  await expect(page.getByTestId("gallery-search-dropdown")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Open search dialog" }).click();
  await expect(page.getByTestId("gallery-search-dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByTestId("gallery-nested-menu").click();
  await expect(page.getByTestId("gallery-nested-menu-content")).toBeVisible();
  await page.getByTestId("context-menu-item-more").click();
  await expect(page.getByTestId("context-menu-sub-more")).toBeVisible();
});

test("gallery body scrolls on touch", { tag: IPAD_TEST_TAG }, async ({ page }) => {
  await page.goto("/?test=1&gallery=1");
  await expect(page.getByTestId("component-gallery")).toBeVisible();

  const result = await page.evaluate(() => {
    const viewport = document.querySelector('[data-slot="scroll-area-viewport"]');
    if (!viewport) return { ok: false, reason: "missing viewport" };

    const scrollable = viewport.scrollHeight > viewport.clientHeight;
    const overflowY = getComputedStyle(viewport).overflowY;
    const overflowAllowsScroll = ["auto", "scroll", "overlay"].includes(overflowY);
    if (!scrollable || !overflowAllowsScroll) {
      return {
        ok: false,
        reason: "viewport not scrollable",
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        overflowY,
      };
    }

    viewport.scrollTop = 0;
    const rect = viewport.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const startY = rect.top + rect.height * 0.75;
    const endY = rect.top + rect.height * 0.25;
    const touchTarget = viewport.querySelector("h2") ?? viewport;

    const makeTouch = (clientY: number) =>
      new Touch({
        identifier: 1,
        target: touchTarget,
        clientX: x,
        clientY,
      });

    const startTouch = makeTouch(startY);
    const moveTouch = makeTouch(endY);

    touchTarget.dispatchEvent(
      new TouchEvent("touchstart", {
        bubbles: true,
        cancelable: true,
        touches: [startTouch],
        targetTouches: [startTouch],
        changedTouches: [startTouch],
      }),
    );
    const moveEvent = new TouchEvent("touchmove", {
      bubbles: true,
      cancelable: true,
      touches: [moveTouch],
      targetTouches: [moveTouch],
      changedTouches: [moveTouch],
    });
    const prevented = !touchTarget.dispatchEvent(moveEvent);

    return { ok: !prevented, prevented, scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight };
  });

  expect(result.ok, JSON.stringify(result)).toBe(true);
});

test("gallery composites meet the minimum touch target size", {
  tag: IPAD_TEST_TAG,
}, async ({
  page,
}) => {
  await page.goto("/?test=1&gallery=1");
  const targets = [
    "property-gallery-position-x",
    "property-gallery-speed",
    "property-gallery-friction-slider",
    "property-gallery-layer-bit-0",
    "property-gallery-mesh",
    "gallery-numeric-drag",
    "gallery-slider",
  ];

  for (const testId of targets) {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box, `${testId} should be laid out`).not.toBeNull();
    expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(
      testId.includes("slider") || testId.includes("layer-bit") ? 44 : 28,
    );
  }

  const treeRow = page.getByTestId("tree-row-player");
  const rowBox = await treeRow.boundingBox();
  expect(rowBox).not.toBeNull();
  expect(rowBox!.height).toBeGreaterThanOrEqual(28);
});
