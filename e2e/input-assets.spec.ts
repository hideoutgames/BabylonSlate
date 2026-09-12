import { expect, test } from "@playwright/test";
import { openMinimalTestProject } from "./minimal-project";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { saveAllIfEnabled } from "./save-all";

test(
  "Input assets provide a docked binding editor and per-asset graph events",
  { tag: IPAD_TEST_TAG },
  async ({ page }) => {
    await openMinimalTestProject(page);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.getByTestId("content-browser-new-asset").click();
    await page.getByTestId("new-asset-type").click();
    await page.getByTestId("new-asset-type-InputAxis").click();
    await page.getByTestId("new-asset-name").fill("CameraMove");
    await page.getByTestId("content-browser-new-asset-create").click();
    await expect(
      page.getByTestId("content-browser-new-asset-dialog"),
    ).toHaveCount(0);
    await page
      .locator('[data-asset-path="assets/CameraMove.inputaxis.babasset"]')
      .dblclick();
    const workspace = page.getByTestId("document-workspace-input-axis");
    await expect(workspace).toBeVisible();
    await expect(
      page.locator(
        '[data-testid="document-tab"][data-document-kind="input-axis"]',
      ),
    ).not.toContainText(".inputaxis");
    await expect(page.getByTestId("windows-menu")).toBeEnabled();
    await workspace.getByRole("button", { name: "Add Preset" }).click();
    await page.getByRole("menuitem", { name: /WASD/ }).click();
    await expect(
      workspace.getByRole("button", { name: "Listen", exact: true }),
    ).toHaveCount(4);
    await expect(workspace.getByTestId("input-details-panel")).toBeVisible();
    const selectedControl = workspace.getByRole("group", {
      name: "Control 2",
      exact: true,
    });
    await selectedControl.click({ position: { x: 4, y: 4 } });
    await expect(selectedControl).toHaveAttribute("aria-current", "true");
    await expect(
      workspace.getByRole("button", { name: "Details", exact: true }),
    ).toHaveCount(0);
    const removeControl = selectedControl.getByRole("button", {
      name: "Remove Control 2",
    });
    const rowBounds = await selectedControl.boundingBox();
    const removeBounds = await removeControl.boundingBox();
    expect(
      rowBounds!.x + rowBounds!.width - removeBounds!.x - removeBounds!.width,
    ).toBeGreaterThanOrEqual(0);
    expect(
      rowBounds!.x + rowBounds!.width - removeBounds!.x - removeBounds!.width,
    ).toBeLessThanOrEqual(12);
    await workspace
      .getByRole("button", { name: "Listen", exact: true })
      .first()
      .click();
    await page.keyboard.press("KeyJ");
    await expect(
      workspace.getByRole("button", { name: "Listen", exact: true }),
    ).toHaveCount(4);
    await saveAllIfEnabled(page);
    await page.screenshot({
      path: test.info().outputPath("dark-input-axis.png"),
    });
    const coarse = await page.evaluate(
      () => matchMedia("(pointer: coarse)").matches,
    );
    if (coarse) {
      const button = await workspace
        .getByRole("button", { name: "Add Preset" })
        .boundingBox();
      expect(button!.height).toBeGreaterThanOrEqual(44);
      expect(removeBounds!.height).toBeGreaterThanOrEqual(44);
      expect(removeBounds!.width).toBeGreaterThanOrEqual(44);
    }
    await page
      .locator(
        '[data-testid="document-tab"][data-document-kind="content-browser"]',
      )
      .click();
    await page
      .locator('[data-asset-path="assets/main.class.babasset"]')
      .dblclick();
    await page.getByTestId("graph-add-node").click();
    await page.getByTestId("node-palette-search").fill("CameraMove");
    const event = page
      .locator('[data-testid^="node-palette-item-input.axisEvent:"]')
      .filter({ hasText: "Event CameraMove" });
    await expect(event).toHaveCount(1);
    await event.click();
    await expect(page.getByTestId("node-palette")).toHaveCount(0);
    await expect(
      page
        .getByTestId("graph-panel")
        .locator(".react-flow__node")
        .filter({ hasText: "Event CameraMove" }),
    ).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("input-event.png") });
  },
);
