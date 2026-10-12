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

    const folderRow = page.getByTestId("tree-row-folder:folder-1");
    const actorRow = page.getByTestId("tree-row-actor:actor-1");
    await page.getByTestId("outliner-add-folder").click();
    await expect(folderRow).toBeVisible();
    await expect(folderRow).toContainText("New Folder");
    await expect(actorRow).toHaveAttribute("aria-level", "1");

    // Drop the actor on the middle of the folder row to group it there.
    const actorBox = await actorRow.boundingBox();
    const folderBox = await folderRow.boundingBox();
    expect(actorBox).not.toBeNull();
    expect(folderBox).not.toBeNull();
    await page.mouse.move(actorBox!.x + 24, actorBox!.y + actorBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      folderBox!.x + 24,
      folderBox!.y + folderBox!.height / 2,
      { steps: 8 },
    );
    await expect(folderRow).toHaveAttribute("data-drop-target", "true");
    await page.mouse.up();
    await expect(folderRow).toHaveAttribute("aria-expanded", "true");
    await expect(actorRow).toHaveAttribute("aria-level", "2");

    await page.getByTestId("outliner-menu-folder:folder-1").click();
    await page.getByTestId("outliner-rename-folder-folder-1").click();
    await page.getByTestId("name-prompt-input").fill("Lighting");
    await page.getByTestId("name-prompt-confirm").click();
    await expect(folderRow).toContainText("Lighting");

    await saveAllIfEnabled(page);
    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page.getByTestId("open-listed-project-TestProject").click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await openMainScene(page);

    await expect(folderRow).toContainText("Lighting", { timeout: 15_000 });
    // The saved actor reopens inside the renamed folder.
    await expect(folderRow).toHaveAttribute("aria-expanded", "true");
    await expect(actorRow).toHaveAttribute("aria-level", "2");
  });
});
