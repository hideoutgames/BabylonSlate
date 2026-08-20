import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import {
  openAssetFromBrowser,
  openMainScene,
  openTestProject,
} from "./open-test-project";

async function showContentBrowser(page: Page): Promise<void> {
  await page
    .locator(
      '[data-testid="document-tab"][data-document-kind="content-browser"]',
    )
    .click();
  await expect(
    page.getByTestId("document-workspace-content-browser"),
  ).toBeVisible();
}

async function createAsset(
  page: Page,
  type: "Enum" | "ScriptInterface" | "Class",
  name: string,
): Promise<void> {
  await showContentBrowser(page);
  await page.getByTestId("content-browser-new-asset").click();
  await expect(
    page.getByTestId("content-browser-new-asset-dialog"),
  ).toBeVisible();
  await page.getByTestId("new-asset-type").click();
  await page.getByTestId(`new-asset-type-${type}`).click();
  await page.getByTestId("new-asset-name").fill(name);
  await page.getByTestId("content-browser-new-asset-create").click();
  await expect(
    page.getByTestId("content-browser-new-asset-dialog"),
  ).toHaveCount(0);
}

async function dragTreeRow(
  page: Page,
  fromId: string,
  toId: string,
): Promise<void> {
  const from = page.getByTestId(`tree-row-${fromId}`);
  const to = page.getByTestId(`tree-row-${toId}`);
  await expect(from).toBeVisible();
  await expect(to).toBeVisible();
  const fromBox = await from.boundingBox();
  const toBox = await to.boundingBox();
  expect(fromBox).not.toBeNull();
  expect(toBox).not.toBeNull();
  const fromX = fromBox!.x + Math.min(40, fromBox!.width / 2);
  const fromY = fromBox!.y + fromBox!.height / 2;
  const toX = toBox!.x + Math.min(40, toBox!.width / 2);
  const toY = toBox!.y + toBox!.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 16 });
  await page.mouse.up();
}

async function dragClassMemberOntoGraph(
  page: Page,
  memberLabel: string,
): Promise<void> {
  const row = page
    .getByTestId("my-blueprint-tree")
    .locator('[data-testid^="tree-row-"]')
    .filter({ hasText: memberLabel })
    .first();
  const pane = page.getByTestId("graph-panel").locator(".react-flow__pane");
  await expect(row).toBeVisible();
  await expect(pane).toBeVisible();
  const fromBox = await row.boundingBox();
  const toBox = await pane.boundingBox();
  expect(fromBox).not.toBeNull();
  expect(toBox).not.toBeNull();
  const fromX = fromBox!.x + Math.min(40, fromBox!.width / 2);
  const fromY = fromBox!.y + fromBox!.height / 2;
  const toX = toBox!.x + toBox!.width / 2;
  const toY = toBox!.y + toBox!.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 16 });
  await page.mouse.up();
}


async function classGraphNodeCount(page: import("@playwright/test").Page) {
  return page.getByTestId("graph-panel").locator(".react-flow__node").count();
}

