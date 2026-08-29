import { expect, test } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openTestProject } from "./open-test-project";

test.describe("safe-area layout", { tag: IPAD_TEST_TAG }, () => {
  test("keeps chrome and overlays inside the injected safe box", async ({
    page,
  }) => {
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("viewport-panel")).toBeVisible();

    const chrome = page.getByTestId("editor-chrome-bar");
    const main = page.locator(".dockview-theme-babylonslate").first();
    const chromeBefore = await chrome.boundingBox();
    const mainBefore = await main.boundingBox();
    expect(chromeBefore).not.toBeNull();
    expect(mainBefore).not.toBeNull();
    expect(chromeBefore!.y).toBe(0);
    await page.screenshot({ path: "test-results/safe-area-before.png" });

    await page.addStyleTag({
      content: `
        :root {
          --safe-top: 44px;
          --safe-left: 24px;
          --safe-right: 24px;
          --safe-bottom: 20px;
        }
      `,
    });

    await expect
      .poll(async () => (await chrome.boundingBox())?.y ?? -1)
      .toBe(chromeBefore!.y + 44);
    const chromeAfter = await chrome.boundingBox();
    const mainAfter = await main.boundingBox();
    expect(chromeAfter).not.toBeNull();
    expect(mainAfter).not.toBeNull();
    expect(chromeAfter!.height).toBe(28);
    expect(mainAfter!.x - mainBefore!.x).toBe(24);
    await page.screenshot({ path: "test-results/safe-area-after.png" });

    const viewport = page.getByTestId("viewport-panel");
    const viewportBox = await viewport.boundingBox();
    expect(viewportBox).not.toBeNull();
    await page.evaluate(
      ({ x, y }) => {
        document
          .querySelector('[data-testid="viewport-panel"]')
          ?.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
            }),
          );
      },
      {
        x: viewportBox!.x + Math.max(1, viewportBox!.width - 2),
        y: viewportBox!.y + Math.max(1, viewportBox!.height - 2),
      },
    );
    const menu = page.getByTestId("context-menu-panel");
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width - 24 - 8,
    );
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height - 20 - 8,
    );
  });
});
