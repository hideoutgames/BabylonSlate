import { expect, test } from "@playwright/test";

test.describe("BabylonSlate editor smoke", () => {
  test("loads shell, opens project, and shows viewport canvas", async ({
    page,
  }) => {
    await page.goto("/?test=1");

    await expect(page.getByTestId("editor-toolbar")).toBeVisible();
    await expect(page.getByTestId("test-mode-badge")).toHaveText("Test mode");

    await page.getByTestId("open-project").click();
    await expect(page.getByTestId("project-name")).toContainText(
      "TestProject.babylonslate",
    );

    await expect(page.getByTestId("document-tab-bar")).toBeVisible();
    await expect(page.getByTestId("document-tab")).toHaveCount(2);
    await expect(page.getByTestId("document-tab-active")).toBeVisible();
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(page.getByText("Viewport")).toBeVisible();

    await page
      .locator('[data-testid="document-tab"][data-document-kind="graph"]')
      .getByTestId("document-tab-select")
      .click();
    await expect(page.getByTestId("document-workspace-graph")).toBeVisible();
    await expect(
      page.getByTestId("document-workspace-graph").getByText("Graph", {
        exact: true,
      }),
    ).toBeVisible();

    await page.getByTestId("save-project").click();
    await expect(
      page.getByTestId("document-workspace-graph").locator("canvas"),
    ).toHaveCount(0);

    await page
      .locator('[data-testid="document-tab"][data-document-kind="scene"]')
      .getByTestId("document-tab-select")
      .click();
    await expect(
      page.getByTestId("document-workspace-scene").locator("canvas"),
    ).toBeVisible();
  });
});
