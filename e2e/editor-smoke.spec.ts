import { expect, test } from "@playwright/test";

test.describe("BabylonSlate editor smoke", () => {
  test("loads shell, opens project, and shows viewport canvas", async ({
    page,
  }) => {
    await page.goto("/?test=1");

    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await expect(page.getByTestId("test-mode-badge")).toHaveText("Test mode");
    await expect(page.getByTestId("project-settings")).toBeVisible();

    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="content-browser"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="content-browser"] [data-testid="document-tab-close"]'),
    ).toHaveCount(0);

    await page.getByTestId("open-project").click();
    await expect(page.getByTestId("project-name")).toContainText(
      "TestProject.babylonslate",
    );

    await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Content Browser" }),
    ).toBeVisible();
    await expect(page.getByTestId("content-item-scenes/main.scene.json")).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);

    await page.getByTestId("content-item-scenes/main.scene.json").click();
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(page.getByText("Viewport")).toBeVisible();

    await page
      .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
      .getByTestId("document-tab-select")
      .click();
    await page.getByTestId("content-item-graphs/main.graph.json").click();
    await expect(page.getByTestId("document-workspace-graph")).toBeVisible();
    await expect(
      page.getByTestId("document-workspace-graph").getByText("Graph", {
        exact: true,
      }),
    ).toBeVisible();

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
    await page.goto("/?test=1");
    await page.getByTestId("open-project").click();
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);

    await page.getByTestId("save-project").click();
    await page.reload();
    await page.getByTestId("open-project").click();
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
  });
});
