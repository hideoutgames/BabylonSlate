import { expect, test, type Page } from "@playwright/test";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openTestProject,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

const E2E_TIMEOUT_MS = 90_000;

async function openPatrolTree(page: Page): Promise<void> {
  await createContentBrowserAsset(page, "BehaviourTree", "Patrol");
  await page.locator('[data-asset-path="assets/Patrol.bt.babasset"]').dblclick();
  await expect(page.getByTestId("document-workspace-behaviour-tree")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();
  await expect(page.getByTestId("bt-node-root")).toBeVisible();
}

async function flowNodeTransform(page: Page, id: string): Promise<string> {
  const node = page.locator(`.react-flow__node[data-id="${id}"]`);
  await expect(node).toBeVisible();
  return node.evaluate((el) => (el as HTMLElement).style.transform);
}

function parseTranslate(transform: string): { x: number; y: number } {
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(transform);
  return { x: Number(match?.[1] ?? 0), y: Number(match?.[2] ?? 0) };
}

async function dragTreeNode(
  page: Page,
  testId: string,
  dx: number,
  dy: number,
): Promise<void> {
  const handle = page.getByTestId(testId);
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

test.describe("Behaviour Tree editor UX", () => {

  test("free-moves a node, undoes each completed move, and restores after save/reopen", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await openPatrolTree(page);

    const before = parseTranslate(await flowNodeTransform(page, "task"));
    await dragTreeNode(page, "bt-node-task", 90, 50);
    const afterFirst = parseTranslate(await flowNodeTransform(page, "task"));
    expect(Math.abs(afterFirst.x - before.x) + Math.abs(afterFirst.y - before.y)).toBeGreaterThan(
      20,
    );

    await dragTreeNode(page, "bt-node-task", 40, 30);
    const afterSecond = parseTranslate(await flowNodeTransform(page, "task"));
    expect(Math.abs(afterSecond.x - afterFirst.x) + Math.abs(afterSecond.y - afterFirst.y)).toBeGreaterThan(
      10,
    );

    await expect(page.getByTestId("undo-document")).toBeEnabled();
    await page.getByTestId("undo-document").click();
    const afterFirstUndo = parseTranslate(await flowNodeTransform(page, "task"));
    expect(Math.abs(afterFirstUndo.x - afterFirst.x)).toBeLessThan(8);
    expect(Math.abs(afterFirstUndo.y - afterFirst.y)).toBeLessThan(8);

    await page.getByTestId("undo-document").click();
    const afterSecondUndo = parseTranslate(await flowNodeTransform(page, "task"));
    expect(Math.abs(afterSecondUndo.x - before.x)).toBeLessThan(8);
    expect(Math.abs(afterSecondUndo.y - before.y)).toBeLessThan(8);

    await dragTreeNode(page, "bt-node-task", 80, 40);
    const saved = parseTranslate(await flowNodeTransform(page, "task"));
    await expect(page.getByTestId("save-all-dirty")).toBeVisible();
    await saveAllIfEnabled(page);
    await page
      .locator('[data-testid="document-tab"][data-document-kind="behaviour-tree"]')
      .getByTestId("document-tab-close")
      .click();
    await expect(page.getByTestId("behaviour-tree-editor")).toHaveCount(0);
    await openAssetFromBrowser(page, "assets/Patrol.bt.babasset");
    await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();
    const reopened = parseTranslate(await flowNodeTransform(page, "task"));
    expect(Math.abs(reopened.x - saved.x)).toBeLessThan(8);
    expect(Math.abs(reopened.y - saved.y)).toBeLessThan(8);
  });
});
