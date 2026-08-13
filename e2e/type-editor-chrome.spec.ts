import { expect, test, type Page } from "@playwright/test";
import { openTestProject } from "./open-test-project";

async function showContentBrowser(page: Page): Promise<void> {
  await page
    .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
    .click();
  await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
}

async function createAsset(
  page: Page,
  type: "Enum" | "ScriptInterface" | "Class",
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

async function dragTreeRow(page: Page, fromId: string, toId: string): Promise<void> {
  const from = page.getByTestId(`tree-row-${fromId}`);
  const to = page.getByTestId(`tree-row-${toId}`);
  const fromBox = await from.boundingBox();
  const toBox = await to.boundingBox();
  expect(fromBox).not.toBeNull();
  expect(toBox).not.toBeNull();
  await page.mouse.move(fromBox!.x + 24, fromBox!.y + fromBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(toBox!.x + 24, toBox!.y + toBox!.height / 2, { steps: 10 });
  await page.mouse.up();
}

test.describe("Type-asset editors and hierarchy chrome", () => {
  test("ScriptInterface Add Method shows a preview and enables Windows", async ({
    page,
  }) => {
    await openTestProject(page);
    await createAsset(page, "ScriptInterface", "IHit");
    await page.locator('[data-asset-path="assets/IHit.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-script-interface")).toBeVisible();
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
    await page.locator('[data-asset-path="assets/Palette.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-enum")).toBeVisible();
    await expect(page.getByTestId("enum-row-0")).toBeVisible();
    await page.getByTestId("enum-add-member").click();
    await expect(page.getByTestId("enum-row-1")).toBeVisible();
  });

  test("Class panel add variable opens PinTypePicker in Inspector", async ({
    page,
  }) => {
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.class.babasset"]')
      .dblclick();
    await expect(page.getByTestId("my-class-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("class-add-member").click();
    await page.getByTestId("class-add-variables").click();
    await page.getByTestId("name-prompt-input").fill("Health");
    await page.getByTestId("name-prompt-confirm").click();
    await expect(page.getByTestId("inspector-member-type")).toBeVisible();
  });

  test("Outliner immediate drag parents an actor; row menu deletes", async ({
    page,
  }) => {
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.scene.babasset"]')
      .dblclick();
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("outliner-add-actor").click();
    await page.getByTestId("place-actors-item-shape-box").click();
    await expect(page.getByTestId("tree-row-actor-2")).toBeVisible();
    const before = await page.getByTestId("tree-row-actor-2").evaluate((el) =>
      getComputedStyle(el).paddingLeft,
    );
    await dragTreeRow(page, "actor-2", "actor-1");
    await expect
      .poll(async () =>
        page.getByTestId("tree-row-actor-2").evaluate((el) =>
          getComputedStyle(el).paddingLeft,
        ),
      )
      .not.toBe(before);

    await page.getByTestId("outliner-menu-actor-2").click();
    await page.getByTestId("outliner-delete-actor-2").click();
    await expect(page.getByTestId("tree-row-actor-2")).toHaveCount(0);
  });

  test("Components drag-to-parent nests under another component", async ({
    page,
  }) => {
    await openTestProject(page);
    await page
      .locator('[data-asset-path="assets/main.class.babasset"]')
      .dblclick();
    await expect(page.getByTestId("actor-prefab-panel")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("tree-row-prefab-mesh")).toBeVisible();
    await page.getByTestId("prefab-add-component").click();
    await page
      .getByTestId("prefab-add-component-catalog-item-LightComponent")
      .click();
    const child = page.locator('[data-testid^="tree-row-prefab-component-"]');
    await expect(child).toBeVisible();
    const childId = await child.getAttribute("data-testid");
    expect(childId).toBeTruthy();
    const id = childId!.replace("tree-row-", "");
    const before = await child.evaluate((el) => getComputedStyle(el).paddingLeft);
    await dragTreeRow(page, id, "prefab-mesh");
    await expect
      .poll(async () => child.evaluate((el) => getComputedStyle(el).paddingLeft))
      .not.toBe(before);
  });
});
