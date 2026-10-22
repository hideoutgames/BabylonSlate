import { expect, test, type Page } from "@playwright/test";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openTestProject,
} from "./open-test-project";

const SOURCE_CLASS = "assets/Mannequin.class.hasset";
const TARGET_CLASS = "assets/CopyTarget.class.hasset";

/** Open Class documents keep their windows mounted; only the visible one is in play. */
const classPanel = (page: Page) => page.locator('[data-testid="my-class-panel"]:visible');
const entry = (page: Page, label: string) =>
  classPanel(page).getByText(label, { exact: true });

async function addVariable(page: Page, name: string): Promise<void> {
  await classPanel(page).getByTestId("class-add-variables").click();
  await page.getByTestId("search-item-float").click();
  const rename = page.getByRole("textbox", { name: "Rename NewVariable" });
  await rename.fill(name);
  await rename.press("Enter");
}

async function addFunction(page: Page, name: string): Promise<void> {
  await classPanel(page).getByTestId("class-add-functions").click();
  await page.getByTestId("add-function-menu").getByTestId("search-item-__new__").click();
  const rename = page.getByRole("textbox", { name: "Rename NewFunction" });
  await rename.fill(name);
  await rename.press("Enter");
}

test("copies members from one Class and pastes them into another as one undoable step", async ({ page }) => {
  test.setTimeout(150_000);
  await openTestProject(page);
  await createContentBrowserAsset(page, "Class", "CopyTarget", "Actor");

  await openAssetFromBrowser(page, SOURCE_CLASS);
  await expect(classPanel(page)).toBeVisible({ timeout: 15_000 });
  await addVariable(page, "Stamina");
  await addFunction(page, "Sprint");

  // Select a variable, a function and Begin Play together, then copy them.
  await entry(page, "Stamina").click();
  await entry(page, "Sprint").click({ modifiers: ["ControlOrMeta"] });
  await entry(page, "Event Begin Play").click({ modifiers: ["ControlOrMeta"] });
  for (const label of ["Stamina", "Sprint", "Event Begin Play"]) {
    await expect(entry(page, label).locator('xpath=ancestor::*[@role="treeitem"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
  await page.keyboard.press("ControlOrMeta+c");

  // Another Class: the copy is still there. Paste from the context menu of the tree background.
  await openAssetFromBrowser(page, TARGET_CLASS);
  await expect(classPanel(page)).toBeVisible({ timeout: 15_000 });
  await expect(entry(page, "Stamina")).toHaveCount(0);
  const tree = classPanel(page).getByTestId("my-blueprint-tree");
  const box = (await tree.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 4, { button: "right" });
  await page.getByRole("menuitem", { name: "Paste" }).click();

  await expect(entry(page, "Stamina")).toHaveCount(1);
  await expect(entry(page, "Sprint")).toHaveCount(1);
  // A new Class already has Begin Play, so the copy arrives as a numbered custom event.
  await expect(entry(page, "Begin Play 1")).toHaveCount(1);

  // The whole paste is one Undo step.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(entry(page, "Stamina")).toHaveCount(0);
  await expect(entry(page, "Sprint")).toHaveCount(0);
  await expect(entry(page, "Begin Play 1")).toHaveCount(0);
});
