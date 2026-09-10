import { expect, test } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";

test(
  "viewport island and Transform inputs stay compact and commit arithmetic",
  {
    tag: IPAD_TEST_TAG,
  },
  async ({ page }) => {
    await openMinimalTestProject(page);
    await openMainScene(page);
    const toolbar = page.getByTestId("viewport-toolbar");
    await expect(toolbar).toBeVisible();
    const heights = await toolbar.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => ({
        label: button.getAttribute("aria-label"),
        height: button.getBoundingClientRect().height,
      })),
    );
    const moveHeight = heights.find(({ label }) => label === "Move")!.height;
    expect(moveHeight).toBeLessThanOrEqual(30);
    for (const label of ["Snap Grid", "Drop", "Viewport Settings"]) {
      expect(
        heights.find((button) => button.label === label)?.height,
        label,
      ).toBe(moveHeight);
    }

    const mode = page.getByTestId("viewport-mode-toggle");
    await expect(mode).toHaveText("3D");
    await mode.click();
    await expect(mode).toHaveText("2D");
    await expect(page.getByTestId("save-all-dirty")).toBeVisible();
    await page.getByTestId("undo-document").click();
    await expect(mode).toHaveText("3D");

    await page.getByTestId("tree-row-actor:actor-1").click();
    const position = page.getByTestId("property-actor-position-x");
    await expect(position).toBeVisible();
    const metrics = await position.evaluate((input) => {
      const style = getComputedStyle(input);
      return {
        height: input.getBoundingClientRect().height,
        font: parseFloat(style.fontSize),
        padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
        width: input.clientWidth,
        scrollWidth: input.scrollWidth,
      };
    });
    expect(metrics.height).toBeLessThanOrEqual(30);
    expect(metrics.font).toBeLessThanOrEqual(13);
    expect(metrics.padding).toBeLessThanOrEqual(12);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width);
    await position.fill("30/2");
    await position.press("Enter");
    await expect(position).toHaveValue("15");
    await position.focus();
    await expect(position).toHaveValue("15");
  },
);
