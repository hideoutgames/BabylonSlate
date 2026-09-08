import { expect, test, type Page } from "@playwright/test";
import {
  openTestProject,
  waitForSceneViewportReady,
} from "./open-test-project";
import { openMinimalTestProject } from "./minimal-project";

async function expectWithinViewport(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test.describe("Phone Editor", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("reserves a home-indicator gap when an installed phone reports zero insets", async ({
    page,
  }) => {
    await openMinimalTestProject(page);
    const workspace = page.locator("main");
    await expect
      .poll(async () => {
        const box = await workspace.boundingBox();
        return box ? box.y + box.height : -1;
      })
      .toBe(844);
    // Chromium cannot emulate display-mode: standalone. Override that media
    // condition only; the real pointer/size queries and safe-area CSS still run.
    await page.evaluate(() => {
      const activateStandalone = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSMediaRule) {
            rule.media.mediaText = rule.media.mediaText.replace(
              /\(\s*display-mode\s*:\s*standalone\s*\)/g,
              "(min-width: 0px)",
            );
          }
          if (rule instanceof CSSGroupingRule) activateStandalone(rule.cssRules);
        }
      };
      for (const sheet of document.styleSheets) activateStandalone(sheet.cssRules);
    });
    await expect
      .poll(async () => {
        const box = await workspace.boundingBox();
        return box ? box.y + box.height : Infinity;
      })
      .toBeLessThanOrEqual(812);
    await page.mouse.click(370, 800, { button: "right" });
    const menu = page.getByTestId("context-menu-panel");
    await expect(menu).toBeVisible();
    await expect
      .poll(async () => {
        const box = await menu.boundingBox();
        return box ? box.y + box.height : Infinity;
      })
      .toBeLessThanOrEqual(804);
    await page.keyboard.press("Escape");
    const device = await page.context().newCDPSession(page);
    await device.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { bottom: 48 },
    });
    await expect
      .poll(async () => {
        const box = await workspace.boundingBox();
        return box ? box.y + box.height : Infinity;
      })
      .toBe(796);
    await device.send("Emulation.setSafeAreaInsetsOverride", {
      insets: { bottom: 0 },
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect
      .poll(async () => {
        const box = await workspace.boundingBox();
        return box ? box.y + box.height : Infinity;
      })
      .toBeLessThanOrEqual(358);
    await page.setViewportSize({ width: 1194, height: 834 });
    await expect
      .poll(async () => {
        const box = await workspace.boundingBox();
        return box ? box.y + box.height : -1;
      })
      .toBe(834);
  });

  test("recovers a stale page offset after phone rotation and keeps controls tappable", async ({
    page,
  }) => {
    await openMinimalTestProject(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.getByTestId("content-browser-search").tap();
    await page.keyboard.type("main");
    await page.getByTestId("content-browser-search").blur();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addStyleTag({
      content: ":root { --safe-top: 59px; --safe-bottom: 34px; }",
    });
    // Model WebKit retaining document scroll from the previous orientation.
    // Chromium emulation does not reproduce the installed iOS PWA's OS chrome.
    await page.evaluate(() => {
      document.documentElement.style.minHeight = "1400px";
      window.scrollTo(0, 400);
    });
    expect(await page.evaluate(() => window.scrollY)).toBe(400);
    await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect
      .poll(async () => (await page.getByTestId("editor-chrome-bar").boundingBox())?.y)
      .toBe(59);
    await expectWithinViewport(page, "editor-global-toolbar");
    await page.getByTestId("editor-more-tools").tap();
    await expect(page.getByTestId("global-search")).toBeVisible();
    await page.getByTestId("global-search").tap();
    await expect(page.getByRole("dialog", { name: /Search/ })).toBeVisible();
  });

  test("keeps navigation and tools reachable without horizontal overflow", async ({
    page,
  }) => {
    await openTestProject(page);
    await page.screenshot({
      path: "test-results/phone-content-browser.png",
      animations: "disabled",
    });
    await expect(page.getByTestId("document-switcher")).toBeVisible();
    await expectWithinViewport(page, "document-switcher");
    await expectWithinViewport(page, "editor-global-toolbar");
    await expectWithinViewport(page, "content-browser-search");
    await page.getByTestId("editor-more-tools").tap();
    await page.getByTestId("global-search").tap();
    await expect(page.getByRole("dialog", { name: /Search/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("editor-more-tools").tap();
    await page.getByTestId("settings-menu").tap();
    await page.getByTestId("project-settings").tap();
    await expect(
      page.getByRole("combobox", { name: "Category" }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/phone-project-settings.png",
      animations: "disabled",
    });
  });

  test("shows one scene window, switches windows, and restores the tablet arrangement", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1194, height: 834 });
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await waitForSceneViewportReady(page);
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();
    await page.screenshot({
      path: "test-results/ipad-editor.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("phone-window-switcher")).toBeVisible();
    await expect(page.getByTestId("viewport-panel")).toBeVisible();
    await expect(page.getByTestId("scene-outliner-panel")).toBeHidden();
    await page.getByTestId("phone-window-switcher").tap();
    await page.getByRole("option", { name: "Outliner", exact: true }).tap();
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();
    await expect(page.getByTestId("viewport-panel")).toBeHidden();
    await page.screenshot({
      path: "test-results/phone-outliner.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.getByTestId("phone-window-switcher")).toBeVisible();
    await expectWithinViewport(page, "phone-window-switcher");
    await expect(page.getByTestId("viewport-panel")).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addStyleTag({
      content: ":root { --safe-top: 59px; --safe-bottom: 34px; }",
    });
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();
    await expectWithinViewport(page, "scene-outliner-panel");
    await expect
      .poll(async () => {
        const box = await page.getByTestId("phone-window-switcher").boundingBox();
        return box ? box.y + box.height : Infinity;
      })
      .toBeLessThanOrEqual(810);
    await page.getByTestId("phone-window-switcher").tap();
    await page.getByRole("option", { name: "Viewport", exact: true }).tap();
    await expect(page.getByTestId("viewport-panel")).toBeVisible();
    await expectWithinViewport(page, "viewport-panel");
    await page.addStyleTag({
      content: ":root { --safe-top: 0px; --safe-bottom: 0px; }",
    });
    await page.setViewportSize({ width: 1194, height: 834 });
    await expect(page.getByTestId("phone-window-switcher")).toHaveCount(0);
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible();
    await expect(page.getByTestId("viewport-panel")).toBeVisible();
  });
});
