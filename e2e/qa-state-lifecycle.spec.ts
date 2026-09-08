import { expect, test, type Page } from "@playwright/test";
import { openAssetFromBrowser, openMainScene, openTestProject } from "./open-test-project";
import { clickPlayAndWaitForOverlay, waitForPreviewBuildBoot } from "./play";
import { saveAllIfEnabled } from "./save-all";

const CLASS_PATH = "assets/Mannequin.class.babasset";

type TestHost = {
  __babylonslateTest: {
    nudgeActiveGraphNode: () => Promise<boolean>;
    activeGraphNodePosition: () => { x: number; y: number } | null;
    nudgeActiveSceneActor: () => Promise<boolean>;
    activeSceneActorPosition: () => [number, number, number];
    cancelDebouncedSave: () => void;
    dirtyDocuments: () => { kind: string; id: string }[];
    runForegroundRescan: () => Promise<void>;
    touchAssetOnDisk: (path: string) => Promise<void>;
  };
};

async function graphPosition(page: Page) {
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as TestHost)
    .__babylonslateTest.activeGraphNodePosition())).not.toBeNull();
  return page.evaluate(() => (globalThis as unknown as TestHost)
    .__babylonslateTest.activeGraphNodePosition()!);
}

async function scenePosition(page: Page) {
  return page.evaluate(() => (globalThis as unknown as TestHost)
    .__babylonslateTest.activeSceneActorPosition());
}

async function dirtyKinds(page: Page) {
  return page.evaluate(() => (globalThis as unknown as TestHost)
    .__babylonslateTest.dirtyDocuments().map((doc) => doc.kind).sort());
}

async function moveGraph(page: Page) {
  expect(await page.evaluate(async () => {
    const api = (globalThis as unknown as TestHost).__babylonslateTest;
    const changed = await api.nudgeActiveGraphNode();
    api.cancelDebouncedSave();
    return changed;
  })).toBe(true);
}

test("H6: Undo in a Class preserves unsaved Scene content and its independent history", async ({ page }) => {
  await openTestProject(page);
  await openMainScene(page);
  await openAssetFromBrowser(page, CLASS_PATH);
  await saveAllIfEnabled(page);
  const originalGraph = await graphPosition(page);
  const originalScene = await scenePosition(page);
  expect(await page.evaluate(async () => {
    const api = (globalThis as unknown as TestHost).__babylonslateTest;
    const changed = await api.nudgeActiveSceneActor();
    api.cancelDebouncedSave();
    return changed;
  })).toBe(true);
  await moveGraph(page);
  expect(await dirtyKinds(page)).toEqual(["graph", "scene"]);
  await page.getByTestId("undo-document").click();
  expect(await graphPosition(page)).toEqual(originalGraph);
  expect(await scenePosition(page)).toEqual([originalScene[0] + 1.5, originalScene[1], originalScene[2]]);
  expect(await dirtyKinds(page)).toContain("scene");
  await expect(page.getByTestId("save-all-project")).toBeEnabled();
  await openMainScene(page);
  await page.getByTestId("undo-document").click();
  expect(await scenePosition(page)).toEqual(originalScene);
  await page.getByTestId("redo-document").click();
  expect(await scenePosition(page)).toEqual([originalScene[0] + 1.5, originalScene[1], originalScene[2]]);
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  await openMainScene(page);
  expect(await scenePosition(page)).toEqual([originalScene[0] + 1.5, originalScene[1], originalScene[2]]);
  await openAssetFromBrowser(page, CLASS_PATH);
  expect(await graphPosition(page)).toEqual(originalGraph);
});

for (const preview of [false, true]) {
  test(`M3/M4: ${preview ? "Preview Build" : "Normal Play"} saves content and retains document Undo after Stop`, async ({ page }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openAssetFromBrowser(page, CLASS_PATH);
    await saveAllIfEnabled(page);
    const original = await graphPosition(page);
    await moveGraph(page);
    const moved = { x: original.x + 42, y: original.y + 17 };
    await openMainScene(page);
    if (preview) {
      await page.getByTestId("debug-menu").click();
      await page.getByTestId("preview-build-toggle").click();
      await page.getByTestId("play-preview").click();
      await waitForPreviewBuildBoot(page);
      await page.getByTestId("preview-build-close").click();
      await expect(page.getByTestId("preview-build-overlay")).toHaveCount(0);
    } else {
      await clickPlayAndWaitForOverlay(page);
      await page.getByTestId("play-overlay-close").click();
      await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    }
    await openAssetFromBrowser(page, CLASS_PATH);
    expect(await graphPosition(page)).toEqual(moved);
    expect(await dirtyKinds(page)).toEqual([]);
    await expect(page.getByTestId("undo-document")).toBeEnabled();
    await page.getByTestId("undo-document").click();
    expect(await graphPosition(page)).toEqual(original);
    expect(await dirtyKinds(page)).toEqual(["graph"]);
    await page.getByTestId("redo-document").click();
    expect(await graphPosition(page)).toEqual(moved);
    await saveAllIfEnabled(page);
  });
}

