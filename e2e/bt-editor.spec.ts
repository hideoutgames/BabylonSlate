import { expect, test, type Page } from "@playwright/test";
import { IPAD_TEST_TAG } from "./ipad-tag";
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

async function openGraphNodePalette(page: Page): Promise<void> {
  const pane = page.getByTestId("graph-editor").locator(".react-flow__pane");
  await expect(async () => {
    const box = await pane.boundingBox();
    expect(box).toBeTruthy();
    const position = {
      x: Math.max(16, (box?.width ?? 0) - 36),
      y: Math.max(16, (box?.height ?? 0) - 36),
    };
    await pane.click({ position });
    await pane.click({ position });
    await expect(page.getByTestId("node-palette")).toBeVisible({ timeout: 800 });
  }).toPass({ timeout: 10_000 });
}

async function addWaitChild(page: Page): Promise<void> {
  await page.getByTestId("bt-node-sequence").click();
  await openGraphNodePalette(page);
  await page.getByTestId("node-palette-search").fill("Wait");
  await page.getByTestId("node-palette-item-bt.task.wait").click();
  await expect(page.getByTestId("node-palette")).toHaveCount(0);
}

test.describe("Behaviour Tree editor UX", { tag: IPAD_TEST_TAG }, () => {
  test("Windows lists Blackboard and Compiler Results", async ({ page }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await openPatrolTree(page);
    await expect(page.getByTestId("behaviour-tree-blackboard")).toBeVisible();
    await expect(page.getByTestId("behaviour-tree-compiler-results")).toBeVisible();
    await expect(page.getByTestId("windows-menu")).toBeEnabled();
    await page.getByTestId("windows-menu").click();
    await expect(page.getByTestId("windows-menu-content")).toBeVisible();
    await expect(
      page.getByTestId("windows-menu-behaviour-tree-blackboard"),
    ).toBeVisible();
    await expect(
      page.getByTestId("windows-menu-behaviour-tree-compiler-results"),
    ).toBeVisible();
  });

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

  test("sibling X order updates and Auto Arrange keeps children order", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await openPatrolTree(page);
    await addWaitChild(page);
    const wait = page.locator('.react-flow__node[data-id^="bt.task.wait-"]');
    await expect(wait).toBeVisible();
    const waitId = await wait.getAttribute("data-id");
    expect(waitId).toBeTruthy();

    const taskSort = page.getByTestId("bt-sort-task");
    const waitSort = page.getByTestId(`bt-sort-${waitId}`);
    await expect(taskSort).toBeVisible();
    await expect(waitSort).toBeVisible();
    const beforeTask = await taskSort.textContent();
    const beforeWait = await waitSort.textContent();

    await page.getByTestId("bt-auto-arrange").click();
    await expect(taskSort).toHaveText(beforeTask ?? "");
    await expect(waitSort).toHaveText(beforeWait ?? "");

    await dragTreeNode(page, `bt-node-${waitId}`, -180, 0);
    await expect(waitSort).not.toHaveText(beforeWait ?? "", { timeout: 5_000 });
    const afterDragTask = await taskSort.textContent();
    const afterDragWait = await waitSort.textContent();
    await page.getByTestId("bt-auto-arrange").click();
    await expect(taskSort).toHaveText(afterDragTask ?? "");
    await expect(waitSort).toHaveText(afterDragWait ?? "");
  });

  test("a short drag off a children handle opens Add Node", async ({ page }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await openPatrolTree(page);
    const handle = page.locator('[data-id="sequence"] [data-handleid="children"]');
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 24, y + 36, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByTestId("node-palette")).toBeVisible({ timeout: 8_000 });
    await page.getByTestId("node-palette-search").fill("Wait");
    await page.getByTestId("node-palette-item-bt.task.wait").click();
    await expect(page.getByTestId("node-palette")).toHaveCount(0);
    await expect(page.getByTestId("property-durationMs")).toBeVisible({
      timeout: 10_000,
    });
    const wait = page.locator('.react-flow__node[data-id^="bt.task.wait-"]');
    await expect(wait).toBeVisible();
    const waitId = await wait.getAttribute("data-id");
    expect(waitId).toBeTruthy();
    await expect(
      page.locator(`.react-flow__edge[data-id="bt-sequence-${waitId}"]`),
    ).toBeVisible();
  });

  test("script graph still uses the 96px connect-end cancel", async ({ page }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("graph-panel")).toBeVisible();
    const handle = page.locator('[data-handleid="execOut"]').first();
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 20, y + 16, { steps: 3 });
    await page.mouse.up();
    await expect(page.getByTestId("node-palette")).toHaveCount(0);
  });

  test("switches away from a focused Behaviour Tree tab and closes it", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await openPatrolTree(page);
    await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();
    await page.getByTestId("document-tab-pinned").click();
    await expect(page.getByTestId("content-browser-asset-grid")).toBeVisible();
    await page
      .locator('[data-testid="document-tab"][data-document-kind="behaviour-tree"]')
      .getByTestId("document-tab-select")
      .click();
    await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();
    await page
      .locator('[data-testid="document-tab"][data-document-kind="behaviour-tree"]')
      .getByTestId("document-tab-close")
      .click();
    await expect(page.getByTestId("behaviour-tree-editor")).toHaveCount(0);
    await expect(page.getByTestId("content-browser-asset-grid")).toBeVisible();
  });
});
