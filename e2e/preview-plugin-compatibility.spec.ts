import { expect, test, type Page } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { encodeProjectZip } from "../packages/assets/src/babproject";
import { createDefaultPluginSettings, encodePluginSettingsDocument } from "../packages/assets/src/plugin-settings";
import { openMainScene, openTestProject } from "./open-test-project";
import { waitForPreviewBuildBoot } from "./play";

const PLUGIN_GUID = "01234567-0000-4000-8000-000000000001";
const MISSING_GUID = "01234567-0000-4000-8000-000000000099";

async function importLegacyPlugin(page: Page, missingDependency = false) {
  const settings = createDefaultPluginSettings({ pluginGuid: PLUGIN_GUID, displayName: "Legacy Content" });
  settings.engineVersion = "";
  if (missingDependency) settings.pluginDependencies = [{ guid: MISSING_GUID, version: "1.0" }];
  const bytes = encodeProjectZip([
    { path: "legacy.plugin.babasset", data: await encodePluginSettingsDocument(settings) },
    { path: "assets/LegacyActor.class.babasset", data: await encodeAssetDocument({
      guid: "01234567-0000-4000-8000-000000000002", type: "Class", name: "LegacyActor", version: 1,
      payload: { nodes: [], edges: [], members: [], components: [] },
    }, { parentClass: "Actor" }) },
  ]);
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await page.getByTestId("settings-modal-category-plugins").click();
  await page.getByTestId("import-plugin-input").setInputFiles({
    name: "legacy.babplugin", mimeType: "application/zip", buffer: Buffer.from(bytes),
  });
  const enabled = page.getByTestId(`settings-plugin-enable-${PLUGIN_GUID}`);
  await enabled.click();
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  return page.getByTestId(`settings-plugin-row-${PLUGIN_GUID}`);
}

async function closeSettingsAndPreview(page: Page) {
  await page.getByTestId("settings-modal").locator('[data-slot="dialog-close"]').click();
  await page.getByTestId("debug-menu").click();
  await page.getByTestId("preview-build-toggle").click();
  await page.getByTestId("play-preview").click();
}

test("Preview Build launches with an unknown plugin engine version and logs a warning without a popup", async ({ page }) => {
  test.setTimeout(120_000);
  // Import through the real UI: this works with OPFS and fallback storage.
  await openTestProject(page);
  await openMainScene(page);
  const plugin = await importLegacyPlugin(page);
  await expect(plugin).toContainText("Warning:");
  await expect(plugin).toContainText("engine Unknown");
  await closeSettingsAndPreview(page);
  await waitForPreviewBuildBoot(page);
  await expect(page.getByTestId("preparing-preview-dialog")).toHaveCount(0);
  await page.getByTestId("preview-build-close").click();
  await expect(page.getByTestId("output-log-line").filter({ hasText: 'Preview Build warning: "Legacy Content" was created with engine Unknown' })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Preview Build Failed" })).toHaveCount(0);
});

test("Preview Build displays a blocking plugin dependency error in a modal", async ({ page }) => {
  test.setTimeout(120_000);
  await openTestProject(page);
  await openMainScene(page);
  await importLegacyPlugin(page, true);
  await closeSettingsAndPreview(page);
  const failure = page.getByRole("dialog", { name: "Preview Build Failed" });
  await expect(failure).toContainText(`Enable or install "${MISSING_GUID}"`);
  await expect(failure).not.toContainText("Compatibility has not been verified");
  await expect(page.getByTestId("preview-build-iframe")).toHaveCount(0);
  await failure.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("play-preview")).toBeEnabled();
});
