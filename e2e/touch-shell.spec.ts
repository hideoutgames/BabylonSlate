import { expect, test } from "@playwright/test";

test.describe("Touch shell UX", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?test=1");
    await page.getByTestId("open-project").click();
    await page.getByTestId("content-item-scenes/main.scene.json").click();
    await expect(page.getByTestId("viewport-panel")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("defaults to user-select none on the shell", async ({ page }) => {
    const userSelect = await page.evaluate(() =>
      getComputedStyle(document.documentElement).userSelect,
    );
    expect(userSelect).toBe("none");
  });

  test("chrome tab grips meet minimum touch target size", async ({ page }) => {
    const grip = page.locator(".chrome-tab-grip").first();
    await expect(grip).toBeVisible();
    const box = await grip.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("dockview tabs meet minimum touch height", async ({ page }) => {
    const tab = page.locator(".dockview-theme-babylonslate .dv-tab").first();
    await expect(tab).toBeVisible();
    const box = await tab.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("opens context menu on right click in viewport panel", async ({
    page,
  }) => {
    const panel = page.getByTestId("viewport-panel");
    await panel.click({ button: "right", position: { x: 40, y: 40 } });
    await expect(page.getByTestId("context-menu-panel")).toBeVisible();
    await expect(page.getByTestId("context-menu-item-reload-scene")).toBeVisible();
  });

  test("opens context menu after long press in viewport panel", async ({
    page,
  }) => {
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
        }),
      );
    });
    await page.waitForTimeout(600);
    await expect(page.getByTestId("context-menu-panel")).toBeVisible({
      timeout: 3_000,
    });
  });
});
