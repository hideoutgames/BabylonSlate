import { expect, test, type Locator, type Page } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
import { openTestProject } from "./open-test-project";

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function paneWidths(page: Page) {
  const folders = await bounds(page.getByTestId("content-browser-sidebar"));
  const assets = await bounds(page.getByTestId("content-browser-assets"));
  return { folders: folders.width, assets: assets.width };
}

async function dragDivider(page: Page, destinationX: number) {
  const divider = await bounds(
    page.getByRole("separator", { name: "Resize Folders" }),
  );
  const y = divider.y + divider.height / 2;
  await page.mouse.move(divider.x + divider.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(destinationX, y, { steps: 8 });
  await page.mouse.up();
}

test(
  "Content Browser divider resizes Folders and Assets together",
  { tag: IPAD_TEST_TAG },
  async ({ page }) => {
    await openTestProject(page);
    const divider = page.getByRole("separator", { name: "Resize Folders" });
    await expect(divider).toBeVisible();
    const before = await paneWidths(page);
    const box = await bounds(divider);
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    if (await page.evaluate(() => navigator.maxTouchPoints > 0)) {
      const session = await page.context().newCDPSession(page);
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [start],
      });
      for (let step = 1; step <= 8; step++) {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: start.x + step * 15, y: start.y }],
        });
      }
      await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await session.detach();
    } else {
      await dragDivider(page, start.x + 120);
    }

    await expect
      .poll(async () => (await paneWidths(page)).folders)
      .toBeGreaterThan(before.folders + 100);
    const after = await paneWidths(page);
    expect(after.assets).toBeLessThan(before.assets - 100);
    expect(after.folders + after.assets).toBeCloseTo(
      before.folders + before.assets,
      0,
    );
    await expect(page.getByTestId("content-browser-folder-tree")).toBeVisible();
    await expect(page.getByTestId("content-browser-search")).toBeVisible();
  },
);

test("Content Browser divider supports keyboard resizing and keeps both panes usable at its limits", async ({
  page,
}) => {
  await openTestProject(page);
  const divider = page.getByRole("separator", { name: "Resize Folders" });
  await expect(divider).toBeVisible();
  const before = await paneWidths(page);
  await divider.focus();
  await divider.press("ArrowRight");
  await expect
    .poll(async () => (await paneWidths(page)).folders)
    .toBeGreaterThan(before.folders);
  await expect(divider).toBeFocused();

  const workspace = await bounds(page.getByTestId("content-browser-workspace"));
  await dragDivider(page, workspace.x + 1);
  const minimumFolders = await paneWidths(page);
  expect(minimumFolders.folders).toBeGreaterThanOrEqual(159);
  expect(minimumFolders.folders).toBeLessThan(before.folders);

  await dragDivider(page, workspace.x + workspace.width - 1);
  const minimumAssets = await paneWidths(page);
  expect(minimumAssets.assets).toBeGreaterThanOrEqual(239);
  expect(minimumAssets.folders).toBeGreaterThan(minimumFolders.folders);
  expect(minimumAssets.folders + minimumAssets.assets).toBeCloseTo(
    before.folders + before.assets,
    0,
  );
});
