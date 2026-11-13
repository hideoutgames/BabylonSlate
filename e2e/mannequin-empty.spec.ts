import { expect, test, type Locator } from "@playwright/test";
import {
  openAssetFromBrowser,
  openContentBrowser,
  openMainScene,
  openTestProject,
  selectContentBrowserAssetsFolder,
} from "./open-test-project";

/** Inspect the real RTT preview blit: tan model surfaces versus slate rig bones. */
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
        // Bones are a shaded steel slate: green over red and blue over green, both clearly, unlike the
        // Mannequin's neutral dark greys and tan, and darker than the preview sky (its blue stays at 224
        // and above) and its clouds.
        if (g >= r + 12 && b >= g + 20 && b < 200) bones++;
      }
      return { model, bones };
    },
  );
}

test.describe("3D Empty Kenney Mannequin", () => {
  test("a new project draws its starter thumbnails without Generate Thumbnail", async ({ page }, testInfo) => {
    await openTestProject(page);
    await openContentBrowser(page);
    await selectContentBrowserAssetsFolder(page);
    await page.getByTestId("content-folder-assets/Mannequin").dblclick();
    // Nothing was saved or chosen: the new project queued every asset that has a thumbnail.
    const thumbnail = page.locator('[data-asset-path="assets/Mannequin/mannequin.hasset"] img');
    await expect(thumbnail).toBeVisible({ timeout: 90_000 });
    await expect.poll(async () => (await previewPixels(thumbnail)).model).toBeGreaterThan(100);
    await page.screenshot({ path: testInfo.outputPath("new-project-thumbnails.png"), animations: "disabled" });
  });

  test("selected Model and Animation assets generate rendered browser thumbnails", async ({
    page,
  }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin/mannequin.hasset");
    await expect(page.getByTestId("model-preview-canvas")).toBeVisible();
    await openContentBrowser(page);
    for (const path of [
      "assets/Mannequin/mannequin.hasset",
      "assets/Mannequin/mannequin_idle.hasset",
    ]) {
      const tile = page.locator(`[data-asset-path="${path}"]`);
      await tile.click();
      await tile.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Generate Thumbnail", exact: true }).click();
      const thumbnail = tile.locator("img");
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
      "assets/Mannequin/mannequin_Skeleton.hasset",
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
      "assets/Mannequin/mannequin_idle.hasset",
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
    // The Mannequin draws once its slot Material has compiled.
    await expect
      .poll(async () => (await previewPixels(animationCanvas)).model, { timeout: 30_000 })
      .toBeGreaterThan(100);
    const showBones = page.getByRole("button", {
      name: "Show Bones",
      exact: true,
    });
    await showBones.click();
    await expect(showBones).toHaveAttribute("aria-pressed", "true");
    await expect(animationCanvas).toHaveAttribute("data-bones", "true");
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
    // The lit Mannequin's dark parts pick up the sky's blue, so the overlay's removal is read from the canvas, and
    // the mesh's return from its pixels.
    await expect(animationCanvas).toHaveAttribute("data-bones", "false");
    await expect
      .poll(async () => (await previewPixels(animationCanvas)).model)
      .toBeGreaterThan(100);
  });

  test("the Animation preview pauses, steps and scrubs the idle clip, and the pose follows the playhead", async ({ page }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin/mannequin_idle.hasset");
    const canvas = page.getByTestId("animation-preview-canvas");
    await expect(canvas).toHaveAttribute("data-playing", "true", { timeout: 30_000 });
    await expect
      .poll(async () => (await previewPixels(canvas)).model, { timeout: 30_000 })
      .toBeGreaterThan(100);
    const position = page.getByTestId("animation-preview-position");
    const readout = async () => {
      const match = /Frame (\d+)\/(\d+) · (\d+)\/(\d+) ms/.exec((await position.textContent()) ?? "");
      return match ? { frame: Number(match[1]), frames: Number(match[2]), ms: Number(match[3]), duration: Number(match[4]) } : null;
    };
    const playing = (await readout())!;
    expect(playing.frames).toBeGreaterThan(1);
    await expect.poll(async () => (await readout())!.ms).not.toBe(playing.ms);

    await page.getByTestId("animation-preview-pause").click();
    await expect(canvas).toHaveAttribute("data-playing", "false");
    const scrubber = page.getByTestId("animation-preview-scrubber").getByRole("slider");
    await scrubber.focus();
    await page.keyboard.press("Home");
    await expect.poll(async () => (await readout())!.ms).toBe(0);
    await page.getByTestId("animation-preview-step").click();
    await expect.poll(async () => (await readout())!.frame).toBe(2);
    await page.waitForTimeout(300);
    const start = await canvas.screenshot();

    // Halfway through the clip the Mannequin holds another pose; back at the same frame, the same one.
    const box = (await page.getByTestId("animation-preview-scrubber").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => (await readout())!.ms).toBeGreaterThan(playing.duration / 4);
    await expect(canvas).toHaveAttribute("data-playing", "false");
    await page.waitForTimeout(300);
    expect((await canvas.screenshot()).equals(start)).toBe(false);
    await scrubber.focus();
    await page.keyboard.press("Home");
    await page.getByTestId("animation-preview-step").click();
    await expect.poll(async () => (await readout())!.frame).toBe(2);
    await page.waitForTimeout(300);
    expect((await canvas.screenshot()).equals(start)).toBe(true);
  });
});
