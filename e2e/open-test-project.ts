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
