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

const ALBEDO_PNG = path.join(process.cwd(), "e2e/fixtures/albedo.png");

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

async function openWindowsMenu(page: Page): Promise<void> {
  const content = page.getByTestId("windows-menu-content");
  if (await content.isVisible()) return;
  await page.getByTestId("windows-menu").click();
  await expect(content).toBeVisible();
}

async function closeWindowsMenu(page: Page): Promise<void> {
  const content = page.getByTestId("windows-menu-content");
  if (!(await content.isVisible())) return;
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  if (await content.isVisible()) {
    await page.mouse.click(12, 12);
  }
  await expect(content).toHaveCount(0);
}

async function particleStats(page: Page): Promise<{
  systems: number;
  playing: number;
} | null> {
  return page.evaluate(() => {
    const stats = (
      window as {
        __babylonslateParticleStats?: { systems: number; playing: number };
      }
    ).__babylonslateParticleStats;
    return stats ? { systems: stats.systems, playing: stats.playing } : null;
  });
}

test.describe.configure({ mode: "serial" });

test.describe("P17 particles", () => {
  test("authors Emitter/System, plays billboard quads, and tears down", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openTestProject(page);
    await openContentBrowser(page);

    await page
      .getByTestId("content-browser-import-input")
      .setInputFiles([ALBEDO_PNG]);
    await expect(
      page.locator('[data-asset-path="assets/albedo.babasset"]'),
    ).toBeVisible({ timeout: 30_000 });

    await createContentBrowserAsset(page, "Material", "SparksMat");
    await openAssetFromBrowser(page, "assets/SparksMat.material.babasset");
    await expect(page.getByTestId("document-workspace-material")).toBeVisible();
    await expect(page.getByTestId("property-domain")).toBeVisible();
    await page.getByTestId("property-domain").click();
    await page.getByRole("option", { name: "Particle" }).click();
    await expect(page.getByTestId("property-domain")).toContainText("Particle");

    await createContentBrowserAsset(page, "ParticleEmitter", "Sparks");
    await openAssetFromBrowser(page, "assets/Sparks.emitter.babasset");
    await expect(
      page.getByTestId("document-workspace-particle-emitter"),
    ).toBeVisible();
    await expect(page.getByTestId("particle-emitter-details-panel")).toBeVisible();
    await expect(page.getByTestId("windows-menu")).toBeEnabled();
    await openWindowsMenu(page);
    await expect(
      page.getByTestId("windows-menu-particle-emitter-preview"),
    ).toBeVisible();
    await expect(
      page.getByTestId("windows-menu-particle-emitter-details"),
    ).toBeVisible();
    await closeWindowsMenu(page);

    await expect(page.getByTestId("particle-emitter-preview")).toBeVisible();
    await expect(page.getByText("No Texture")).toBeVisible();
    const albedoGuid = await guidForPath(page, "assets/albedo.babasset");
    expect(albedoGuid.length).toBeGreaterThan(0);
    await page.getByTestId("property-texture").click();
    await pickAsset(page, "particle-emitter-texture-picker", albedoGuid);
    await expect(page.getByTestId("particle-emitter-preview-canvas")).toBeVisible();

    const materialGuid = await guidForPath(
      page,
      "assets/SparksMat.material.babasset",
    );
    expect(materialGuid.length).toBeGreaterThan(0);
    await page.getByTestId("property-material").click();
    await pickAsset(page, "particle-emitter-material-picker", materialGuid);

    await createContentBrowserAsset(page, "ParticleSystem", "Fire");
    await openAssetFromBrowser(page, "assets/Fire.particles.babasset");
    await expect(
      page.getByTestId("document-workspace-particle-system"),
    ).toBeVisible();
    await expect(page.getByTestId("particle-system-details-panel")).toBeVisible();
    const emitterGuid = await guidForPath(page, "assets/Sparks.emitter.babasset");
    expect(emitterGuid.length).toBeGreaterThan(0);
    await page.getByTestId("property-emitter-0").click();
    await pickAsset(page, "particle-system-emitter-picker", emitterGuid);

    await openMainScene(page);
    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-item-particle").click();
    const particleCard = page.locator("[data-testid^='component-card-']").filter({
      hasText: "ParticleComponent",
    });
    await expect(particleCard).toBeVisible();
    await particleCard
      .locator('button[data-testid$="-particleSystemGuid"]')
      .click();
    const systemGuid = await guidForPath(page, "assets/Fire.particles.babasset");
    expect(systemGuid.length).toBeGreaterThan(0);
    await expect(page.getByTestId("details-asset-picker")).toBeVisible();
    await page.getByTestId(`search-item-${systemGuid}`).click();
    await expect(page.getByTestId("details-asset-picker")).toHaveCount(0);

    await saveAllIfEnabled(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    await expect
      .poll(async () => particleStats(page), { timeout: 15_000 })
      .toEqual(expect.objectContaining({ systems: 1, playing: 1 }));

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    await expect
      .poll(async () => particleStats(page), { timeout: 10_000 })
      .toEqual(expect.objectContaining({ systems: 0, playing: 0 }));
  });

  test("Play/Stop Particles are on the Class palette; missing texture diagnoses", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openTestProject(page);
    await openAssetFromBrowser(page, "assets/Mannequin.class.babasset");
    const graph = page.getByTestId("graph-panel");
    await expect(graph).toBeVisible();
    await graph.locator(".react-flow__pane").dblclick({ position: { x: 24, y: 24 } });
    await expect(page.getByTestId("node-palette")).toBeVisible();
    await page.getByTestId("node-palette-search").fill("Play Particles");
    await expect(page.getByTestId("node-palette-item-particles.play")).toBeVisible();
    await page.getByTestId("node-palette-search").fill("Stop Particles");
    await expect(page.getByTestId("node-palette-item-particles.stop")).toBeVisible();
    await page.keyboard.press("Escape");

    await openContentBrowser(page);
    await createContentBrowserAsset(page, "ParticleEmitter", "Bare");
    await createContentBrowserAsset(page, "ParticleSystem", "EmptyLook");
    await openAssetFromBrowser(page, "assets/EmptyLook.particles.babasset");
    const emitterGuid = await guidForPath(page, "assets/Bare.emitter.babasset");
    expect(emitterGuid.length).toBeGreaterThan(0);
    await page.getByTestId("property-emitter-0").click();
    await pickAsset(page, "particle-system-emitter-picker", emitterGuid);

    await openMainScene(page);
    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-item-particle").click();
    const particleCard = page.locator("[data-testid^='component-card-']").filter({
      hasText: "ParticleComponent",
    });
    await expect(particleCard).toBeVisible();
    await particleCard
      .locator('button[data-testid$="-particleSystemGuid"]')
      .click();
    const systemGuid = await guidForPath(
      page,
      "assets/EmptyLook.particles.babasset",
    );
    expect(systemGuid.length).toBeGreaterThan(0);
    await expect(page.getByTestId("details-asset-picker")).toBeVisible();
    await page.getByTestId(`search-item-${systemGuid}`).click();
    await expect(page.getByTestId("details-asset-picker")).toHaveCount(0);

    await saveAllIfEnabled(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-log-tail")).toContainText(
      /no Texture/i,
      { timeout: 15_000 },
    );
    await expect
      .poll(async () => particleStats(page), { timeout: 10_000 })
      .toEqual(expect.objectContaining({ systems: 0 }));
    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
  });

  test("Particle Emitter and System assets survive save and reopen", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openTestProject(page);
    await openContentBrowser(page);
    await page
      .getByTestId("content-browser-import-input")
      .setInputFiles([ALBEDO_PNG]);
    await expect(
      page.locator('[data-asset-path="assets/albedo.babasset"]'),
    ).toBeVisible({ timeout: 30_000 });
    await createContentBrowserAsset(page, "ParticleEmitter", "ReopenSparks");
    await openAssetFromBrowser(page, "assets/ReopenSparks.emitter.babasset");
    const albedoGuid = await guidForPath(page, "assets/albedo.babasset");
    expect(albedoGuid.length).toBeGreaterThan(0);
    await page.getByTestId("property-texture").click();
    await pickAsset(page, "particle-emitter-texture-picker", albedoGuid);
    await saveAllIfEnabled(page);

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
      page.locator('[data-asset-path="assets/ReopenSparks.emitter.babasset"]'),
    ).toBeVisible();
    await openAssetFromBrowser(page, "assets/ReopenSparks.emitter.babasset");
    await expect(page.getByTestId("property-texture")).toContainText(/albedo/i);
  });
});
