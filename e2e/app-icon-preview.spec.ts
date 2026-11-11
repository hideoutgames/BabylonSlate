import { expect, test, type Page } from "@playwright/test";
import { guidForPath } from "./material-graph";
import { openMinimalTestProject } from "./minimal-project";
import { openContentBrowser, selectContentBrowserAssetsFolder } from "./open-test-project";

/** A 600 × 300 PNG: red bands 150 px wide either side of a green centre square. */
async function bandedPng(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(600, 300);
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 600, 300);
    context.fillStyle = "#00ff00";
    context.fillRect(150, 0, 300, 300);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return Buffer.from(bytes);
}

/** The red and green of an image's corners and centre, as the browser decodes it. */
async function sampledColours(page: Page, testId: string): Promise<{ red: number; green: number }[]> {
  return page.getByTestId(testId).locator("img").first().evaluate(async (image: HTMLImageElement) => {
    await image.decode();
    const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const edge = image.naturalWidth - 1;
    return [[0, 0], [edge, 0], [0, edge], [edge, edge], [edge / 2, edge / 2]].map(([x, y]) => {
      const [red, green] = context.getImageData(Math.round(x!), Math.round(y!), 1, 1).data;
      return { red: red!, green: green! };
    });
  });
}

test("a non-square App Icon is cropped to its centre square in Export settings and Packaging previews", async ({ page }) => {
  await openMinimalTestProject(page);
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  await page.getByTestId("content-browser-import-input").setInputFiles({ name: "banner.png", mimeType: "image/png", buffer: await bandedPng(page) });
  await expect(page.locator('[data-asset-path="assets/banner.hasset"]')).toBeVisible({ timeout: 15_000 });
  const guid = await guidForPath(page, "assets/banner.hasset");

  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-export").click();
  await page.getByTestId("setting-app-icon").click();
  await page.getByTestId(`search-item-${guid}`).click();
  await expect(page.getByTestId("setting-app-icon-picker")).toHaveCount(0);

  // Any size is accepted: the row notes the crop and the scale-up instead of refusing the image.
  await expect(page.getByTestId("setting-app-icon")).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId("setting-app-icon-hint")).toHaveText(
    "This image is 600 × 300. The centre 300 × 300 is used. Icons up to 1024 × 1024 are scaled up and may look soft.");
  // The closed picker shows the Texture itself.
  await expect(page.getByTestId("setting-app-icon").getByTestId("picker-thumbnail").locator("img")).toBeVisible({ timeout: 15_000 });
  // Every preview is the green centre square: no red band survives at the edges.
  await expect(page.getByTestId("app-icon-previews")).toBeVisible();
  for (const colour of await sampledColours(page, "app-icon-preview-desktop")) {
    expect(colour.green).toBeGreaterThan(200);
    expect(colour.red).toBeLessThan(40);
  }

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-modal")).toHaveCount(0);
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("packaging").click();
  await expect(page.getByTestId("packaging-dialog")).toBeVisible();
  await expect(page.getByTestId("packaging-app-icon").locator("img")).toBeVisible();
  await expect(page.getByTestId("packaging-app-icon-name")).toHaveText("banner");
});
