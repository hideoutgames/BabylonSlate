import { expect, test, type Page } from "@playwright/test";
import { defaultExportPreset, MAIN_SCENE_FILE, PROJECT_FILE, type ProjectDocument } from "../packages/core/src/index";
import { decodeAssetDocument, encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { openMinimalTestProject } from "./minimal-project";
import { openMainScene } from "./open-test-project";
import { waitForPreviewBuildBoot } from "./play";

async function enablePreviewBuild(page: Page) {
  await page.getByTestId("debug-menu").click();
  await page.getByTestId("preview-build-toggle").click();
}

test("Preview Build keeps export failures visible and can launch after correction", async ({ page }) => {
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!)) as ProjectDocument;
  project.settings.exportPresets = [{ ...defaultExportPreset(), fileCountFail: 1 }];
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  await openMinimalTestProject(page, files);
  await enablePreviewBuild(page);
  await page.getByTestId("play-preview").click();

  const failure = page.getByRole("dialog", { name: "Preview Build Failed" });
  await expect(failure).toContainText(/Export file count \d+ exceeds the limit of 1/);
  await expect(page.getByTestId("preview-build-iframe")).toHaveCount(0);
  await expect(failure.getByRole("progressbar")).toHaveCount(0);
  await failure.getByRole("button", { name: "Close", exact: true }).click();
  await expect(failure).toHaveCount(0);

  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-export").click();
  await page.getByTestId("setting-export-file-fail").fill("1000");
  await page.getByTestId("settings-modal").locator('[data-slot="dialog-close"]').click();
  await page.getByTestId("play-preview").click();
  await waitForPreviewBuildBoot(page);
  await page.getByTestId("preview-build-close").click();
  await expect(page.getByTestId("play-preview")).toBeEnabled();
});

test("Preview Build reports a preparation exception and Retry builds a fresh working preview", async ({ page }) => {
  await openMinimalTestProject(page);
  await enablePreviewBuild(page);
  // Fail the browser hashing boundary used to write the real game pack.
  const restoreHashing = await page.evaluateHandle(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async () => { throw new Error("Game pack hashing failed."); };
    return () => { crypto.subtle.digest = digest; };
  });
  await page.getByTestId("play-preview").click();
  const failure = page.getByRole("dialog", { name: "Preview Build Failed" });
  await expect(failure).toContainText("Game pack hashing failed.");
  await expect(page.getByTestId("preview-build-iframe")).toHaveCount(0);
  await restoreHashing.evaluate((restore) => restore());
  await restoreHashing.dispose();

  await failure.getByRole("button", { name: "Retry", exact: true }).click();
  await waitForPreviewBuildBoot(page);
  await expect(page.getByTestId("preparing-preview-dialog")).toHaveCount(0);
  await page.getByTestId("preview-build-close").click();
  await expect(page.getByTestId("play-preview")).toBeEnabled();
});

test("a cancelled Preview Build cannot dismiss or fail the next preparation", async ({ page }) => {
  await openMinimalTestProject(page);
  await enablePreviewBuild(page);
  const hashing = await page.evaluateHandle(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const pending: Array<{ resolve(): void; reject(): void }> = [];
    crypto.subtle.digest = async (...args) => {
      // Let phase progress render, and hold only pack writes. Asset loading
      // may share in-flight reads between attempts and must stay unblocked.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!document.querySelector('[data-testid="preparing-preview-progress"]')?.textContent?.includes("Writing Pack")) {
        return digest(...args);
      }
      await new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject: () => reject(new Error("Cancelled pack failed.")) });
      });
      return digest(...args);
    };
    return {
      count: () => pending.length,
      rejectFirst: () => pending[0]!.reject(),
      resume: () => {
        crypto.subtle.digest = digest;
        for (const call of pending) call.resolve();
      },
    };
  });
  await page.getByTestId("play-preview").click();
  await expect.poll(() => hashing.evaluate((hash) => hash.count()), { timeout: 30_000 }).toBe(1);
  await page.getByTestId("preparing-preview-cancel").click();
  await page.getByTestId("play-preview").click();
  await expect.poll(() => hashing.evaluate((hash) => hash.count()), { timeout: 30_000 }).toBe(2);
  await hashing.evaluate(async (hash) => {
    hash.rejectFirst();
    // Allow the rejected attempt's catch/finally and React update to settle.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(page.getByRole("dialog", { name: "Preparing Preview", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Preview Build Failed" })).toHaveCount(0);
  await hashing.evaluate((hash) => hash.resume());
  await hashing.dispose();
  await waitForPreviewBuildBoot(page);
  await page.getByTestId("preview-build-close").click();
});

test("Preview Build requests migration approval and launches after approval", async ({ page }) => {
  const files = await minimalProjectFiles();
  const scene = await decodeAssetDocument(files.get(MAIN_SCENE_FILE)!);
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({ ...scene, version: 2 }));
  await openMinimalTestProject(page, files);
  await openMainScene(page);
  await enablePreviewBuild(page);
  await page.getByTestId("play-preview").click();
  const migration = page.getByTestId("migrate-on-save-dialog");
  await expect(migration).toBeVisible();
  await expect(page.getByTestId("preview-build-iframe")).toHaveCount(0);
  await migration.getByTestId("migrate-approve").click();
  await waitForPreviewBuildBoot(page);
  await page.getByTestId("preview-build-close").click();
  await expect(page.getByTestId("play-preview")).toBeEnabled();
});
