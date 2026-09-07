import { expect, test } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

test("H8: repeated viewport marquee selects the actor without placing duplicates", async ({
  page,
}) => {
  await openTestProject(page);
  await openMainScene(page);
  await saveAllIfEnabled(page);
  const actors = page.locator('[data-testid^="tree-row-actor:"]');
  const count = await actors.count();
  expect(count).toBeGreaterThan(0);
  const tool = page.getByTestId("viewport-drag-select");
  const canvas = page.getByTestId("viewport-canvas");
  for (let attempt = 0; attempt < 3; attempt++) {
    await tool.click();
    await expect(tool).toHaveAttribute("aria-pressed", "true");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 12, box.y + 70);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 12, box.y + box.height - 20, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(tool).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("tree-row-actor:actor-1")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(actors).toHaveCount(count);
    await expect(page.getByTestId("save-all-project")).toBeDisabled();
  }
  await page.getByTestId("focus-layout").click();
  await expect(canvas).toBeVisible();
  await page.getByTestId("focus-layout").click();
  await expect(page.getByTestId("tree-row-actor:actor-1")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(actors).toHaveCount(count);
});
