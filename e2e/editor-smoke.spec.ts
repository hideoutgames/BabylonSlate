import { expect, test } from "@playwright/test";

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
    await expect(page.getByTestId("test-mode-badge")).toHaveText("Test mode");
    await expect(page.getByTestId("project-settings")).toBeVisible();

    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="content-browser"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="document-tab"][data-document-kind="content-browser"] [data-testid="document-tab-close"]'),
    ).toHaveCount(0);

    await expect(page.getByTestId("project-name")).toContainText(
      "TestProject.babproject",
    );

    await expect(page.getByTestId("document-workspace-content-browser")).toBeVisible();
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Content Browser" }),
    ).toBeVisible();
    await expect(page.getByTestId("content-item-assets/main.scene.babasset")).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);

    await page.getByTestId("content-item-assets/main.scene.babasset").click();
    await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
    await expect(page.getByText("Viewport")).toBeVisible();

    await page
      .locator('[data-testid="document-tab"][data-document-kind="content-browser"]')
      .getByTestId("document-tab-select")
      .click();
    await page.getByTestId("content-item-assets/main.graph.babasset").click();
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
    await openTestProject(page);
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);

    await page.getByTestId("save-project").click();
    await page.getByTestId("close-project").click();
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
    await expect(page.getByTestId("project-name")).toContainText(
      "TestProject.babproject",
    );
    await page.getByTestId("close-project").click();
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
    await expect(page.getByTestId("project-name")).toContainText(
      "TestProject.babproject",
    );
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
  });
});
