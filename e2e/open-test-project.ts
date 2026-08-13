import { expect, type Page } from "@playwright/test";

/** Homepage → Create Project dialog (test-mode name TestProject) → editor chrome. */
export async function openTestProject(
  page: Page,
  path = "/?test=1",
): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("create-project").click();
  await expect(page.getByTestId("create-project-dialog")).toBeVisible();
  await expect(page.getByTestId("create-project-name")).toHaveValue(
    "TestProject",
  );
  await expect(page.getByTestId("create-project-empty")).toHaveAttribute(
    "data-selected",
    "true",
  );
  await page.getByTestId("create-project-submit").click();
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
}

export async function openMainScene(page: Page): Promise<void> {
  await page.locator('[data-asset-path="assets/main.scene.babasset"]').dblclick();
  await expect(page.getByTestId("document-workspace-scene")).toBeVisible();
  await expect(page.getByTestId("viewport-canvas")).toBeVisible({
    timeout: 15_000,
  });
}
