import { expect, test, type Page } from "@playwright/test";
import { openMainScene, openTestProject } from "./open-test-project";
import { pickCatalogItem } from "./pick-catalog-item";
import { clickPlayAndWaitForOverlay } from "./play";

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
  componentName: string,
  guid: string,
  property = "treeGuid",
): Promise<void> {
  const card = page.locator("[data-testid^='component-card-']").filter({
    has: page.getByRole("button", { name: new RegExp(`^${componentName}(?: \\(|$)`) }),
  });
  await expect(card).toBeVisible();
  await card.locator(`button[data-testid$="-${property}"]`).click();
  const picker = page.getByTestId("details-asset-picker");
  await expect(picker).toBeVisible();
  const item = page.getByTestId(`search-item-${guid}`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(picker).toBeHidden();
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

test.describe("P11 behaviour tree and navigation acceptance", () => {

  test("3D Place NavMesh + ground bakes, then Play starts", async ({ page }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openMainScene(page);

    await placeActor(page, "shape-ground");
    await placeActor(page, "navmesh");
    await placeActor(page, "navmesh-blocker");

    await page.getByTestId("outliner-tree").getByText("NavMesh", { exact: true }).click();
    const bake = page.getByRole("button", { name: "Bake NavMesh" });
    await expect(bake).toBeVisible();
    await bake.click();
    await expect(page.getByTestId("nav-bake-dialog")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("nav-bake-dialog")).toHaveCount(0, {
      timeout: 30_000,
    });

    await clickPlayAndWaitForOverlay(page);
    await page.getByTestId("play-overlay-close").click();
  });

  test("tree editor can add a Wait child, set duration, add a decorator, and remove it", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "BehaviourTree", "Patrol");
    await page.locator('[data-asset-path="assets/Patrol.bt.babasset"]').dblclick();
    await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();
    await expect(page.getByTestId("bt-node-root")).toBeVisible();

    const graph = page.getByTestId("graph-editor");
    await expect(graph).toBeVisible();
    await openGraphNodePalette(page);
    await page.getByTestId("node-palette-search").fill("Wait");
    await page.getByTestId("node-palette-item-bt.task.wait").click();
    await expect(page.getByTestId("node-palette")).toHaveCount(0);
    const duration = page.getByTestId("property-durationMs");
    await expect(duration).toBeVisible({ timeout: 15_000 });
    await duration.fill("250");
    await duration.blur();

    await page.getByTestId("bt-add-decorator").click();
    await expect(page.getByTestId("bt-attachment-catalog")).toBeVisible();
    await page.getByTestId("bt-attachment-item-bt.decorator.blackboardIsSet").click();
    const keyField = page.getByTestId("property-key");
    await expect(keyField).toBeVisible();
    if ((await keyField.evaluate((el) => el.tagName)) === "INPUT") {
      await keyField.fill("alert");
    }

    await page.getByTestId("bt-remove-attachment").click();
    await expect(page.getByTestId("bt-remove-attachment")).toHaveCount(0);
  });

  test("task throw session report focuses the tree node", async ({ page }, testInfo) => {
    // Leave room to attach the original preparation log after Play's own
    // bounded wait, rather than losing it to the overall test deadline.
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openTestProject(page, "/?test=1&previewThrow=1");
    await createAsset(page, "BehaviourTree", "Patrol");
    await page.locator('[data-asset-path="assets/Patrol.bt.babasset"]').dblclick();
    await expect(page.getByTestId("behaviour-tree-editor")).toBeVisible();

    await openMainScene(page);
    await placeActor(page, "empty");
    await page.getByTestId("details-add-component").click();
    await pickCatalogItem(
      page,
      "add-component-catalog",
      "BehaviourTreeComponent",
      "Behaviour Tree",
    );
    const treeGuid = await guidForPath(page, "assets/Patrol.bt.babasset");
    expect(treeGuid.length).toBeGreaterThan(0);
    await pickSelectedAsset(page, "Behaviour Tree", treeGuid);

    // Mount the log before an overlay or premature session report can cover
    // its tab; diagnostic reads below work without dismissing either surface.
    await page.getByRole("tab", { name: "Output Log", exact: true }).click();
    try {
      await clickPlayAndWaitForOverlay(page);
      await page.getByTestId("play-overlay-close").click({ timeout: 5_000 });
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
    } catch (error) {
      await testInfo.attach("task-throw-play-preparation", {
        body: JSON.stringify({
          errors,
          output: await page.getByTestId("output-log-line").allTextContents(),
          report: await page.getByTestId("session-report-row").evaluateAll((rows) => rows.map((row) => ({
            nodeId: row.getAttribute("data-node-id"),
            text: row.textContent,
          }))),
        }),
        contentType: "application/json",
      });
      throw error;
    }
  });
});
