import path from "node:path";
import { expect, test } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import { openTestProject } from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

const fixtures = path.join(process.cwd(), "e2e/fixtures");

// Shared TestProject OPFS name — keep these serial to avoid cross-test stomps.
test.describe.configure({ mode: "serial" });

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

    await expect(page.getByTestId("importing-overlay")).toBeVisible();
    await expect(page.getByTestId("importing-count")).toBeVisible();

    await expect(
      page.locator('[data-asset-path="assets/albedo.babasset"]'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("importing-overlay")).toHaveCount(0);
    await expect(
      page.locator('[data-asset-path="assets/hero.babasset"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-asset-path="assets/hero_HeroMat.babasset"]'),
    ).toBeVisible();

    const albedo = page.locator('[data-asset-path="assets/albedo.babasset"]');
    await expect(async () => {
      await expect(albedo.getByText("Encoding")).toHaveCount(0);
      await expect(albedo.getByText("Compress pending")).toHaveCount(0);
    }).toPass({ timeout: 60_000 });
    await albedo.dblclick();
    await expect(page.getByTestId("texture-preview")).toBeVisible();

    await saveAllIfEnabled(page);
    await closeProjectViaSettings(page);
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

    // Open the graph document without activating the GraphEditor canvas so RF
    // init events cannot overwrite the command-layer nudge.
    const prepared = await page.evaluate(async () => {
      const api = (
        globalThis as {
          __babylonslateTest?: {
            ensureMainGraphOpen: () => Promise<boolean>;
            activeGraphNodePosition: () => { x: number; y: number } | null;
          };
        }
      ).__babylonslateTest;
      if (!api) return null;
      const opened = await api.ensureMainGraphOpen();
      return { opened, position: api.activeGraphNodePosition() };
    });
    expect(prepared?.opened).toBe(true);
    expect(prepared?.position?.x).toBe(80);

    const nudged = await page.evaluate(async () => {
      const api = (
        globalThis as {
          __babylonslateTest?: {
            nudgeActiveGraphNode: () => Promise<boolean>;
            cancelDebouncedSave: () => void;
            activeGraphNodePosition: () => { x: number; y: number } | null;
            hasRecoveryJournal: () => Promise<boolean>;
          };
        }
      ).__babylonslateTest;
      if (!api) return null;
      const before = api.activeGraphNodePosition();
      const ok = await api.nudgeActiveGraphNode();
      api.cancelDebouncedSave();
      const after = api.activeGraphNodePosition();
      const journal = await api.hasRecoveryJournal();
      return { ok, before, after, journal };
    });
    expect(nudged?.ok).toBe(true);
    expect(nudged?.journal).toBe(true);
    expect(nudged?.after?.x).toBe(80 + 42);
    expect(nudged?.after?.y).toBe(80 + 17);

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
    expect(restored?.x).toBe(80 + 42);
    expect(restored?.y).toBe(80 + 17);
  });
});
