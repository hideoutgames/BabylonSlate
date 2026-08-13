import { expect, test, type Page } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";

async function openSceneWithViewport(page: Page) {
  await openTestProject(page);
  await openMainScene(page);
  await expect(page.getByTestId("viewport-panel")).toBeVisible();
}

/** Full-viewport layers (modal menu backdrops) that sit over the WebGL canvas. */
async function fullViewportFixedLayers(page: Page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return [...document.querySelectorAll("body *")]
      .filter((el) => {
        const style = getComputedStyle(el);
        if (style.position !== "fixed") return false;
        const rect = el.getBoundingClientRect();
        return (
          rect.width >= vw - 2 &&
          rect.height >= vh - 2 &&
          rect.top <= 1 &&
          rect.left <= 1
        );
      })
      .map((el) => ({
        testId: (el as HTMLElement).dataset.testid ?? "",
        role: el.getAttribute("role"),
      }));
  });
}

test.describe("Debug menu", () => {
  test("keeps Base UI portals stacked above the WebGL shell", async ({
    page,
  }) => {
    await openSceneWithViewport(page);

    const portalCss = await page.evaluate(() => ({
      isolation: getComputedStyle(document.getElementById("root")!).isolation,
      bodyPosition: getComputedStyle(document.body).position,
    }));
    expect(portalCss.isolation).toBe("isolate");
    expect(portalCss.bodyPosition).toBe("relative");
  });

  test("opens from the content browser without covering the editor", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("debug-menu")).toBeEnabled();
    await page.getByTestId("debug-menu").click();
    await expect(page.getByTestId("always-render-toggle")).toBeVisible();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  });

  test("opens without covering the editor or starting Play", async ({
    page,
  }) => {
    await openSceneWithViewport(page);

    const canvas = page.getByTestId("viewport-canvas");
    const canvasBefore = await canvas.boundingBox();
    expect(canvasBefore, "viewport canvas should be sized").not.toBeNull();
    expect(canvasBefore!.width).toBeGreaterThan(0);
    expect(canvasBefore!.height).toBeGreaterThan(0);

    await page.getByTestId("debug-menu").click();
    await expect(page.getByTestId("always-render-toggle")).toBeVisible();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);

    const canvasAfterOpen = await canvas.boundingBox();
    expect(canvasAfterOpen, "viewport canvas should remain sized").not.toBeNull();
    expect(canvasAfterOpen!.width).toBeGreaterThan(0);
    expect(canvasAfterOpen!.height).toBeGreaterThan(0);

    const layers = await fullViewportFixedLayers(page);
    expect(
      layers.filter((layer) => layer.testId !== "play-overlay"),
      "Debug must not mount a full-viewport modal backdrop over the canvas",
    ).toEqual([]);

    await page.getByTestId("always-render-toggle").click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    await expect(canvas).toBeVisible();
  });
});
