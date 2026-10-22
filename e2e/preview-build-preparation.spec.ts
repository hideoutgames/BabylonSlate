import { expect, test, type Page } from "@playwright/test";
import { createDefaultScene, defaultExportPreset, MAIN_SCENE_FILE, PROJECT_FILE, SCENE_SCHEMA_VERSION, type ProjectDocument } from "../packages/core/src/index";
import { decodeAssetDocument, encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser } from "./open-test-project";
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

test("opening an older-format Scene shows the unsupported format reason", async ({ page }) => {
  const files = await minimalProjectFiles();
  const scene = await decodeAssetDocument(files.get(MAIN_SCENE_FILE)!);
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({ ...scene, version: SCENE_SCHEMA_VERSION - 1 }));
  await openMinimalTestProject(page, files);
  // The shipped registry has no migration steps, so Play's migration approval cannot occur;
  // project-service.migration.test.ts covers it with an injected registry.
  await openAssetFromBrowser(page, MAIN_SCENE_FILE);

  const failure = page.getByTestId("scene-loading-dialog");
  await expect(failure).toContainText("Scene Loading Failed");
  await expect(failure).toContainText(/Asset type "Scene" version \d+ uses an unsupported old format/);
  await expect(page.getByTestId("document-workspace-scene")).toHaveCount(0);
  await failure.getByRole("button", { name: "Close", exact: true }).click();
  await expect(failure).toHaveCount(0);
});

test("Play, Preview Build and Export refuse an older-format startup Scene", async ({ page }) => {
  const files = await minimalProjectFiles();
  const scene = await decodeAssetDocument(files.get(MAIN_SCENE_FILE)!);
  files.set(MAIN_SCENE_FILE, await encodeAssetDocument({ ...scene, version: SCENE_SCHEMA_VERSION - 1 }));
  // A current Scene hosts the Output Log while Play starts from the startup Scene.
  const otherScene = "assets/other.scene.hasset";
  files.set(otherScene, await encodeAssetDocument({ guid: "00000000-0000-4000-8000-0000000000aa", type: "Scene", name: "Other",
    version: SCENE_SCHEMA_VERSION, payload: createDefaultScene() as unknown as Record<string, unknown> }));
  await openMinimalTestProject(page, files);
  const reason = `Asset type "Scene" version ${SCENE_SCHEMA_VERSION - 1} uses an unsupported old format. This engine reads version ${SCENE_SCHEMA_VERSION}; older files are not upgraded.`;

  await openAssetFromBrowser(page, otherScene);
  await page.getByRole("tab", { name: "Output Log" }).click();
  await expect(page.getByTestId("output-log-panel")).toBeVisible();
  await page.getByTestId("debug-menu").click();
  await page.getByTestId("play-from-scene-toggle").click();
  await page.keyboard.press("Escape");
  await page.getByTestId("play-preview").click();
  await expect(page.getByTestId("output-log-line").filter({ hasText: `Play preparation failed: ${reason}` })).toHaveCount(1);
  await expect(page.getByTestId("play-overlay")).toHaveCount(0);

  await enablePreviewBuild(page);
  await page.getByTestId("play-preview").click();
  const previewFailure = page.getByRole("dialog", { name: "Preview Build Failed" });
  await expect(previewFailure).toContainText(reason);
  await expect(page.getByTestId("preview-build-iframe")).toHaveCount(0);
  await previewFailure.getByRole("button", { name: "Close", exact: true }).click();

  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-export").click();
  await page.getByTestId("export-game").click();
  await expect(page.getByTestId("export-game-error")).toContainText(reason);
});
