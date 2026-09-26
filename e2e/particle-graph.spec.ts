import { expect, test, type Locator, type Page } from "@playwright/test";
import { closeProjectViaSettings } from "./close-project";
import {
  addMaterialPaletteNode,
  compileMaterialPreview,
  connectMaterialPins,
  guidForPath,
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

async function pickAsset(page: Page, pickerTestId: string, guid: string): Promise<void> {
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

/** Particle Domain Material; with `particleColor` it draws each particle's own color. */
async function createParticleMaterial(
  page: Page,
  name: string,
  options: { particleColor?: boolean } = {},
): Promise<string> {
  await createContentBrowserAsset(page, "Material", name);
  await openAssetFromBrowser(page, `assets/${name}.material.babasset`);
  await expect(page.getByTestId("document-workspace-material")).toBeVisible();
  await page.getByTestId("property-domain").click();
  await page.getByRole("option", { name: "Particle", exact: true }).click();
  await expect(page.getByTestId("property-domain")).toContainText("Particle");
  if (options.particleColor) {
    await addMaterialPaletteNode(page, "Particle Color", "input.particleColor");
    await connectMaterialPins(page, "input.particleColor-", "color", '[data-id="output"]', "color");
    await expect(
      page
        .getByTestId("material-graph-editor")
        .locator('.react-flow__edge[data-id*=":color:output:color"]'),
    ).toHaveCount(1);
    await compileMaterialPreview(page);
  }
  const guid = await guidForPath(page, `assets/${name}.material.babasset`);
  expect(guid.length).toBeGreaterThan(0);
  return guid;
}

function particleGraphEditor(page: Page): Locator {
  return page.getByTestId("particle-graph-editor");
}

/** Adds a node from the Particle Graph palette and selects it. */
async function addParticleGraphNode(page: Page, search: string, type: string): Promise<Locator> {
  const graph = particleGraphEditor(page);
  await expect(graph).toBeVisible();
  await graph.getByTestId("graph-add-node").click();
  await expect(page.getByTestId("node-palette")).toBeVisible();
  await page.getByTestId("node-palette-search").fill(search);
  await page.getByTestId(`node-palette-item-${type}`).click();
  await expect(page.getByTestId("node-palette")).toHaveCount(0);
  const node = graph.locator(`.react-flow__node[data-id^="${type}-"]`);
  await expect(node).toHaveCount(1);
  await node.click();
  return node;
}

/** Wires the Float node's Value into Emitter Output's Emit Rate. */
async function connectFloatToEmitRate(page: Page): Promise<void> {
  const graph = particleGraphEditor(page);
  await graph
    .locator('.react-flow__node[data-id^="const.float-"] [data-handleid="out"][data-handlepos="right"]')
    .click({ force: true });
  await graph
    .locator('.react-flow__node[data-id="output"] [data-handleid="emitRate"][data-handlepos="left"]')
    .click({ force: true });
  await expect(graph.locator('.react-flow__edge[data-id*=":out:output:emitRate"]')).toHaveCount(1);
}

async function setNumberRow(details: Locator, rowId: string, value: string): Promise<void> {
  const input = details.getByTestId(`property-${rowId}`);
  await input.fill(value);
  await input.press("Tab");
  await expect(input).toHaveValue(value);
}

async function closeDocumentTab(page: Page, kind: string): Promise<void> {
  await page
    .locator(`[data-testid="document-tab"][data-document-kind="${kind}"]`)
    .getByTestId("document-tab-close")
    .click();
  await expect(page.getByTestId("dirty-close-dialog")).toHaveCount(0);
  await expect(page.getByTestId(`document-workspace-${kind}`)).toHaveCount(0);
}

/** Adds the emitter or graph as the next slot of the open Particle System. */
async function addSystemEmitter(page: Page, emitterPath: string, index: number, name: RegExp): Promise<void> {
  const emitterGuid = await guidForPath(page, emitterPath);
  expect(emitterGuid.length).toBeGreaterThan(0);
  await page.getByTestId("particle-system-emitters-add").click();
  await pickAsset(page, "particle-system-emitter-picker", emitterGuid);
  await expect(page.getByTestId(`particle-system-emitter-${index}`)).toContainText(name);
}

/** Pixels that changed by more than 32 levels across 600 ms of real time. */
function changedPixels(canvas: Locator): () => Promise<number> {
  return () =>
    canvas.evaluate(async (element: HTMLCanvasElement) => {
      const context = element.getContext("2d");
      if (!context) return 0;
      const before = context.getImageData(0, 0, element.width, element.height).data;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const after = context.getImageData(0, 0, element.width, element.height).data;
      let changed = 0;
      for (let i = 0; i < Math.min(before.length, after.length); i += 4) {
        if (Math.abs(before[i]! - after[i]!) > 32) changed += 1;
      }
      return changed;
    });
}

/** Picks a Value Mode for a Basic emitter Details row (`value-mode-<rowId>`). */
async function chooseValueMode(page: Page, rowId: string, mode: "constant" | "range" | "curve"): Promise<void> {
  const menu = page.getByTestId(`value-mode-${rowId}-menu`);
  await page.getByTestId(`value-mode-${rowId}`).click();
  await expect(menu).toBeVisible();
  await page.getByTestId(`value-mode-${rowId}-${mode}`).click();
  // Radio items keep the menu open unless the host closes on click.
  if (await menu.isVisible()) await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

type ParticleFrame = { green: number; white: number };

/**
 * Reads `count` consecutive animation frames of the canvas at half resolution. Particles blend
 * additively and move, so each pixel's minimum over the window is the particle-free background;
 * a frame's particles are what it adds to that: green (Basic emitter) or white (Particle Graph).
 */
async function particleFrames(canvas: Locator, count: number): Promise<ParticleFrame[]> {
  return canvas.evaluate(async (element: HTMLCanvasElement, count) => {
    const copy = document.createElement("canvas");
    const context = copy.getContext("2d", { willReadFrequently: true });
    if (!context) return [];
    let frames: Uint8ClampedArray[] = [];
    for (let attempt = 0; frames.length < count && attempt < count * 10; attempt += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const width = Math.floor(element.width / 2);
      const height = Math.floor(element.height / 2);
      if (!width || !height) continue;
      // An output resize restarts the window, so every frame shares one background.
      if (copy.width !== width || copy.height !== height) {
        copy.width = width;
        copy.height = height;
        frames = [];
      }
      context.drawImage(element, 0, 0, width, height);
      frames.push(context.getImageData(0, 0, width, height).data);
    }
    if (!frames.length) return [];
    const background = new Uint8ClampedArray(frames[0]!);
    for (const data of frames) {
      for (let i = 0; i < data.length; i += 1) if (data[i]! < background[i]!) background[i] = data[i]!;
    }
    return frames.map((data) => {
      let green = 0;
      let white = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]! - background[i]!;
        const g = data[i + 1]! - background[i + 1]!;
        const b = data[i + 2]! - background[i + 2]!;
        if (g > 40 && r < 25 && b < 25) green += 1;
        else if (r > 30 && g > 30 && b > 30) white += 1;
      }
      return { green, white };
    });
  }, count);
}

async function particleStats(page: Page): Promise<{
  systems: number;
  playing: number;
  graphSystems: number;
} | null> {
  return page.evaluate(() => {
    const stats = (
      window as {
        __babylonslateParticleStats?: { systems: number; playing: number; graphSystems: number };
      }
    ).__babylonslateParticleStats;
    return stats
      ? { systems: stats.systems, playing: stats.playing, graphSystems: stats.graphSystems }
      : null;
  });
}

test.describe("Particle Graph", () => {
  test("authors a Particle Graph, previews it on the CPU, and plays it beside a Basic emitter", async ({
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
    const materialGuid = await createParticleMaterial(page, "EmberMat", { particleColor: true });
    await saveAllIfEnabled(page);

    await createContentBrowserAsset(page, "ParticleGraph", "Embers");
    await openAssetFromBrowser(page, "assets/Embers.particlegraph.babasset");
    await expect(page.getByTestId("document-workspace-particle-graph")).toBeVisible();
    await expect(page.getByTestId("windows-menu")).toBeEnabled();
    await openWindowsMenu(page);
    for (const [id, title] of [
      ["canvas", "Graph"],
      ["preview", "Preview"],
      ["details", "Details"],
      ["compiler-results", "Compiler Results"],
    ] as const) {
      await expect(page.getByTestId(`windows-menu-particle-graph-${id}`)).toContainText(title);
    }
    await closeWindowsMenu(page);

    // The default graph validates with only the missing Material warning.
    const results = page.getByTestId("particle-graph-compiler-results");
    await expect(results.getByTestId("particle-graph-diagnostic-particle.missingMaterial")).toBeVisible();
    await expect(results.locator('[data-testid^="particle-graph-diagnostic-"]')).toHaveCount(1);
    const preview = page.getByTestId("particle-graph-preview");
    await expect(preview.getByTestId("particle-preview-empty")).toContainText("No Material");
    await preview.getByTestId("particle-preview-action").click();
    await pickAsset(page, "particle-preview-material-picker", materialGuid);
    const details = page.getByTestId("particle-graph-details-panel");
    await expect(details.getByTestId("property-material")).toContainText(/EmberMat/);
    await expect(results).toContainText("No Issues");
    const previewCanvas = preview.getByTestId("particle-graph-preview-canvas");
    await expect(previewCanvas).toBeVisible();
    // The badge shows only while a native system runs; graphs always simulate on the CPU.
    await expect(preview.getByTestId("particle-preview-backend")).toHaveText("CPU", { timeout: 30_000 });
    await expect.poll(changedPixels(previewCanvas), { timeout: 15_000 }).toBeGreaterThan(200);

    // Emit Rate is a Details row until a wire drives it.
    await expect(details.getByTestId("property-emitRate")).toBeVisible();
    await addParticleGraphNode(page, "Float", "const.float");
    await setNumberRow(details, "value", "40");
    await connectFloatToEmitRate(page);
    await particleGraphEditor(page).locator('.react-flow__node[data-id="output"]').click();
    await expect(details.getByTestId("property-capacity")).toBeVisible();
    await expect(details.getByTestId("property-emitRate")).toHaveCount(0);
    // The rebuilt graph still emits, and neither validation nor the build reports anything.
    await expect.poll(changedPixels(previewCanvas), { timeout: 15_000 }).toBeGreaterThan(200);
    await expect(preview.getByTestId("particle-preview-backend")).toHaveText("CPU");
    await expect(results).toContainText("No Issues");
    await expect(results.locator('[data-testid^="particle-graph-diagnostic-"]')).toHaveCount(0);
    await saveAllIfEnabled(page);

    await createContentBrowserAsset(page, "ParticleEmitter", "EmberSparks");
    await openAssetFromBrowser(page, "assets/EmberSparks.emitter.babasset");
    await expect(page.getByTestId("document-workspace-particle-emitter")).toBeVisible();
    const emitterDetails = page.getByTestId("particle-emitter-details-panel");
    await emitterDetails.getByTestId("property-material").click();
    await pickAsset(page, "particle-emitter-material-picker", materialGuid);
    const basicBackend = page.getByTestId("particle-emitter-preview").getByTestId("particle-preview-backend");
    await expect(basicBackend).toHaveText(/^(GPU|CPU)$/, { timeout: 30_000 });
    // Constant green, dense and large, so Play can tell this emitter's pixels from the white graph.
    await chooseValueMode(page, "color", "constant");
    const hex = emitterDetails.getByTestId("property-color-hex");
    await hex.fill("#00ff00");
    await hex.press("Tab");
    await expect(hex).toHaveValue(/00ff00/i);
    await setNumberRow(emitterDetails, "rate", "60");
    await setNumberRow(emitterDetails, "size-max", "0.8");
    await setNumberRow(emitterDetails, "size-min", "0.6");
    // Each slot keeps its own backend: a GPU Basic emitter next to a graph reads GPU + CPU.
    const systemBackend = (await basicBackend.textContent()) === "GPU" ? "GPU + CPU" : "CPU";
    await saveAllIfEnabled(page);
    // Closed tabs make the System and Play load both kinds from disk.
    await closeDocumentTab(page, "particle-emitter");
    await closeDocumentTab(page, "particle-graph");

    await createContentBrowserAsset(page, "ParticleSystem", "EmberMix");
    await openAssetFromBrowser(page, "assets/EmberMix.particles.babasset");
    await expect(page.getByTestId("particle-system-details-panel")).toBeVisible();
    await addSystemEmitter(page, "assets/EmberSparks.emitter.babasset", 0, /EmberSparks/);
    await addSystemEmitter(page, "assets/Embers.particlegraph.babasset", 1, /Embers/);
    const systemPreview = page.getByTestId("particle-system-preview");
    await expect(systemPreview.getByTestId("particle-system-preview-canvas")).toBeVisible();
    await expect(systemPreview.getByTestId("particle-preview-backend")).toHaveText(systemBackend, {
      timeout: 30_000,
    });
    await expect(systemPreview.getByTestId("particle-preview-notice")).toHaveCount(0);
    await saveAllIfEnabled(page);

    await openMainScene(page);
    await page.getByTestId("outliner-add-actor").click();
    await expect(page.getByTestId("place-actors-catalog")).toBeVisible();
    await page.getByTestId("place-actors-item-particle").click();
    const particleCard = page
      .locator("[data-testid^='component-card-']")
      .filter({ has: page.getByRole("button", { name: /^Particle(?: \(|$)/ }) });
    await expect(particleCard).toBeVisible();
    await particleCard.locator('button[data-testid$="-particleSystemGuid"]').click();
    const systemGuid = await guidForPath(page, "assets/EmberMix.particles.babasset");
    expect(systemGuid.length).toBeGreaterThan(0);
    await pickAsset(page, "details-asset-picker", systemGuid);

    await saveAllIfEnabled(page);
    await clickPlayAndWaitForOverlay(page);
    await expect(page.getByTestId("play-canvas")).toBeVisible();
    try {
      await expect(page.getByTestId("scene-loading-dialog")).toHaveCount(0, { timeout: 30_000 });
    } catch (error) {
      await testInfo.attach("particle-graph-shader-failure.json", {
        body: JSON.stringify({ shaderErrors, shaderFallbacks }),
        contentType: "application/json",
      });
      await page
        .getByTestId("scene-loading-dialog")
        .getByRole("button", { name: "Stop", exact: true })
        .click({ timeout: 5_000 });
      await expect(page.getByTestId("play-overlay")).toHaveCount(0);
      throw error;
    }
    // One component playing one System: a Basic system and a graph-built system.
    await expect
      .poll(async () => particleStats(page), { timeout: 15_000 })
      .toEqual({ systems: 2, playing: 1, graphSystems: 1 });
    // Play draws through the FrameGraph, whose culling gates each particle draw on its emitter.
    // Both slots must show on nearly every frame, not only on the classic frame after a resize.
    let frames: ParticleFrame[] = [];
    try {
      await expect
        .poll(async () => {
          frames = await particleFrames(page.getByTestId("play-canvas"), 40);
          return frames.filter((frame) => frame.green >= 4 && frame.white >= 4).length / 40;
        }, { timeout: 20_000 })
        .toBeGreaterThanOrEqual(0.9);
    } finally {
      await testInfo.attach("play-particle-frames.json", { body: JSON.stringify(frames), contentType: "application/json" });
    }

    await page.getByTestId("play-overlay-close").click();
    await expect(page.getByTestId("play-overlay")).toHaveCount(0);
    await expect
      .poll(async () => particleStats(page), { timeout: 10_000 })
      .toEqual(expect.objectContaining({ systems: 0, playing: 0 }));
    expect(shaderFallbacks).toEqual([]);
    expect(shaderErrors).toEqual([]);
  });

  test("Particle Graph nodes, wires and Material survive save and reopen", async ({ page }) => {
    test.setTimeout(240_000);
    await openTestProject(page);
    const materialGuid = await createParticleMaterial(page, "KeepMat");
    await createContentBrowserAsset(page, "ParticleGraph", "KeptGraph");
    await openAssetFromBrowser(page, "assets/KeptGraph.particlegraph.babasset");
    await expect(page.getByTestId("document-workspace-particle-graph")).toBeVisible();
    const details = page.getByTestId("particle-graph-details-panel");
    await details.getByTestId("property-material").click();
    await pickAsset(page, "particle-graph-material-picker", materialGuid);
    await expect(details.getByTestId("property-material")).toContainText(/KeepMat/);
    await addParticleGraphNode(page, "Float", "const.float");
    await setNumberRow(details, "value", "12");
    await connectFloatToEmitRate(page);
    await saveAllIfEnabled(page);

    await closeProjectViaSettings(page);
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("homepage")).toBeVisible();
    await page.getByTestId("open-listed-project-TestProject").click();
    await expect(page.getByTestId("editor-chrome-bar")).toBeVisible();
    await openContentBrowser(page);
    await openAssetFromBrowser(page, "assets/KeptGraph.particlegraph.babasset");
    await expect(page.getByTestId("document-workspace-particle-graph")).toBeVisible();
    await expect(details.getByTestId("property-material")).toContainText(/KeepMat/);
    const graph = particleGraphEditor(page);
    await expect(graph.locator('.react-flow__edge[data-id*=":out:output:emitRate"]')).toHaveCount(1);
    await graph.locator('.react-flow__node[data-id^="const.float-"]').click();
    await expect(details.getByTestId("property-value")).toHaveValue("12");
  });
});
