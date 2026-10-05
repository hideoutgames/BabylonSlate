import { expect, test } from "@playwright/test";
import { openTestProject } from "./open-test-project";

// Bundle-only: a module-scope alias of the project root id was evaluated
// before its chunk initialized, so the root crumb fell back to "assets".
test("Content Browser names the project root Content in its folder location", async ({ page }) => {
  await openTestProject(page);
  const location = page.getByRole("navigation", { name: "Folder Location" });
  await expect(location).toBeVisible();
  await expect(location).toContainText("Content");
  await expect(location).not.toContainText("assets");
});
