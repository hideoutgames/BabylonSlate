import { expect, test, type Locator } from "@playwright/test";
import {
  openAssetFromBrowser,
  openContentBrowser,
  openMainScene,
  openTestProject,
} from "./open-test-project";

/** Inspect the real RTT preview blit: tan model surfaces versus cyan bones. */
async function previewPixels(surface: Locator) {
  return surface.evaluate(
    async (element: HTMLCanvasElement | HTMLImageElement) => {
      const canvas =
        element instanceof HTMLCanvasElement
          ? element
          : document.createElement("canvas");
      if (element instanceof HTMLImageElement) {
        await element.decode();
        canvas.width = element.naturalWidth;
        canvas.height = element.naturalHeight;
        canvas.getContext("2d")?.drawImage(element, 0, 0);
      }
      const context = canvas.getContext("2d");
      if (!context || !element.width || !element.height) {
        return { model: 0, bones: 0 };
      }
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let model = 0;
      let bones = 0;
      for (let index = 0; index < data.length; index += 4) {
        const [r, g, b] = [data[index]!, data[index + 1]!, data[index + 2]!];
        if (r > 70 && g > 30 && r > g * 1.12 && g > b * 1.1) model++;
        if (g > 100 && b > 100 && r < g * 0.75 && r < b * 0.75) bones++;
      }
      return { model, bones };
    },
  );
}

test.describe("3D Empty Kenney Mannequin", () => {
  test("Model preview draws on opening without orbiting the canvas", async ({
    page,
  }, testInfo) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin/mannequin.babasset");
    const canvas = page.getByTestId("model-preview-canvas");
    await expect(canvas).toBeVisible();
    await expect
      .poll(async () => (await previewPixels(canvas)).model, {
        timeout: 15_000,
      })
      .toBeGreaterThan(100);
    await canvas.screenshot({
      path: testInfo.outputPath("model-first-open.png"),
    });
  });

  test("existing Model and Animation assets receive rendered browser thumbnails", async ({
    page,
  }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin/mannequin.babasset");
    await openContentBrowser(page);
    for (const path of [
      "assets/Mannequin/mannequin.babasset",
      "assets/Mannequin/mannequin_idle.babasset",
    ]) {
      const thumbnail = page.locator(`[data-asset-path="${path}"] img`);
      await expect(thumbnail).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => (await previewPixels(thumbnail)).model)
        .toBeGreaterThan(100);
    }
  });

  test("new 3D Empty shows Mannequin, hierarchy bones, and a looping idle clip", async ({
    page,
  }, testInfo) => {
    await openTestProject(page);
    await openMainScene(page);
    await expect(page.getByTestId("tree-row-actor:actor-1")).toContainText(
      "Mannequin",
    );
    await expect(page.getByTestId("tree-row-actor:actor-1")).not.toContainText(
      "Cube",
    );

    await openAssetFromBrowser(
      page,
      "assets/Mannequin/mannequin_Skeleton.babasset",
    );
    await expect(page.getByTestId("document-workspace-skeleton")).toBeVisible();
    await expect(page.getByTestId("skeleton-preview")).toBeVisible();
    await expect(page.getByTestId("skeleton-bone-tree")).toBeVisible();
    await expect(page.getByTestId("tree-row-torso")).toBeVisible();
    await expect(page.getByTestId("skeleton-preview-canvas")).toHaveAttribute(
      "data-bones",
      "true",
      { timeout: 30_000 },
    );
    const skeletonCanvas = page.getByTestId("skeleton-preview-canvas");
    await expect
      .poll(async () => (await previewPixels(skeletonCanvas)).bones)
      .toBeGreaterThan(20);
    await expect
      .poll(async () => (await previewPixels(skeletonCanvas)).model)
      .toBe(0);
    await skeletonCanvas.screenshot({
      path: testInfo.outputPath("skeleton-preview.png"),
    });

    await openAssetFromBrowser(
      page,
      "assets/Mannequin/mannequin_idle.babasset",
    );
    await expect(
      page.getByTestId("document-workspace-animation"),
    ).toBeVisible();
    await expect(page.getByTestId("animation-preview")).toBeVisible();
    await expect(page.getByTestId("animation-preview-canvas")).toHaveAttribute(
      "data-playing",
      "true",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("animation-preview-canvas")).toHaveAttribute(
      "data-looping",
      "true",
    );
    const animationCanvas = page.getByTestId("animation-preview-canvas");
    await expect
      .poll(async () => (await previewPixels(animationCanvas)).model)
      .toBeGreaterThan(100);
    const showBones = page.getByRole("button", {
      name: "Show Bones",
      exact: true,
    });
    await showBones.click();
    await expect(showBones).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => (await previewPixels(animationCanvas)).bones)
      .toBeGreaterThan(20);
    await expect
      .poll(async () => (await previewPixels(animationCanvas)).model)
      .toBe(0);
    await expect(animationCanvas).toHaveAttribute("data-playing", "true");
    await expect(animationCanvas).toHaveAttribute("data-looping", "true");
    await animationCanvas.screenshot({
      path: testInfo.outputPath("animation-bones.png"),
    });
    await showBones.click();
    await expect(showBones).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(async () => (await previewPixels(animationCanvas)).bones)
      .toBe(0);
    await expect
      .poll(async () => (await previewPixels(animationCanvas)).model)
      .toBeGreaterThan(100);
  });
});
