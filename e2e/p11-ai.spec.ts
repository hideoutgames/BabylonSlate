import { expect, test, type Page } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";

async function showContentBrowser(page: Page): Promise<void> {
  await page
    .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
    .click();
  await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
}

async function createAsset(
  page: Page,
  type: "BehaviourTree" | "Blackboard",
  name: string,
): Promise<void> {
  await showContentBrowser(page);
  await page.getByTestId("content-browser-new-asset").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toBeVisible();
  await page.getByTestId("new-asset-type").click();
  await page.getByTestId(`new-asset-type-${type}`).click();
  await page.getByTestId("new-asset-name").fill(name);
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(0);
}

async function guidForPath(page: Page, path: string): Promise<string> {
  return page.evaluate((assetPath) => {
    const host = globalThis as {
      __babylonslateTest?: { guidForPath: (path: string) => string | null };
    };
    return host.__babylonslateTest?.guidForPath(assetPath) ?? "";
  }, path);
}

async function placeActor(page: Page, itemId: string): Promise<void> {
  await page.getByTestId("outliner-add-actor").click();
  await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
  await page.getByTestId("place-actors-catalog-search").fill(
    itemId.replace(/^shape-/, "").replace(/-/g, " "),
  );
  await page.getByTestId(`place-actors-item-${itemId}`).click();
}

async function pickSelectedAsset(
  page: Page,
  classId: string,
  guid: string,
  property = "treeGuid",
): Promise<void> {
  const card = page.locator("[data-testid^='component-card-']").filter({
    hasText: classId,
  });
  await expect(card).toBeVisible();
  await card.locator(`button[data-testid$="-${property}"]`).click();
  const item = page.getByTestId(`search-item-${guid}`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("details-asset-picker")).toBeHidden();
}

async function openTwoDProject(page: Page): Promise<void> {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("create-project").click();
  await expect(page.getByTestId("create-project-dialog")).toBeVisible();
  await page.getByTestId("create-project-2d").click();
  await page.getByTestId("create-project-submit").click();
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
}

test.describe("P11 behaviour tree and navigation acceptance", () => {
  test("New Asset BehaviourTree opens the tree editor", async ({ page }) => {
    await openTestProject(page);
    await createAsset(page, "BehaviourTree", "Patrol");
    await page.locator('[data-asset-path="assets/Patrol.bt.babasset"]').dblclick();
    await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();
    await expect(page.getByTestId("bt-node-root")).toBeVisible();
  });

  test("3D Place NavMesh + ground bakes, then Play starts", async ({ page }) => {
    await openTestProject(page);
    await openMainScene(page);

    await placeActor(page, "shape-ground");
    await placeActor(page, "navmesh");
    await placeActor(page, "navmesh-blocker");

    await page.getByTestId("outliner-tree").getByText("NavMesh", { exact: true }).click();
    await page.getByRole("button", { name: "Bake NavMesh" }).click();
    await expect(page.getByTestId("nav-bake-dialog")).toBeVisible();
    await expect(page.getByTestId("nav-bake-dialog")).toHaveCount(0, {
      timeout: 30_000,
    });

    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await page.getByTestId("play-overlay-close").click();
  });

  test("2D NavMesh bake uses the XY floor without MeshComponent", async ({
    page,
  }) => {
    await openTwoDProject(page);
    await openMainScene(page);
    await expect(page.getByTestId("viewport-mode-2d")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await placeActor(page, "navmesh");
    await page.getByTestId("outliner-tree").getByText("NavMesh", { exact: true }).click();
    await page.getByRole("button", { name: "Bake NavMesh" }).click();
    await expect(page.getByTestId("nav-bake-dialog")).toBeVisible();
    await expect(page.getByTestId("nav-bake-dialog")).toHaveCount(0, {
      timeout: 30_000,
    });
  });

  test("task throw session report focuses the tree node", async ({ page }) => {
    await openTestProject(page, "/?test=1&previewThrow=1");
    await createAsset(page, "BehaviourTree", "Patrol");
    await page.locator('[data-asset-path="assets/Patrol.bt.babasset"]').dblclick();
    await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();

    await openMainScene(page);
    await placeActor(page, "empty");
    await page.getByTestId("details-add-component").click();
    await page
      .getByTestId("add-component-catalog-item-BehaviourTreeComponent")
      .click();
    const treeGuid = await guidForPath(page, "assets/Patrol.bt.babasset");
    expect(treeGuid.length).toBeGreaterThan(0);
    await pickSelectedAsset(page, "BehaviourTreeComponent", treeGuid);

    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("play-overlay")).toBeVisible();
    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("preview-session-report")).toBeVisible();
    await expect(page.getByTestId("session-report-row")).toHaveAttribute(
      "data-node-id",
      "task",
    );
    await page.getByTestId("session-report-row").click();
    await expect(page.getByTestId("focused-graph-node")).toHaveAttribute(
      "data-node-id",
      "task",
    );
    await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();
  });
});
