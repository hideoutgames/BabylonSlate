import { expect, test, type Page } from "@playwright/test";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";

/** The editor camera's zoom extent: 3D orbit radius or 2D orthographic half height; smaller is zoomed in. */
async function editorCameraExtent(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const zoom = (
      globalThis as {
        __hapticViewportTest?: {
          editorCameraZoom: () => { mode: "2d" | "3d"; radius: number; orthoHalfHeight: number } | null;
        };
      }
    ).__hapticViewportTest?.editorCameraZoom();
    if (!zoom) return null;
    return zoom.mode === "3d" ? zoom.radius : zoom.orthoHalfHeight;
  });
}

test("Viewport Zoom Buttons adds Zoom In and Zoom Out to the Scene viewport's corner, and they zoom the editor camera", async ({ page }) => {
  await openMinimalTestProject(page);
  await openMainScene(page);
  const controls = page.getByTestId("viewport-zoom-controls");
  await expect(controls).toHaveCount(0);

  await page.getByTestId("settings-menu").click();
  await page.getByTestId("engine-settings").click();
  await page.getByTestId("engine-settings-modal-category-accessibility").click();
  const toggle = page.getByTestId("setting-viewport-zoom-buttons");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("engine-settings-modal-category-accessibility")).toHaveCount(0);

  await expect(controls).toBeVisible();
  // Bottom-right inside the viewport.
  const panel = (await page.getByTestId("viewport-panel").boundingBox())!;
  const box = (await controls.boundingBox())!;
  expect(panel.x + panel.width - (box.x + box.width)).toBeLessThan(24);
  expect(panel.y + panel.height - (box.y + box.height)).toBeLessThan(24);

  await expect.poll(() => editorCameraExtent(page), { timeout: 30_000 }).not.toBeNull();
  const start = (await editorCameraExtent(page))!;
  // One tap zooms by the drive's tap factor, 1.2; within 1% once its glide ends.
  const near = (expected: number) => async () => Math.abs((await editorCameraExtent(page))! / expected - 1) < 0.01;
  await page.getByTestId("viewport-zoom-in").click();
  await expect.poll(near(start / 1.2)).toBe(true);
  await page.getByTestId("viewport-zoom-out").click();
  await expect.poll(near(start)).toBe(true);

  // Holding keeps zooming well past one step, and stops on release.
  const zoomIn = (await page.getByTestId("viewport-zoom-in").boundingBox())!;
  await page.mouse.move(zoomIn.x + zoomIn.width / 2, zoomIn.y + zoomIn.height / 2);
  await page.mouse.down();
  await expect.poll(async () => (await editorCameraExtent(page))!).toBeLessThan(start / 1.5);
  await page.mouse.up();
  const released = (await editorCameraExtent(page))!;
  // Bounded on purpose: this asserts that nothing changes once the button is released.
  await page.waitForTimeout(300);
  expect(await editorCameraExtent(page)).toBe(released);
  await expect(page.getByTestId("context-menu-panel")).toHaveCount(0);
});
