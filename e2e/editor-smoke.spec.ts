import { expect, test } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";

async function openTestProject(page: import("@playwright/test").Page) {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("create-project-empty").click();
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
}

test.describe("BabylonSlate editor smoke", () => {
  test("loads shell, opens project, and shows viewport canvas", async ({
    page,
  }) => {
    await openTestProject(page);

    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await expect(page.getByTestId("editor-global-toolbar")).toBeVisible();
    await expect(page.getByTestId("settings-menu")).toBeVisible();

    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="content-browser"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="content-browser"] [data-testid="document-tab-close"]'),
    ).toHaveCount(0);

    await expect(page.getByTestId("project-name")).toContainText("TestProject");

    await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
    await expect(
      page.locator('[data-asset-path="assets/main.scene.babasset"]'),
    ).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);

    await page.locator('[data-asset-path="assets/main.scene.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(page.getByTestId("viewport-panel")).toBeVisible();

    await page
      .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
      .getByTestId("document-tab-select")
      .click();
    await page.locator('[data-asset-path="assets/main.graph.babasset"]').dblclick();
    await expect(page.getByTestId("document-workspace-graph")).toBeVisible();
    await expect(page.getByTestId("graph-panel")).toBeVisible();
    await expect(page.getByTestId("actor-prefab-panel")).toBeVisible();
    await expect(
      page.getByTestId("actor-prefab-panel").getByTestId("prefab-preview-canvas"),
    ).toHaveCount(0);

    await page.locator(".dv-tab").filter({ hasText: "Prefab" }).click();
    await expect(page.getByTestId("prefab-viewport-panel")).toBeVisible();
    const prefabCanvas = page.getByTestId("prefab-preview-canvas");
    await expect(prefabCanvas).toBeVisible();
    const prefabBox = await prefabCanvas.boundingBox();
    expect(prefabBox, "prefab canvas should fill the center tab").not.toBeNull();
    expect(prefabBox!.height).toBeGreaterThan(160);

    await page.getByTestId("save-project").click();

    await page
      .locator('[data-testid="document-tab"][data-document-kind="scene"]')
      .getByTestId("document-tab-select")
      .click();
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(
      page.getByTestId("document-workspace-scene").locator("canvas"),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("does not mount viewport canvas until scene tab is opened", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);

    await page.getByTestId("save-project").click();
    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page.getByTestId("create-project-empty").click();
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
  });

  test("cold-reopens an OPFS project from the Homepage without a prompt", async ({
    page,
  }) => {
    await openTestProject(page);
    await page.getByTestId("save-project").click();
    await expect(page.getByTestId("project-name")).toContainText("TestProject");
    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("homepage")).toBeVisible();
    await expect(
      page.getByTestId("open-listed-project-TestProject.babproject"),
    ).toBeVisible();

    await page
      .getByTestId("open-listed-project-TestProject.babproject")
      .click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await expect(page.getByTestId("project-name")).toContainText("TestProject");
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
  });
});
