import { expect, test } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import { openMainScene, openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

// Shared TestProject OPFS name — keep these serial to avoid cross-test stomps.
test.describe.configure({ mode: "serial" });

test.describe("Scene Outliner folders", () => {
  test("creates, fills, renames, and persists a folder across reopen", async ({
    page,
  }) => {
    await openTestProject(page);
    await openMainScene(page);
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId("outliner-add-folder").click();
    await expect(page.getByTestId("tree-row-folder:folder-1")).toBeVisible();
    await expect(page.getByTestId("tree-row-folder:folder-1")).toContainText(
      "New Folder",
    );

    await page.getByTestId("outliner-menu-folder:folder-1").click();
    await page.getByTestId("outliner-rename-folder-folder-1").click();
    await page.getByTestId("name-prompt-input").fill("Lighting");
    await page.getByTestId("name-prompt-confirm").click();
    await expect(page.getByTestId("tree-row-folder:folder-1")).toContainText(
      "Lighting",
    );

    await saveAllIfEnabled(page);
    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page.getByTestId("open-listed-project-TestProject.babproject").click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await openMainScene(page);

    await expect(page.getByTestId("tree-row-folder:folder-1")).toContainText(
      "Lighting",
      { timeout: 15_000 },
    );
    // Folders are editor-only, so the scene still owns its actors.
    await expect(page.getByTestId("tree-row-actor:actor-1")).toBeVisible();
  });

  test("a placed camera exposes Attempt Possess View Target, off by default", async ({
    page,
  }) => {
    await openTestProject(page);
    await openMainScene(page);
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId("outliner-add-actor").click();
    await page.getByTestId("place-actors-item-camera").click();
    await expect(page.getByTestId("place-actors-catalog")).toHaveCount(0);

    // Place Actors uses the view center, not the origin Cube.
    await expect(page.getByTestId("property-actor-position-x")).not.toHaveValue("0");

    const toggle = page.getByTestId(
      "property-actor-2-actor-2-camera-attemptPossessViewTarget",
    );
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();

    await toggle.click();
    await expect(toggle).toBeChecked();
  });

  test("undo restores a deleted folder without losing its actor", async ({
    page,
  }) => {
    await openTestProject(page);
    await openMainScene(page);
    await expect(page.getByTestId("scene-outliner-panel")).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId("outliner-add-folder").click();
    await expect(page.getByTestId("tree-row-folder:folder-1")).toBeVisible();

    await page.getByTestId("outliner-menu-folder:folder-1").click();
    await page.getByTestId("outliner-delete-folder-folder-1").click();
    await expect(page.getByTestId("tree-row-folder:folder-1")).toHaveCount(0);
    // The default Cube must survive a folder delete.
    await expect(page.getByTestId("tree-row-actor:actor-1")).toBeVisible();

    await page.getByTestId("undo-document").click();
    await expect(page.getByTestId("tree-row-folder:folder-1")).toBeVisible();
    await expect(page.getByTestId("tree-row-actor:actor-1")).toBeVisible();
  });
});
