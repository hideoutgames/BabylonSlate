import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openContentBrowser,
  openMainScene,
  openTestProject,
} from "./open-test-project";
import { saveAllIfEnabled } from "./save-all";

const BEEP_WAV = path.join(process.cwd(), "e2e/fixtures/beep.wav");

async function guidForPath(page: Page, assetPath: string): Promise<string> {
  return page.evaluate((target) => {
    const host = globalThis as {
      __babylonslateTest?: { guidForPath: (path: string) => string | null };
    };
    return host.__babylonslateTest?.guidForPath(target) ?? "";
  }, assetPath);
}

async function pickAsset(
  page: Page,
  pickerTestId: string,
  guid: string,
): Promise<void> {
  await expect(page.getByTestId(pickerTestId)).toBeVisible();
  await page.getByTestId(`search-item-${guid}`).click();
  await expect(page.getByTestId(pickerTestId)).toHaveCount(0);
}

test.describe.configure({ mode: "serial" });

test.describe("P16 audio", () => {
  test("imports WAV, authors mixer/channel/attenuation, and wires refs", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openTestProject(page);
    await openContentBrowser(page);

    await page.getByTestId("content-browser-import-input").setInputFiles([BEEP_WAV]);
    await expect(
      page.locator('[data-asset-path="assets/beep.babasset"]'),
    ).toBeVisible({ timeout: 30_000 });

    await createContentBrowserAsset(page, "AudioChannel", "SFX");
    await createContentBrowserAsset(page, "AudioMixer", "Master");
    await createContentBrowserAsset(page, "SoundAttenuation", "Near");

    await openAssetFromBrowser(page, "assets/SFX.channel.babasset");
    await expect(page.getByTestId("document-workspace-audio-channel")).toBeVisible();
    await expect(page.getByTestId("audio-channel-details-panel")).toBeVisible();

    await openAssetFromBrowser(page, "assets/Near.atten.babasset");
    await expect(
      page.getByTestId("document-workspace-sound-attenuation"),
    ).toBeVisible();
    await expect(page.getByTestId("sound-attenuation-details-panel")).toBeVisible();
    await expect(page.getByTestId("attenuation-falloff-plot")).toBeVisible();

    await openAssetFromBrowser(page, "assets/Master.mixer.babasset");
    await expect(page.getByTestId("document-workspace-audio-mixer")).toBeVisible();
    await expect(page.getByTestId("audio-mixer-details-panel")).toBeVisible();
    await page.getByTestId("audio-mixer-add-channel").click();
    await page.getByTestId("property-channel-0").click();
    const channelGuid = await guidForPath(page, "assets/SFX.channel.babasset");
    expect(channelGuid.length).toBeGreaterThan(0);
    await pickAsset(page, "audio-mixer-channel-picker", channelGuid);

    await openAssetFromBrowser(page, "assets/beep.babasset");
    await expect(page.getByTestId("document-workspace-asset-settings")).toBeVisible();
    await expect(page.getByTestId("audio-preview")).toBeVisible();
    await expect(page.getByTestId("audio-preview-play")).toBeVisible();
    await page.getByTestId("audio-preview-play").click();

    await page.getByTestId("property-audioChannelGuid").click();
    await pickAsset(page, "audio-channel-picker", channelGuid);
    const attenGuid = await guidForPath(page, "assets/Near.atten.babasset");
    expect(attenGuid.length).toBeGreaterThan(0);
    await page.getByTestId("property-soundAttenuationGuid").click();
    await pickAsset(page, "audio-attenuation-picker", attenGuid);

    await page.getByTestId("settings-menu").click();
    await page.getByTestId("project-settings").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await page.getByTestId("settings-modal-category-audio").click();
    await expect(page.getByTestId("settings-audio-mixer")).toBeVisible();
    await page.getByTestId("settings-audio-mixer").click();
    const mixerGuid = await guidForPath(page, "assets/Master.mixer.babasset");
    expect(mixerGuid.length).toBeGreaterThan(0);
    await pickAsset(page, "settings-audio-mixer-picker", mixerGuid);
    await page
      .getByTestId("settings-modal")
      .locator('[data-slot="dialog-close"]')
      .click();
    await expect(page.getByTestId("settings-modal")).toHaveCount(0);

    await openMainScene(page);
    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-item-audio").click();
    const audioCard = page.locator("[data-testid^='component-card-']").filter({
      hasText: "AudioComponent",
    });
    await expect(audioCard).toBeVisible();
    await audioCard.locator('button[data-testid$="-audioAssetGuid"]').click();
    const beepGuid = await guidForPath(page, "assets/beep.babasset");
    expect(beepGuid.length).toBeGreaterThan(0);
    await expect(page.getByTestId("details-asset-picker")).toBeVisible();
    await page.getByTestId(`search-item-${beepGuid}`).click();
    await expect(page.getByTestId("details-asset-picker")).toHaveCount(0);

    await saveAllIfEnabled(page);

    await openContentBrowser(page);
    await page
      .locator('[data-asset-path="assets/SFX.channel.babasset"]')
      .click({ button: "right" });
    await page.getByTestId("context-menu-item-show-references").click();
    const refs = page.getByTestId("content-browser-refs-dialog");
    await expect(refs).toBeVisible();
    await expect(refs).toContainText(/Master/i);
    await expect(refs).toContainText(/beep/i);
    await refs.getByRole("button", { name: "Close" }).click();

    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page
      .getByTestId("open-listed-project-TestProject.babproject")
      .click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await openContentBrowser(page);
    await expect(
      page.locator('[data-asset-path="assets/beep.babasset"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-asset-path="assets/Master.mixer.babasset"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-asset-path="assets/SFX.channel.babasset"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-asset-path="assets/Near.atten.babasset"]'),
    ).toBeVisible();

    await openAssetFromBrowser(page, "assets/beep.babasset");
    await expect(page.getByTestId("audio-preview")).toBeVisible();
    await expect(page.getByTestId("property-audioChannelGuid")).toContainText(
      /SFX/i,
    );
    await expect(page.getByTestId("property-soundAttenuationGuid")).toContainText(
      /Near/i,
    );
  });
});
