import { expect, test, type Page } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import { openContentBrowser, openMainScene, openTestProject } from "./open-test-project";

const STARTER_CONTENT_PLUGIN_GUID = "c0ffee00-0000-4000-8000-000000000001";
const STARTER_ACTOR_PATH =
  "plugins/starter-content/assets/StarterActor.class.babasset";
const MISSING_PLUGIN_GUID = "deadbeef-0000-4000-8000-000000000099";

test.describe.configure({ mode: "serial" });

async function openPluginsSettings(page: Page): Promise<void> {
  await page.getByTestId("settings-menu").click();
  await page.getByTestId("project-settings").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.getByTestId("settings-modal-category-plugins").click();
  await expect(page.getByTestId("settings-plugins-panel")).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page
    .getByTestId("settings-modal")
    .locator('[data-slot="dialog-close"]')
    .click();
  await expect(page.getByTestId("settings-modal")).toHaveCount(0);
}

async function guidForPath(page: Page, path: string): Promise<string> {
  return page.evaluate(async (assetPath) => {
    const host = globalThis as {
      __babylonslateTest?: { guidForPath: (path: string) => string | null };
    };
    return host.__babylonslateTest?.guidForPath(assetPath) ?? "";
  }, path);
}

test.describe("P13 plugins", () => {
  test("enables Starter Content and shows StarterActor, then hides it on disable", async ({
    page,
  }) => {
    await openTestProject(page);
    await openContentBrowser(page);
    await openPluginsSettings(page);
    const pluginGuids = await page.evaluate(() => {
      const host = globalThis as {
        __babylonslateTest?: {
          pluginGuids: () => string[];
          enginePluginLoad: () => {
            entries: number;
            unpacked: number;
            errors: string[];
          };
        };
      };
      return {
        guids: host.__babylonslateTest?.pluginGuids() ?? [],
        load: host.__babylonslateTest?.enginePluginLoad() ?? null,
      };
    });
    const indexProbe = await page.evaluate(async () => {
      const response = await fetch("/engine-plugins/index.json");
      return { status: response.status, text: await response.text() };
    });
    expect(indexProbe.status, indexProbe.text).toBe(200);
    expect(pluginGuids.guids).toContain(STARTER_CONTENT_PLUGIN_GUID);
    await expect(
      page.getByTestId("content-browser-new-plugin"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("content-browser-show-plugin-content"),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("settings-show-plugin-content"),
    ).toHaveAttribute("aria-checked", "false");
    await expect(
      page.getByTestId(`settings-plugin-source-${STARTER_CONTENT_PLUGIN_GUID}`),
    ).toHaveText("Project");

    await page
      .getByTestId(`settings-plugin-enable-${STARTER_CONTENT_PLUGIN_GUID}`)
      .click();
    await expect(
      page.getByTestId(`settings-plugin-enable-${STARTER_CONTENT_PLUGIN_GUID}`),
    ).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("settings-show-plugin-content").click();
    await expect(
      page.getByTestId("settings-show-plugin-content"),
    ).toHaveAttribute("aria-checked", "true");
    await closeSettings(page);

    await page.getByTestId("tree-row-plugins/starter-content/assets").click();
    await expect(
      page.locator(`[data-asset-path="${STARTER_ACTOR_PATH}"]`),
    ).toBeVisible();

    await openPluginsSettings(page);
    await page.getByTestId("settings-show-plugin-content").click();
    await expect(
      page.getByTestId("settings-show-plugin-content"),
    ).toHaveAttribute("aria-checked", "false");
    await closeSettings(page);
    await expect(
      page.getByTestId("tree-row-plugins/starter-content/assets"),
    ).toHaveCount(0);

    await openPluginsSettings(page);
    await page
      .getByTestId(`settings-plugin-enable-${STARTER_CONTENT_PLUGIN_GUID}`)
      .click();
    await expect(
      page.getByTestId(`settings-plugin-enable-${STARTER_CONTENT_PLUGIN_GUID}`),
    ).toHaveAttribute("aria-checked", "false");
    await closeSettings(page);

    await expect(
      page.locator(`[data-asset-path="${STARTER_ACTOR_PATH}"]`),
    ).toHaveCount(0);
  });

  test("exports a project plugin and re-imports it with class guids intact", async ({
    page,
  }) => {
    await openTestProject(page);
    await openContentBrowser(page);
    await openPluginsSettings(page);
    await page.getByTestId("settings-plugin-new").click();
    await page.getByTestId("name-prompt-input").fill("Shared Pack");
    await page.getByTestId("name-prompt-confirm").click();
    const packRow = page
      .locator('[data-testid^="settings-plugin-row-"]')
      .filter({ hasText: "Shared Pack" });
    await expect(packRow).toBeVisible();
    const rowTestId = await packRow.getAttribute("data-testid");
    const pluginGuid = rowTestId?.replace("settings-plugin-row-", "") ?? "";
    expect(pluginGuid).toMatch(/^[0-9a-f-]+$/i);
    await expect(
      page.getByTestId("settings-show-plugin-content"),
    ).toHaveAttribute("aria-checked", "true");

    await page.getByTestId(`settings-plugin-enable-${pluginGuid}`).click();
    await expect(
      page.getByTestId(`settings-plugin-enable-${pluginGuid}`),
    ).toHaveAttribute("aria-checked", "true");
    await closeSettings(page);

    await expect(
      page.getByTestId("tree-row-plugins/shared-pack/assets"),
    ).toBeVisible();
    await page.getByTestId("tree-row-plugins/shared-pack/assets").click();
    await page.getByTestId("content-browser-new-asset").click();
    await expect(page.getByTestId("content-browser-new-asset-dialog")).toBeVisible();
    await page.getByTestId("new-asset-type").click();
    await page.getByTestId("new-asset-type-Class").click();
    await page.getByTestId("new-asset-parent").click();
    await page.getByTestId("new-asset-parent-Actor").click();
    await page.getByTestId("new-asset-name").fill("Hero");
    await page.getByTestId("content-browser-new-asset-create").click();
    await expect(page.getByTestId("content-browser-new-asset-dialog")).toHaveCount(
      0,
    );
    const classPath = "plugins/shared-pack/assets/Hero.class.babasset";
    await expect(page.locator(`[data-asset-path="${classPath}"]`)).toBeVisible();
    const classGuid = await guidForPath(page, classPath);
    expect(classGuid).not.toBe("");

    await page.getByTestId("tree-row-assets").click();
    await expect(
      page.locator('[data-asset-path="assets/main.scene.babasset"]'),
    ).toBeVisible();
    await openMainScene(page);
    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-catalog-search").fill("Hero");
    await page.getByTestId(`place-actors-item-asset-${classGuid}`).click();

    await openPluginsSettings(page);
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId(`settings-plugin-export-${pluginGuid}`).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("shared-pack.babplugin");
    const pluginFile = await download.path();
    expect(pluginFile).toBeTruthy();
    await closeSettings(page);
    await closeProjectViaSettings(page);
    const discard = page.getByTestId("dirty-discard");
    await expect(
      page.getByTestId("homepage").or(discard),
    ).toBeVisible();
    if (await discard.isVisible()) {
      await discard.click();
    }
    await expect(page.getByTestId("homepage")).toBeVisible();

    await page.getByTestId("create-project").click();
    await expect(page.getByTestId("create-project-dialog")).toBeVisible();
    await page.getByTestId("create-project-name").fill("PluginImportTarget");
    await page.getByTestId("create-project-submit").click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();

    await openPluginsSettings(page);
    await page
      .getByTestId("import-plugin-input")
      .setInputFiles(pluginFile!);
    const importedRow = page
      .locator('[data-testid^="settings-plugin-row-"]')
      .filter({ hasText: "Shared Pack" });
    await expect(importedRow).toBeVisible();
    await page.getByTestId(`settings-plugin-enable-${pluginGuid}`).click();
    await expect(
      page.getByTestId(`settings-plugin-enable-${pluginGuid}`),
    ).toHaveAttribute("aria-checked", "true");
    await closeSettings(page);

    await expect
      .poll(async () => guidForPath(page, classPath))
      .toBe(classGuid);
    await openContentBrowser(page);
    await page.getByTestId("tree-row-assets").click();
    await openMainScene(page);
    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-catalog-search").fill("Hero");
    await expect(
      page.getByTestId(`place-actors-item-asset-${classGuid}`),
    ).toBeVisible();
  });

  test("a missing plugin override keeps an Unresolved placeholder guid", async ({
    page,
  }) => {
    await openTestProject(page);
    const placeholder = await page.evaluate(async (guid) => {
      const host = globalThis as {
        __babylonslateTest?: {
          seedMissingPluginOverride: (guid: string) => Promise<{
            guid: string;
            type: string;
            path: string;
            placeholder: boolean;
          } | null>;
        };
      };
      return host.__babylonslateTest?.seedMissingPluginOverride(guid) ?? null;
    }, MISSING_PLUGIN_GUID);
    expect(placeholder).toEqual({
      guid: MISSING_PLUGIN_GUID,
      type: "Unresolved",
      path: `__unresolved__/${MISSING_PLUGIN_GUID}`,
      placeholder: true,
    });
  });
});
