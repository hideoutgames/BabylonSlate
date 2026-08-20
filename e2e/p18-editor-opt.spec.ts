import { expect, test, type Page } from "@playwright/test";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openContentBrowser,
  openMainScene,
  openTestProject,
  selectContentBrowserAssetsFolder,
} from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";

const DOCUMENT_IDLE_UNMOUNT_MS = 120_000;

const E2E_TIMEOUT_MS = 180_000;

function gridGraph(count: number) {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    type: "debug.log",
    position: {
      x: (index % 20) * 400,
      y: Math.floor(index / 20) * 400,
    },
    data: { message: `n${index}` },
  }));
  return {
    nodes,
    edges: [{ id: "e0", source: "n0", target: "n1" }],
  };
}

async function seedMainGraph(page: Page, count: number): Promise<void> {
  const ok = await page.evaluate(async (graph) => {
    const host = globalThis as {
      __babylonslateTest?: {
        setMainGraphContent: (next: unknown) => Promise<boolean>;
      };
    };
    return host.__babylonslateTest?.setMainGraphContent(graph) ?? false;
  }, gridGraph(count));
  expect(ok).toBe(true);
}

async function advanceIdleClock(page: Page, ms: number): Promise<void> {
  await page.evaluate((delta) => {
    const host = globalThis as {
      __babylonslateTest?: { advanceIdleClock: (value: number) => void };
    };
    host.__babylonslateTest?.advanceIdleClock(delta);
  }, ms);
}

function visibleGraphWorkspace(page: Page) {
  return page.locator('[data-testid="document-workspace-graph"]:visible');
}

async function openOrCreateAsset(
  page: Page,
  type: string,
  name: string,
  assetPath: string,
): Promise<void> {
  await openContentBrowser(page);
  await selectContentBrowserAssetsFolder(page);
  const search = page.getByTestId("content-browser-search");
  await search.fill(name);
  const tile = page.locator(`[data-asset-path="${assetPath}"]`);
  if ((await tile.count()) === 0) {
    await search.fill("");
    await createContentBrowserAsset(page, type, name);
    await selectContentBrowserAssetsFolder(page);
    await search.fill(name);
  }
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await tile.dblclick();
}

async function openClassPrefab(page: Page): Promise<void> {
  await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
  await expect(page.getByTestId("document-workspace-graph")).toBeVisible();
  await page.locator(".dv-tab").filter({ hasText: "Prefab" }).click();
  await expect(page.getByTestId("prefab-viewport-panel")).toBeVisible();
  await expect(page.getByTestId("prefab-preview-canvas")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.describe("P18 iPad editor optimisation", () => {
  test("Prefab Preview, Play overlay, and Scene viewport share one session", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await openMainScene(page);
    await expect(page.getByTestId("viewport-canvas")).toBeVisible({
      timeout: 15_000,
    });

    await openClassPrefab(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    await expect(page.getByTestId("prefab-preview-canvas")).toBeVisible();

    await openMainScene(page);
    await expect(page.getByTestId("viewport-canvas")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("virtualises a large Class graph and still picks Add Node", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    const classGraph = page
      .getByTestId("document-workspace-graph")
      .getByTestId("graph-editor");
    await expect(classGraph).toBeVisible();
    await seedMainGraph(page, 200);
    await expect(classGraph).toHaveAttribute("data-virtualize", "true");
    await expect
      .poll(async () =>
        Number(await classGraph.getAttribute("data-visible-node-count")),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () =>
        Number(await classGraph.getAttribute("data-visible-node-count")),
      )
      .toBeLessThan(80);

    await page
      .getByTestId("document-workspace-graph")
      .getByTestId("graph-add-node")
      .click();
    await expect(page.getByTestId("node-palette")).toBeVisible();
    await page.getByTestId("node-palette-search").fill("Log");
    await expect(page.getByTestId("node-palette-item-debug.log")).toBeVisible();
    await page.getByTestId("node-palette-item-debug.log").click();
    await expect(page.getByTestId("node-palette")).toHaveCount(0);

    await openOrCreateAsset(
      page,
      "BehaviourTree",
      "P18OptTree",
      "assets/P18OptTree.bt.babasset",
    );
    const treeWorkspace = page.getByTestId("document-workspace-behaviour-tree");
    await expect(treeWorkspace).toBeVisible({ timeout: 15_000 });
    await expect(
      treeWorkspace.getByTestId("graph-editor"),
    ).toHaveAttribute("data-virtualize", "true");
  });

  test("caps warm Class tabs and Play still boots after idle-unmount", async ({
    page,
  }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await openMainScene(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("document-workspace-graph")).toBeVisible();

    await openMainScene(page);
    await expect(page.getByTestId("document-workspace-graph")).toHaveCount(1);

    for (const name of ["P18OptA", "P18OptB", "P18OptC", "P18OptD"]) {
      await openOrCreateAsset(
        page,
        "Class",
        name,
        `assets/${name}.class.babasset`,
      );
      await expect(visibleGraphWorkspace(page)).toBeVisible();
    }

    await expect(page.getByTestId("document-workspace-graph")).toHaveCount(3);
    await expect(page.getByTestId("document-workspace-scene")).toHaveCount(0);

    await openContentBrowser(page);
    await advanceIdleClock(page, DOCUMENT_IDLE_UNMOUNT_MS);
    await expect(page.getByTestId("document-workspace-graph")).toHaveCount(0);
    await expect(page.getByTestId("document-workspace-scene")).toHaveCount(0);

    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);

    await page
      .locator('[data-testid="document-tab"][data-document-kind="graph"]')
      .first()
      .getByTestId("document-tab-select")
      .click();
    await expect(visibleGraphWorkspace(page)).toBeVisible();
  });

  test("overlay Play keeps ticking after Scene idle grace", async ({ page }) => {
    test.setTimeout(E2E_TIMEOUT_MS);
    await openTestProject(page);
    await openMainScene(page);
    await expect(page.getByTestId("document-workspace-scene")).toHaveCount(1);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("document-workspace-graph")).toBeVisible();

    await clickPlayAndWaitForOverlay(page);
    await page.getByTestId("play-inspector-toggle").click();
    await expect(page.getByTestId("debug-inspect")).toBeVisible();
    const firstTick = Number(
      await page.getByTestId("debug-inspect-tick").getAttribute("data-tick"),
    );
    await expect
      .poll(
        async () =>
          Number(
            await page.getByTestId("debug-inspect-tick").getAttribute("data-tick"),
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(firstTick);

    const runningTick = Number(
      await page.getByTestId("debug-inspect-tick").getAttribute("data-tick"),
    );
    await advanceIdleClock(page, DOCUMENT_IDLE_UNMOUNT_MS);
    await expect(page.getByTestId("document-workspace-scene")).toHaveCount(1);
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    const afterIdleTick = Number(
      await page.getByTestId("debug-inspect-tick").getAttribute("data-tick"),
    );
    expect(afterIdleTick).toBeGreaterThanOrEqual(runningTick);
    await expect
      .poll(
        async () =>
          Number(
            await page.getByTestId("debug-inspect-tick").getAttribute("data-tick"),
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(afterIdleTick);

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  });
});
