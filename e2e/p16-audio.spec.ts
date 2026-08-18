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
import { clickPlayAndWaitForOverlay } from "./play";
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

/** Beep.wav is ~0ms; one-shot voices drop after onEnded. Loop so Play stats stay non-zero. */
async function enableImportedAudioLoop(
  page: Page,
  assetPath = "assets/beep.babasset",
): Promise<void> {
  await openAssetFromBrowser(page, assetPath);
  await expect(page.getByTestId("document-workspace-audio")).toBeVisible();
  const loop = page.getByTestId("audio-preview-loop");
  await expect(loop).toBeVisible();
  if ((await loop.getAttribute("data-state")) !== "on") {
    await loop.click();
  }
  await expect(loop).toHaveAttribute("data-state", "on");
  await saveAllIfEnabled(page);
}

test.describe.configure({ mode: "serial" });

test.describe("P16 audio", () => {
  test("hears an imported sound after Place Project Audio and a canvas click", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openTestProject(page);
    await openContentBrowser(page);

    await page.getByTestId("content-browser-import-input").setInputFiles([BEEP_WAV]);
    await expect(
      page.locator('[data-asset-path="assets/beep.babasset"]'),
    ).toBeVisible({ timeout: 30_000 });
    const beepGuid = await guidForPath(page, "assets/beep.babasset");
    expect(beepGuid.length).toBeGreaterThan(0);
    await enableImportedAudioLoop(page);

    await openMainScene(page);
    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-catalog-search").fill("beep");
    await page.getByTestId(`place-actors-item-asset-${beepGuid}`).click();
    await expect(page.getByTestId("place-actors-catalog")).toHaveCount(0);

    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    await expect(page.getByTestId("play-audio-unlock-hint")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("play-canvas").click({
      position: { x: 200, y: 200 },
      force: true,
    });
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const stats = (
            window as {
              __babylonslateAudioStats?: {
                unlocked: boolean;
                voices: number;
              };
            }
          ).__babylonslateAudioStats;
          return stats ?? null;
        });
      }, { timeout: 15_000 })
      .toEqual(
        expect.objectContaining({
          unlocked: true,
        }),
      );
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          return (
            window as { __babylonslateAudioStats?: { voices: number } }
          ).__babylonslateAudioStats?.voices ?? 0;
        });
      }, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await expect(page.getByTestId("play-audio-unlock-hint")).toHaveCount(0);
  });

  test("imports WAV, authors mixer/channel/attenuation, and wires refs", async ({
    page,
  }) => {
    test.setTimeout(240_000);
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
    await expect(page.getByTestId("property-coneEnabled")).toBeVisible();
    await expect(page.getByTestId("property-dopplerEnabled")).toBeVisible();

    await openAssetFromBrowser(page, "assets/Master.mixer.babasset");
    await expect(page.getByTestId("document-workspace-audio-mixer")).toBeVisible();
    await expect(page.getByTestId("audio-mixer-details-panel")).toBeVisible();
    await expect(page.getByTestId("audio-mixer-empty-channels")).toBeVisible();
    const channelGuid = await guidForPath(page, "assets/SFX.channel.babasset");
    expect(channelGuid.length).toBeGreaterThan(0);
    await page.getByTestId("audio-mixer-add-channel").click();
    await pickAsset(page, "audio-mixer-channel-picker", channelGuid);

    await openAssetFromBrowser(page, "assets/beep.babasset");
    await expect(page.getByTestId("document-workspace-audio")).toBeVisible();
    await expect(page.getByTestId("audio-preview")).toBeVisible();
    await expect(page.getByTestId("audio-preview-play")).toBeVisible();
    await page.getByTestId("audio-preview-play").click();
    await expect(page.getByTestId("audio-clip-0-name")).toHaveText(/beep/i);

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
    const sfxTile = page.locator('[data-asset-path="assets/SFX.channel.babasset"]');
    await expect(sfxTile).toBeVisible();
    const deselect = page.getByTestId("content-browser-deselect-all");
    if ((await deselect.count()) > 0) {
      await deselect.click();
    }
    await sfxTile.click();
    await sfxTile.click({ button: "right" });
    await expect(page.getByTestId("context-menu-item-show-references")).toBeVisible();
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
      .getByTestId("open-listed-project-TestProject")
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

  test("Play unlocks on first gesture, reports spatial distance, and tears down", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openTestProject(page);
    await openContentBrowser(page);

    await page.getByTestId("content-browser-import-input").setInputFiles([BEEP_WAV]);
    await expect(
      page.locator('[data-asset-path="assets/beep.babasset"]'),
    ).toBeVisible({ timeout: 30_000 });
    await createContentBrowserAsset(page, "SoundAttenuation", "Near");

    await openAssetFromBrowser(page, "assets/beep.babasset");
    const attenGuid = await guidForPath(page, "assets/Near.atten.babasset");
    expect(attenGuid.length).toBeGreaterThan(0);
    await page.getByTestId("property-soundAttenuationGuid").click();
    await pickAsset(page, "audio-attenuation-picker", attenGuid);

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

    await expect(page.getByTestId("property-actor-position-x")).toBeVisible();
    await page.getByTestId("property-actor-position-x").fill("0");
    await saveAllIfEnabled(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    await page.getByTestId("play-canvas").click({
      position: { x: 200, y: 200 },
      force: true,
    });
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const stats = (
            window as {
              __babylonslateAudioStats?: {
                unlocked: boolean;
                lastDistance: number | null;
                voices: number;
              };
            }
          ).__babylonslateAudioStats;
          return stats ?? null;
        });
      }, { timeout: 15_000 })
      .toEqual(
        expect.objectContaining({
          unlocked: true,
        }),
      );
    let nearDistance: number | null = null;
    await expect
      .poll(async () => {
        nearDistance = await page.evaluate(() => {
          return (
            window as {
              __babylonslateAudioStats?: { lastDistance: number | null };
            }
          ).__babylonslateAudioStats?.lastDistance ?? null;
        });
        return nearDistance;
      }, { timeout: 15_000 })
      .toEqual(expect.any(Number));

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    await page.getByTestId("property-actor-position-x").fill("40");
    await saveAllIfEnabled(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    await page.getByTestId("play-canvas").click({
      position: { x: 200, y: 200 },
      force: true,
    });
    await expect
      .poll(async () => {
        return page.evaluate((previous) => {
          const distance = (
            window as {
              __babylonslateAudioStats?: { lastDistance: number | null };
            }
          ).__babylonslateAudioStats?.lastDistance;
          return (
            typeof distance === "number" &&
            typeof previous === "number" &&
            Math.abs(distance - previous) > 1
          );
        }, nearDistance);
      }, { timeout: 15_000 })
      .toBe(true);

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          return (
            window as { __babylonslateAudioStats?: { voices: number } }
          ).__babylonslateAudioStats?.voices;
        });
      }, { timeout: 10_000 })
      .toBe(0);
  });

  test("Preview Build hears Place Audio after a canvas click", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openTestProject(page);
    await openContentBrowser(page);

    await page.getByTestId("content-browser-import-input").setInputFiles([BEEP_WAV]);
    await expect(
      page.locator('[data-asset-path="assets/beep.babasset"]'),
    ).toBeVisible({ timeout: 30_000 });
    const beepGuid = await guidForPath(page, "assets/beep.babasset");
    expect(beepGuid.length).toBeGreaterThan(0);
    await enableImportedAudioLoop(page);

    await openMainScene(page);
    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-catalog-search").fill("beep");
    await page.getByTestId(`place-actors-item-asset-${beepGuid}`).click();
    await expect(page.getByTestId("place-actors-catalog")).toHaveCount(0);

    await saveAllIfEnabled(page);

    await page.getByTestId("debug-menu").click();
    await page.getByTestId("preview-build-toggle").click();
    await expect(page.getByTestId("play-preview")).toHaveText("Preview");
    await page.getByTestId("play-preview").click();
    await expect(page.getByTestId("preview-build-overlay")).toBeVisible({
      timeout: 60_000,
    });

    const frame = page.frameLocator('[data-testid="preview-build-iframe"]');
    const root = frame.getByTestId("player-root");
    await expect(root).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("preview-build-error")).toHaveCount(0);
    await expect(root).toHaveAttribute("data-booted", "true", { timeout: 30_000 });

    await frame.getByTestId("player-canvas").click({
      position: { x: 200, y: 200 },
      force: true,
    });

    const iframe = page.getByTestId("preview-build-iframe");
    await expect
      .poll(
        async () =>
          iframe.evaluate((el) => {
            const win = (el as HTMLIFrameElement).contentWindow as {
              __babylonslateAudioStats?: { unlocked: boolean; voices: number };
            } | null;
            return win?.__babylonslateAudioStats ?? null;
          }),
        { timeout: 15_000 },
      )
      .toEqual(expect.objectContaining({ unlocked: true, voices: expect.any(Number) }));
    await expect
      .poll(
        async () =>
          iframe.evaluate((el) => {
            const win = (el as HTMLIFrameElement).contentWindow as {
              __babylonslateAudioStats?: { voices: number };
            } | null;
            return win?.__babylonslateAudioStats?.voices ?? 0;
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    await page.getByTestId("preview-build-close").click();
    await expect(page.getByTestId("preview-build-overlay")).toHaveCount(0);
  });
});
