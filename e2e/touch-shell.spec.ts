import { expect, test } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { waitForSceneViewportReady } from "./open-test-project";
import { closeProjectViaSettings } from "./close-project";

import { openMinimalTestProject } from "./minimal-project";

test.describe("Touch shell UX", { tag: IPAD_TEST_TAG }, () => {
  test("project long-press stays open after release and can edit", async ({
    page,
  }) => {
    await openMinimalTestProject(page);
    await closeProjectViaSettings(page);
    const project = page.getByTestId("open-listed-project-TestProject");
    await project.click({ trial: true });
    const well = await project.locator(".homepage-project-well").boundingBox();
    expect(well).not.toBeNull();
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: well!.x + well!.width / 2, y: well!.y + well!.height / 2 },
      ],
    });
    await expect(page.getByTestId("homepage-project-menu")).toBeVisible();
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(page.getByTestId("homepage-project-menu")).toBeVisible();
    await page.getByTestId("homepage-project-rename").click();
    await expect(page.getByTestId("homepage-rename-dialog")).toBeVisible();
    await page.getByTestId("homepage-rename-input").fill("Touch Project");
    await page.getByTestId("homepage-rename-confirm").click();
    await expect(project).toContainText("Touch Project");
  });
  test("pointer context menus", async ({ page }) => {
    await openMinimalTestProject(page);
    const closeContextMenu = async () => {
      await page
        .getByTestId("context-menu-backdrop")
        .click({ position: { x: 1, y: 1 } });
      await expect(page.getByTestId("context-menu-backdrop")).toHaveCount(0);
    };

    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("viewport-panel")).toBeVisible({
      timeout: 15_000,
    });
    await waitForSceneViewportReady(page);
    await test.step("suppresses the native context menu across the shell", async () => {
      const suppressed = await page.evaluate(() => {
        const targets = [
          '[data-testid="editor-chrome-bar"]',
          '[data-testid="viewport-panel"]',
          ".dockview-theme-babylonslate .dv-tab",
        ];
        return targets.map((selector) => {
          const el = document.querySelector(selector);
          if (!el) return { selector, found: false, prevented: false };
          const event = new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
          });
          el.dispatchEvent(event);
          return { selector, found: true, prevented: event.defaultPrevented };
        });
      });

      for (const result of suppressed) {
        expect(result.found, `${result.selector} should exist`).toBe(true);
        expect(
          result.prevented,
          `native menu should be suppressed on ${result.selector}`,
        ).toBe(true);
      }
    });
    await closeContextMenu();
    await test.step("keeps the native menu on opted-in selectable text", async () => {
      const prevented = await page.evaluate(() => {
        const el = document.createElement("span");
        el.className = "selectable-text";
        document.body.appendChild(el);
        const event = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(event);
        el.remove();
        return event.defaultPrevented;
      });
      expect(prevented).toBe(false);
    });
    await test.step("opens context menu on right click in viewport panel", async () => {
      const panel = page.getByTestId("viewport-panel");
      await panel.click({ button: "right", position: { x: 40, y: 40 } });
      await expect(page.getByTestId("context-menu-panel")).toBeVisible();
      await expect(
        page.getByTestId("context-menu-item-reload-scene"),
      ).toBeVisible();
    });
    await closeContextMenu();
    await test.step("opens context menu after long press in viewport panel", async () => {
      const panel = page.getByTestId("viewport-panel");
      await panel.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const x = rect.left + 40;
        const y = rect.top + 40;
        el.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            clientX: x,
            clientY: y,
            pointerId: 1,
            pointerType: "touch",
            isPrimary: true,
          }),
        );
      });
      await page.waitForTimeout(600);
      await expect(page.getByTestId("context-menu-panel")).toBeVisible({
        timeout: 3_000,
      });
    });
    await closeContextMenu();
  });
});
