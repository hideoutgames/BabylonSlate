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

    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    const close = page.getByTestId("close-project");
    const done = page.getByRole("button", { name: "Done", exact: true });
    await expect(close).toBeVisible();
    await expect(done).toBeVisible();
    const closeBox = (await close.boundingBox())!;
    const doneBox = (await done.boundingBox())!;
    expect(closeBox.x + closeBox.width).toBeLessThan(doneBox.x);
    expect(closeBox.y + closeBox.height / 2).toBeCloseTo(
      doneBox.y + doneBox.height / 2,
      0,
    );
  },
);

test(
  "snap settings open on hold and right-click without toggling",
  { tag: IPAD_TEST_TAG },
  async ({ page }) => {
    await openMinimalTestProject(page);
    await openMainScene(page);
    const snap = page.getByTestId("gizmo-snap-toggle");
    await expect(snap).toBeVisible();
    const pressed = await snap.getAttribute("aria-pressed");
    const box = (await snap.boundingBox())!;
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
    });
    const dialog = page.getByTestId("viewport-grid-size-dialog");
    await expect(dialog).toBeVisible();
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(dialog).toBeVisible();
    await expect(snap).toHaveAttribute("aria-pressed", pressed!);
    await dialog.getByLabel("Grid Size", { exact: true }).fill("2");
    await dialog.getByLabel("Rotation Snap (Degrees)").fill("90/2");
    await dialog.getByLabel("Scale Snap", { exact: true }).fill("0.5");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(snap).toHaveText("2");
    await page.getByRole("button", { name: "Rotate", exact: true }).click();
    await expect(snap).toHaveText("45\u00b0");
    await page.getByRole("button", { name: "Scale", exact: true }).click();
    await expect(snap).toHaveText("0.5");
    await snap.click({ button: "right" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Rotation Snap (Degrees)")).toHaveValue(
      "45",
    );
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(snap).toHaveAttribute("aria-pressed", pressed!);
    await snap.click();
    await expect(snap).toHaveAttribute(
      "aria-pressed",
      pressed === "true" ? "false" : "true",
    );
    await session.detach();
  },
);
