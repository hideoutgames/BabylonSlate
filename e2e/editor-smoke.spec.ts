import { expect, test } from "@playwright/test";

test.describe("BabylonSlate editor smoke", () => {
  test("loads shell, opens project, and shows viewport canvas", async ({
    page,
  }) => {
    await page.goto("/?test=1");

    await expect(page.getByTestId("editor-toolbar")).toBeVisible();
    await expect(page.getByTestId("test-mode-badge")).toHaveText("Test mode");
    await expect(page.getByText("Viewport")).toBeVisible();
    await expect(page.getByText("Graph")).toBeVisible();

    await page.getByTestId("open-project").click();
    await expect(page.getByTestId("project-name")).toContainText(
      "TestProject.babylonslate",
    );

    await page.getByTestId("save-project").click();
    await expect(page.locator("canvas")).toBeVisible();
  });
});
