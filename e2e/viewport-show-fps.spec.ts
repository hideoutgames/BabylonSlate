import { expect, test } from "@playwright/test";
import { openMinimalTestProject } from "./minimal-project";
import { openListedTestProject, openMainScene } from "./open-test-project";

test("Show FPS in the viewport View menu shows whole frames per second under the toolbar island", async ({ page }, testInfo) => {
  await openMinimalTestProject(page);
  await openMainScene(page);
  const counter = page.getByTestId("viewport-fps");
  await expect(counter).toHaveCount(0);

  await page.getByTestId("viewport-view").click();
  const toggle = page.getByTestId("viewport-show-fps-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  await expect(counter).toHaveText(/^\d+ FPS$/);
  await expect(counter).toHaveAttribute("data-tone", /^(good|fair|poor|bad)$/);
  // Below the island, right-aligned inside the viewport.
  const island = (await page.getByTestId("viewport-panel-frame").boundingBox())!;
  const panel = (await page.getByTestId("viewport-panel").boundingBox())!;
  const box = (await counter.boundingBox())!;
  expect(box.y).toBeGreaterThan(island.y + island.height);
  expect(panel.x + panel.width - (box.x + box.width)).toBeLessThan(24);
  await page.screenshot({ path: testInfo.outputPath("viewport-show-fps.png"), animations: "disabled" });

  // An editor preference: it stays on after a reload, and turning it off removes the counter.
  await page.reload();
  await expect(page.getByTestId("homepage")).toBeVisible({ timeout: 30_000 });
  await openListedTestProject(page);
  await openMainScene(page);
  await expect(counter).toHaveText(/^\d+ FPS$/);
  await page.getByTestId("viewport-view").click();
  await page.getByTestId("viewport-show-fps-toggle").click();
  await page.keyboard.press("Escape");
  await expect(counter).toHaveCount(0);
});