test("M17: an editor save does not prompt Reload, while Keep Open preserves a real conflicting edit", async ({ page }) => {
  await openTestProject(page);
  await openAssetFromBrowser(page, CLASS_PATH);
  await saveAllIfEnabled(page);
  await moveGraph(page);
  await saveAllIfEnabled(page);
  await page.evaluate(() => (globalThis as unknown as TestHost)
    .__babylonslateTest.runForegroundRescan());
  await expect(page.locator('[data-testid^="external-change-"][role="alertdialog"]')).toHaveCount(0);
  await moveGraph(page);
  const edited = await graphPosition(page);
  await page.evaluate(async (path) => {
    const api = (globalThis as unknown as TestHost).__babylonslateTest;
    await api.touchAssetOnDisk(path);
    await api.runForegroundRescan();
  }, CLASS_PATH);
  await expect(page.getByTestId("external-change-dirty-disk")).toBeVisible();
  await page.getByTestId("external-change-keep-edits").click();
  await expect(page.getByTestId("external-change-dirty-disk")).toHaveCount(0);
  expect(await graphPosition(page)).toEqual(edited);
  expect(await dirtyKinds(page)).toEqual(["graph"]);
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  await openAssetFromBrowser(page, CLASS_PATH);
  expect(await graphPosition(page)).toEqual(edited);
});

for (const action of ["export-project", "export-game"]) {
  test(`H6/M12: ${action} preserves unsaved content and its Undo history`, async ({ page }) => {
    test.setTimeout(120_000);
    await openTestProject(page);
    await openAssetFromBrowser(page, CLASS_PATH);
    await saveAllIfEnabled(page);
    const original = await graphPosition(page);
    await moveGraph(page);
    const edited = { x: original.x + 42, y: original.y + 17 };
    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await page.getByTestId("settings-modal-category-export").click();
    const download = page.waitForEvent("download");
    await page.getByTestId(action).click();
    expect(await (await download).failure()).toBeNull();
    await page.getByTestId("settings-modal").getByRole("button", { name: "Close", exact: true }).click();
    expect(await graphPosition(page)).toEqual(edited);
    expect(await dirtyKinds(page)).toEqual(["graph"]);
    await expect(page.getByTestId("save-all-project")).toBeEnabled();
    await page.getByTestId("undo-document").click();
    expect(await graphPosition(page)).toEqual(original);
    await page.getByTestId("redo-document").click();
    expect(await graphPosition(page)).toEqual(edited);
    await saveAllIfEnabled(page);
    await page.reload();
    await openTestProject(page);
    await openAssetFromBrowser(page, CLASS_PATH);
    expect(await graphPosition(page)).toEqual(edited);
  });
}

test("H6/M12: manual NavMesh Bake preserves a separately dirty Class and Scene history", async ({ page }) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  await openMainScene(page);
  for (const item of ["shape-ground", "navmesh"]) {
    await page.getByTestId("outliner-add-actor").click();
    await page.getByTestId("place-actors-catalog-search").fill(item.replace("shape-", ""));
    await page.getByTestId(`place-actors-item-${item}`).click();
  }
  await openAssetFromBrowser(page, CLASS_PATH);
  await saveAllIfEnabled(page);
  const originalGraph = await graphPosition(page);
  const originalScene = await scenePosition(page);
  await moveGraph(page);
  expect(await page.evaluate(async () => {
    const api = (globalThis as unknown as TestHost).__babylonslateTest;
    const changed = await api.nudgeActiveSceneActor();
    api.cancelDebouncedSave();
    return changed;
  })).toBe(true);
  await openMainScene(page);
  await page.getByTestId("outliner-tree").getByText("NavMesh", { exact: true }).click();
  await page.getByRole("button", { name: "Bake NavMesh", exact: true }).click();
  await expect(page.getByTestId("nav-bake-dialog")).toBeVisible();
  await expect(page.getByTestId("nav-bake-dialog")).toHaveCount(0, { timeout: 30_000 });
  const bake = await page.evaluate(() => (globalThis as unknown as {
    __babylonslateTest: { lastNavBake: () => { ok: boolean; byteLength: number } };
  }).__babylonslateTest.lastNavBake());
  expect(bake.ok).toBe(true);
  expect(bake.byteLength).toBeGreaterThan(0);
  expect(await dirtyKinds(page)).toEqual(["graph", "scene"]);
  await page.getByTestId("undo-document").click();
  expect(await scenePosition(page)).toEqual(originalScene);
  await page.getByTestId("redo-document").click();
  expect(await scenePosition(page)).toEqual([originalScene[0] + 1.5, originalScene[1], originalScene[2]]);
  await openAssetFromBrowser(page, CLASS_PATH);
  expect(await graphPosition(page)).toEqual({ x: originalGraph.x + 42, y: originalGraph.y + 17 });
  await page.getByTestId("undo-document").click();
  expect(await graphPosition(page)).toEqual(originalGraph);
  await saveAllIfEnabled(page);
  await page.reload();
  await openTestProject(page);
  await openMainScene(page);
  expect(await scenePosition(page)).toEqual([originalScene[0] + 1.5, originalScene[1], originalScene[2]]);
});
