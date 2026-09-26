import { expect, test, type Page } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import {
  addMaterialPaletteNode,
  compileMaterialPreview,
  connectMaterialPins,
  guidForPath,
  importAlbedoTexture,
  pickMaterialNodeTexture,
} from "./material-graph";
import {
  createContentBrowserAsset,
  openAssetFromBrowser,
  openContentBrowser,
  openMainScene,
  openTestProject,
} from "./open-test-project";
import { clickPlayAndWaitForOverlay } from "./play";
import { saveAllIfEnabled } from "./save-all";
import { openMinimalTestProject } from "./minimal-project";

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

/** Picks a Value Mode for a Basic emitter Details row (`value-mode-<rowId>`). */
async function chooseValueMode(
  page: Page,
  rowId: string,
  mode: "constant" | "range" | "curve",
): Promise<void> {
  const menu = page.getByTestId(`value-mode-${rowId}-menu`);
  await page.getByTestId(`value-mode-${rowId}`).click();
  await expect(menu).toBeVisible();
  await page.getByTestId(`value-mode-${rowId}-${mode}`).click();
  // Radio items keep the menu open unless the host closes on click.
  if (await menu.isVisible()) await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

/** Particle Domain Material; the new Particle Output starts unwired. */
async function createParticleMaterial(page: Page, name: string): Promise<string> {
  await createContentBrowserAsset(page, "Material", name);
  await openAssetFromBrowser(page, `assets/${name}.material.babasset`);
  await expect(page.getByTestId("document-workspace-material")).toBeVisible();
  await expect(page.getByTestId("property-domain")).toBeVisible();
  await page.getByTestId("property-domain").click();
  await page.getByRole("option", { name: "Particle", exact: true }).click();
  await expect(page.getByTestId("property-domain")).toContainText("Particle");
  const guid = await guidForPath(page, `assets/${name}.material.babasset`);
  expect(guid.length).toBeGreaterThan(0);
  return guid;
}

/** Adds the emitter to a new slot of the open Particle System. */
async function addSystemEmitter(page: Page, emitterPath: string, name: RegExp): Promise<void> {
  const emitterGuid = await guidForPath(page, emitterPath);
  expect(emitterGuid.length).toBeGreaterThan(0);
  await page.getByTestId("particle-system-emitters-add").click();
  await pickAsset(page, "particle-system-emitter-picker", emitterGuid);
  await expect(page.getByTestId("particle-system-emitter-0")).toContainText(name);
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

test.describe("P17 particles", () => {
  test("authors Emitter/System, plays billboard quads, and tears down", async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    const shaderErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && /shader error|error compiling effect/i.test(message.text())) shaderErrors.push(message.text());
    });
    const shaderFallbacks: string[] = [];
    page.on("request", (request) => {
      if (/\/Shaders\/material:.*\.fx(?:\?|$)/.test(request.url())) shaderFallbacks.push(request.url());
    });
    await openTestProject(page);
    const albedoGuid = await importAlbedoTexture(page);

    // The look is the Material: a Texture Sample with unwired UV reads particle_uv.
    const materialGuid = await createParticleMaterial(page, "SparksMat");
    await addMaterialPaletteNode(page, "Texture Sample", "texture.sample");
    await pickMaterialNodeTexture(page, albedoGuid);
    await connectMaterialPins(
      page,
      "texture.sample-",
      "rgba",
      '[data-id="output"]',
      "color",
    );
    await expect(
      page
        .getByTestId("material-graph-editor")
        .locator('.react-flow__edge[data-id*=":rgba:output:color"]'),
    ).toHaveCount(1);
    await compileMaterialPreview(page);
    await saveAllIfEnabled(page);

    await createContentBrowserAsset(page, "ParticleEmitter", "Sparks");
    await openAssetFromBrowser(page, "assets/Sparks.emitter.babasset");
    await expect(
      page.getByTestId("document-workspace-particle-emitter"),
    ).toBeVisible();
    await expect(
      page.getByTestId("particle-emitter-details-panel"),
    ).toBeVisible();
    await expect(page.getByTestId("windows-menu")).toBeEnabled();
    await openWindowsMenu(page);
    await expect(
      page.getByTestId("windows-menu-particle-emitter-preview"),
    ).toBeVisible();
    await expect(
      page.getByTestId("windows-menu-particle-emitter-details"),
    ).toBeVisible();
    await closeWindowsMenu(page);

    const preview = page.getByTestId("particle-emitter-preview");
    await expect(preview).toBeVisible();
    await expect(preview.getByTestId("particle-preview-empty")).toContainText(
      "No Material",
    );
    await preview.getByTestId("particle-preview-action").click();
    await pickAsset(page, "particle-preview-material-picker", materialGuid);
    await expect(
      page.getByTestId("particle-emitter-preview-canvas"),
    ).toBeVisible();
    // The backend badge shows only while at least one native system runs.
    await expect(preview.getByTestId("particle-preview-backend")).toBeVisible({
      timeout: 30_000,
    });
    // Preview renders outside the Engine loop; particles must still move in real time.
    const changedPreviewPixels = () =>
      page.getByTestId("particle-emitter-preview-canvas").evaluate(async (canvas: HTMLCanvasElement) => {
        const context = canvas.getContext("2d");
        if (!context) return 0;
        const before = context.getImageData(0, 0, canvas.width, canvas.height).data;
        await new Promise((resolve) => setTimeout(resolve, 600));
        const after = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let changed = 0;
        for (let i = 0; i < Math.min(before.length, after.length); i += 4) {
          if (Math.abs(before[i]! - after[i]!) > 32) changed += 1;
        }
        return changed;
      });
    await expect.poll(changedPreviewPixels, { timeout: 15_000 }).toBeGreaterThan(200);
    // A Shape class change respawns GPU particles in place. A broken respawn still moves
    // while old particles die, then freezes, so judge motion after one particle lifetime.
    await page.getByTestId("property-shape").click();
    await page.getByRole("option", { name: "Box", exact: true }).click();
    await expect(page.getByTestId("property-shape")).toContainText("Box");
    // The new update program may compile for a while before particles draw again.
    await expect.poll(changedPreviewPixels, { timeout: 15_000 }).toBeGreaterThan(1000);
    const respawnMotion: number[] = [];
    for (let sample = 0; sample < 6; sample += 1) respawnMotion.push(await changedPreviewPixels());
    expect(Math.min(...respawnMotion.slice(3))).toBeGreaterThan(1000);

    await page.getByTestId("module-card-gravity-enabled").click();
    await expect(page.getByTestId("module-card-gravity-body")).toBeVisible();
    // A Lifetime curve runs over the emitter cycle, which Play must accept on an Infinite loop.
    await chooseValueMode(page, "lifetime", "curve");
    await expect(page.getByTestId("property-lifetime-toggle")).toHaveAttribute(
      "aria-label",
      /2 Keys/,
    );

    await createContentBrowserAsset(page, "ParticleSystem", "Fire");
    await openAssetFromBrowser(page, "assets/Fire.particles.babasset");
    await expect(
      page.getByTestId("document-workspace-particle-system"),
    ).toBeVisible();
    await expect(
      page.getByTestId("particle-system-details-panel"),
    ).toBeVisible();
    await addSystemEmitter(page, "assets/Sparks.emitter.babasset", /Sparks/);
    await expect(page.getByText("Preview Skybox")).toBeVisible();
    await saveAllIfEnabled(page);
    await page
      .locator(
        '[data-testid="document-tab"][data-document-kind="particle-emitter"]',
      )
      .getByTestId("document-tab-close")
      .click();
    await expect(page.getByTestId("dirty-close-dialog")).toHaveCount(0);
    await expect(page.getByTestId("particle-preview-empty")).toHaveCount(0);
    await expect(
      page.getByTestId("particle-system-preview-canvas"),
    ).toBeVisible();

    await openMainScene(page);
    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-item-particle").click();
    const particleCard = page
      .locator("[data-testid^='component-card-']")
      .filter({
        has: page.getByRole("button", { name: /^Particle(?: \(|$)/ }),
      });
    await expect(particleCard).toBeVisible();
    await particleCard
      .locator('button[data-testid$="-particleSystemGuid"]')
      .click();
    const systemGuid = await guidForPath(
      page,
      "assets/Fire.particles.babasset",
    );
    expect(systemGuid.length).toBeGreaterThan(0);
    await expect(page.getByTestId("details-asset-picker")).toBeVisible();
    await page.getByTestId(`search-item-${systemGuid}`).click();
    await expect(page.getByTestId("details-asset-picker")).toHaveCount(0);

    await saveAllIfEnabled(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    try {
      await expect(page.getByTestId("scene-loading-dialog")).toHaveCount(0, { timeout: 30_000 });
    } catch (error) {
      await testInfo.attach("particle-shader-failure.json", { body: JSON.stringify({
        shaderErrors, shaderFallbacks,
      }), contentType: "application/json" });
      await page.getByTestId("scene-loading-dialog").getByRole("button", { name: "Stop", exact: true }).click({ timeout: 5_000 });
      await expect(page.getByTestId("play-overlay")).toHaveCount(0);
      throw error;
    }
    await expect
      .poll(async () => particleStats(page), { timeout: 15_000 })
      .toEqual(expect.objectContaining({ systems: 1, playing: 1 }));

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    await expect
      .poll(async () => particleStats(page), { timeout: 10_000 })
      .toEqual(expect.objectContaining({ systems: 0, playing: 0 }));
    expect(shaderFallbacks).toEqual([]);
    expect(shaderErrors).toEqual([]);
  });

  test("Play/Stop Particles are on the Class palette; missing material diagnoses", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openMinimalTestProject(page);
    await openAssetFromBrowser(page, "assets/main.class.babasset");
    const graph = page.getByTestId("graph-panel");
    await expect(graph).toBeVisible();
    await graph
      .locator(".react-flow__pane")
      .dblclick({ position: { x: 24, y: 24 } });
    await expect(page.getByTestId("node-palette")).toBeVisible();
    await page.getByTestId("node-palette-search").fill("Play Particles");
    await expect(
      page.getByTestId("node-palette-item-particles.play"),
    ).toBeVisible();
    await page.getByTestId("node-palette-search").fill("Stop Particles");
    await expect(
      page.getByTestId("node-palette-item-particles.stop"),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await openContentBrowser(page);
    await createContentBrowserAsset(page, "ParticleEmitter", "Bare");
    await createContentBrowserAsset(page, "ParticleSystem", "EmptyLook");
    await openAssetFromBrowser(page, "assets/EmptyLook.particles.babasset");
    await addSystemEmitter(page, "assets/Bare.emitter.babasset", /Bare/);

    await openMainScene(page);
    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-item-particle").click();
    const particleCard = page
      .locator("[data-testid^='component-card-']")
      .filter({
        has: page.getByRole("button", { name: /^Particle(?: \(|$)/ }),
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
    // The slot without a Material is skipped with particle.missing_material.
    await expect(page.getByTestId("play-log-tail")).toContainText(
      /no Material/i,
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
    const materialGuid = await createParticleMaterial(page, "ReopenMat");
    await createContentBrowserAsset(page, "ParticleEmitter", "ReopenSparks");
    await openAssetFromBrowser(page, "assets/ReopenSparks.emitter.babasset");
    await page.getByTestId("property-material").click();
    await pickAsset(page, "particle-emitter-material-picker", materialGuid);
    await expect(page.getByTestId("property-material")).toContainText(/ReopenMat/i);
    const rate = page.getByTestId("property-rate");
    await rate.fill("35");
    await rate.press("Tab");
    await expect(rate).toHaveValue("35");
    await saveAllIfEnabled(page);

    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page.getByTestId("open-listed-project-TestProject").click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await openContentBrowser(page);
    await expect(
      page.locator('[data-asset-path="assets/ReopenSparks.emitter.babasset"]'),
    ).toBeVisible();
    await openAssetFromBrowser(page, "assets/ReopenSparks.emitter.babasset");
    await expect(page.getByTestId("property-material")).toContainText(/ReopenMat/i);
    await expect(page.getByTestId("property-rate")).toHaveValue("35");
  });
});
