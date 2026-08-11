import path from "node:path";
import { expect, test } from "@playwright/test";

const fixtures = path.join(process.cwd(), "e2e/fixtures");

async function openTestProject(page: import("@playwright/test").Page) {
  await page.goto("/?test=1");
  await expect(page.getByTestId("homepage")).toBeVisible();
  await page.getByTestId("create-project-empty").click();
  await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
}

test.describe("P2 acceptance proofs", () => {
  test("imports PNG + GLB, survives reload, keeps assets browsable", async ({
    page,
  }) => {
    await openTestProject(page);
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();

    await page
      .getByTestId("content-browser-import-input")
      .setInputFiles([
        path.join(fixtures, "albedo.png"),
        path.join(fixtures, "hero.glb"),
      ]);

    await expect(
      page.locator('[data-asset-path="assets/albedo.babasset"]'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('[data-asset-path="assets/hero.babasset"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-asset-path="assets/hero_HeroMat.babasset"]'),
    ).toBeVisible();

    await page.getByTestId("save-project").click();
    await page.getByTestId("close-project").click();
    await expect(page.getByTestId("homepage")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page
      .getByTestId("open-listed-project-TestProject.babproject")
      .click();
    await expect(page.getByTestId("content-browser-workspace")).toBeVisible();
    await expect(
      page.locator('[data-asset-path="assets/albedo.babasset"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-asset-path="assets/hero.babasset"]'),
    ).toBeVisible();
  });

  test("killed-tab journal recovers unsaved graph edits", async ({ page }) => {
    await openTestProject(page);
    await page.locator('[data-asset-path="assets/main.graph.babasset"]').click();
    await expect(page.getByTestId("document-workspace-graph")).toBeVisible();

    const nudged = await page.evaluate(() => {
      const api = (
        globalThis as {
          __babylonslateTest?: {
            nudgeActiveGraphNode: () => boolean;
            cancelDebouncedSave: () => void;
            activeGraphNodePosition: () => { x: number; y: number } | null;
          };
        }
      ).__babylonslateTest;
      if (!api) return null;
      const before = api.activeGraphNodePosition();
      const ok = api.nudgeActiveGraphNode();
      api.cancelDebouncedSave();
      const after = api.activeGraphNodePosition();
      return { ok, before, after };
    });
    expect(nudged?.ok).toBe(true);
    expect(nudged?.after?.x).toBe((nudged?.before?.x ?? 0) + 42);

    // Simulate killed tab: reload without clean Close (journal remains).
    await page.reload();
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page
      .getByTestId("open-listed-project-TestProject.babproject")
      .click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await expect(page.getByTestId("recovery-prompt")).toBeVisible({
      timeout: 15_000,
    });

    await page.locator('[data-asset-path="assets/main.graph.babasset"]').click();
    await page.getByTestId("recover-journal").click();
    await expect(page.getByTestId("recovery-prompt")).toHaveCount(0);

    const restored = await page.evaluate(() => {
      const api = (
        globalThis as {
          __babylonslateTest?: {
            activeGraphNodePosition: () => { x: number; y: number } | null;
          };
        }
      ).__babylonslateTest;
      return api?.activeGraphNodePosition() ?? null;
    });
    expect(restored?.x).toBe(120 + 42);
    expect(restored?.y).toBe(120 + 17);
  });
});
