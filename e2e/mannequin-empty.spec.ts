import { expect, test } from "@playwright/test";
import {
  openAssetFromBrowser,
  openMainScene,
  openTestProject,
} from "./open-test-project";

test.describe("3D Empty Kenney Mannequin", () => {
  test("new 3D Empty shows Mannequin, hierarchy bones, and a looping idle clip", async ({
    page,
  }) => {
    await openTestProject(page);
    await openMainScene(page);
    await expect(page.getByTestId("tree-row-actor:actor-1")).toContainText(
      "Mannequin",
    );
    await expect(page.getByTestId("tree-row-actor:actor-1")).not.toContainText(
      "Cube",
    );

    await openAssetFromBrowser(page, "assets/mannequin_Skeleton.babasset");
    await expect(page.getByTestId("document-workspace-skeleton")).toBeVisible();
    await expect(page.getByTestId("skeleton-preview")).toBeVisible();
    await expect(page.getByTestId("skeleton-bone-tree")).toBeVisible();
    await expect(page.getByTestId("tree-row-torso")).toBeVisible();
    await expect(page.getByTestId("skeleton-preview-canvas")).toHaveAttribute(
      "data-bones",
      "true",
      { timeout: 30_000 },
    );

    await openAssetFromBrowser(page, "assets/mannequin_idle.babasset");
    await expect(page.getByTestId("document-workspace-animation")).toBeVisible();
    await expect(page.getByTestId("animation-preview")).toBeVisible();
    await expect(page.getByTestId("animation-preview-canvas")).toHaveAttribute(
      "data-playing",
      "true",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("animation-preview-canvas")).toHaveAttribute(
      "data-looping",
      "true",
    );
  });
});