test.describe("Type-asset editors and hierarchy chrome", () => {
  test("ScriptInterface Add Method shows a preview and enables Windows", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "ScriptInterface", "IHit");
    await page.locator('[data-asset-path="assets/IHit.babasset"]').dblclick();
    await expect(
      page.getByTestId("document-workspace-script-interface"),
    ).toBeVisible();
    await expect(page.getByTestId("windows-menu")).toBeEnabled();
    await expect(page.getByTestId("interface-methods-empty")).toBeVisible();
    await page.getByTestId("interface-add-method").click();
    await expect(page.getByTestId("interface-method-0")).toBeVisible();
    await expect(page.getByTestId("interface-preview-panel")).toBeVisible();
    await expect(page.getByTestId("graph-editor")).toHaveAttribute(
      "data-readonly",
      "true",
    );
  });

  test("Enum add member appears in the Members table", async ({ page }) => {
    await openTestProject(page);
    await createAsset(page, "Enum", "Palette");
    await page
      .locator('[data-asset-path="assets/Palette.babasset"]')
      .dblclick();
    await expect(page.getByTestId("document-workspace-enum")).toBeVisible();
    await expect(page.getByTestId("enum-row-0")).toBeVisible();
    await page.getByTestId("enum-add-member").click();
    await expect(page.getByTestId("enum-row-1")).toBeVisible();
  });

  test("Class panel add variable opens PinTypePicker in Inspector", async ({
    page,
  }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("my-class-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("class-add-variables").click();
    await page.getByTestId("name-prompt-input").fill("Health");
    await page.getByTestId("name-prompt-confirm").click();
    await expect(page.getByTestId("inspector-member-type")).toBeVisible();
    await expect(page.getByTestId("class-add-local-variables")).toHaveCount(0);

    await page.getByTestId("class-add-functions").click();
    await page.getByTestId("add-function-name").fill("Jump");
    await page.getByTestId("add-function-confirm").click();
    await expect(page.getByTestId("class-add-local-variables")).toBeVisible();
    await page
      .getByTestId("my-class-panel")
      .getByText("Event Begin Play", { exact: true })
      .click();
    await expect(page.getByTestId("class-add-local-variables")).toHaveCount(0);
  });

  test("Object Reference variables show Class Type and drag opens Get/Set", async ({
    page,
  }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("my-class-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("class-add-variables").click();
    await page.getByTestId("name-prompt-input").fill("Target");
    await page.getByTestId("name-prompt-confirm").click();
    await expect(page.getByTestId("inspector-member-type")).toBeVisible();
    await page.getByTestId("inspector-member-type").click();
    await page.getByTestId("search-item-object").click();
    await expect(page.getByTestId("inspector-member-class-type")).toBeVisible();
    await expect(page.getByTestId("inspector-member-class-default")).toHaveCount(
      0,
    );

    const graph = page.getByTestId("graph-panel");
    const nodes = graph.locator(".react-flow__node");
    const baseline = await classGraphNodeCount(page);
    expect(baseline).toBeGreaterThan(0);
    await dragClassMemberOntoGraph(page, "Target");
    await expect(page.getByTestId("member-access-chooser")).toBeVisible();
    await expect(page.getByTestId("member-access-validated-get")).toBeVisible();
    await page.getByTestId("member-access-get").click();
    await expect(page.getByTestId("member-access-chooser")).toHaveCount(0);
    await expect(nodes).toHaveCount(baseline + 1);
    await expect(graph.getByText("Get Target")).toBeVisible();
    await dragClassMemberOntoGraph(page, "Target");
    await page.getByTestId("member-access-validated-get").click();
    await expect(nodes).toHaveCount(baseline + 2);
    await expect(graph.getByText("Validated Get Target")).toBeVisible();
  });

  test("Class variables show Class Type and omit a Default", async ({
    page,
  }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("my-class-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("class-add-variables").click();
    await page.getByTestId("name-prompt-input").fill("Kind");
    await page.getByTestId("name-prompt-confirm").click();
    await expect(page.getByTestId("inspector-member-type")).toBeVisible();
    await page.getByTestId("inspector-member-type").click();
    await page.getByTestId("search-item-class").click();
    await expect(page.getByTestId("inspector-member-class-type")).toBeVisible();
    await expect(page.getByTestId("inspector-member-class-default")).toHaveCount(
      0,
    );
  });

  test("dragging a Class function onto the graph spawns Call Function", async ({
    page,
  }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("my-class-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("class-add-functions").click();
    await page.getByTestId("add-function-name").fill("Jump");
    await page.getByTestId("add-function-confirm").click();
    await page
      .getByTestId("my-class-panel")
      .getByText("Event Begin Play", { exact: true })
      .click();
    const graph = page.getByTestId("graph-panel");
    const nodes = graph.locator(".react-flow__node");
    const baseline = await classGraphNodeCount(page);
    expect(baseline).toBeGreaterThan(0);
    await dragClassMemberOntoGraph(page, "Jump");
    await expect(nodes).toHaveCount(baseline + 1);
    await expect(graph.getByText("Call Jump")).toBeVisible();
  });

  test("Outliner immediate drag parents an actor; row menu deletes", async ({
    page,
  }) => {
    await openTestProject(page);
    await openMainScene(page);
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("outliner-add-actor").click();
    await page.getByTestId("place-actors-item-shape-box").click();
    await expect(page.getByTestId("place-actors-catalog")).toHaveCount(0);
    await expect(page.getByTestId("tree-row-actor:actor-2")).toBeVisible();
    await expect(page.getByTestId("tree-row-actor:actor-2")).toHaveAttribute(
      "data-depth",
      "0",
    );
    await dragTreeRow(page, "actor:actor-2", "actor:actor-1");
    await expect(page.getByTestId("tree-row-actor:actor-2")).toHaveAttribute(
      "data-depth",
      "1",
    );

    await page.getByTestId("outliner-menu-actor-2").click();
    await page.getByTestId("outliner-delete-actor-2").click();
    await expect(page.getByTestId("tree-row-actor:actor-2")).toHaveCount(0);
  });

  test("Components drag-to-parent nests under another component", async ({
    page,
  }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("actor-prefab-panel")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("tree-row-prefab-mesh")).toBeVisible();
    await page.getByTestId("prefab-add-component").click();
    await page
      .getByTestId("prefab-add-component-catalog-item-LightComponent")
      .click();
    await expect(page.getByTestId("prefab-add-component-catalog")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("save-all-dirty")).toBeVisible();
    const tree = page.getByTestId("prefab-tree");
    const child = tree.locator('[data-testid^="tree-row-prefab-component-"]');
    await expect(child).toBeVisible();
    const childId = await child.getAttribute("data-testid");
    expect(childId).toBeTruthy();
    const id = childId!.replace("tree-row-", "");
    await expect(child).toHaveAttribute("data-depth", "1");
    await dragTreeRow(page, id, "prefab-mesh");
    await expect(child).toHaveAttribute("data-depth", "2");
  });

  test("Add Component binds a project Model onto MeshComponent", async ({
    page,
  }) => {
    await openTestProject(page);
    await showContentBrowser(page);
    const heroTile = page.locator('[data-asset-path="assets/hero.babasset"]');
    await page.getByTestId("content-browser-search").fill("hero");
    if ((await heroTile.count()) === 0) {
      await page.getByTestId("content-browser-search").fill("");
      await page
        .getByTestId("content-browser-import-input")
        .setInputFiles([path.join(process.cwd(), "e2e/fixtures/hero.glb")]);
      await page.getByTestId("content-browser-search").fill("hero");
      await expect(heroTile).toBeVisible({ timeout: 15_000 });
    }
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("actor-prefab-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("prefab-add-component").click();
    await page
      .getByTestId("prefab-add-component-catalog-search")
      .fill("hero");
    await page
      .locator('[data-testid^="prefab-add-component-catalog-item-asset-"]')
      .click();
    await expect(page.getByTestId("prefab-add-component-catalog")).toHaveCount(
      0,
    );
    await expect(
      page.getByTestId("prefab-tree").getByText("Mesh (hero)"),
    ).toBeVisible();
    await expect(page.getByTestId("inspector-prefab-component")).toContainText(
      "hero",
    );
  });

  test("selecting a prefab component shows Position Rotation and Scale", async ({
    page,
  }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("actor-prefab-panel")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("tree-row-prefab-mesh")).toBeVisible();
    await page.getByTestId("tree-row-prefab-mesh").click();
    await expect(
      page.getByTestId("property-vector3-prefab-mesh-position"),
    ).toBeVisible();
    await expect(
      page.getByTestId("property-vector3-prefab-mesh-rotation"),
    ).toBeVisible();
    await expect(
      page.getByTestId("property-vector3-prefab-mesh-scale"),
    ).toBeVisible();
  });

  test("dirty Class tab close prompts Save / Discard / Cancel", async ({
    page,
  }) => {
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    await expect(page.getByTestId("actor-prefab-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("prefab-add-component").click();
    await page
      .getByTestId("prefab-add-component-catalog-item-LightComponent")
      .click();
    await expect(page.getByTestId("save-all-dirty")).toBeVisible();
    await page
      .locator('[data-testid="document-tab"][data-document-kind="graph"]')
      .getByTestId("document-tab-close")
      .click();
    await expect(page.getByTestId("dirty-close-dialog")).toBeVisible();
    await page.getByTestId("dirty-cancel").click();
    await expect(page.getByTestId("dirty-close-dialog")).toHaveCount(0);
    await expect(page.getByTestId("actor-prefab-panel")).toBeVisible();
    await expect(page.getByTestId("save-all-dirty")).toBeVisible();
  });
});
