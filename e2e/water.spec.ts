import { expect, test, type Locator } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { MATERIAL_PAYLOAD_VERSION } from "../packages/assets/src/migration";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { PROJECT_FILE } from "../packages/core/src/project";
import { createDefaultWaterDefinition } from "../packages/core/src/water";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser, openMainScene } from "./open-test-project";
import { SOFTWARE_WEBGPU_ARGS } from "./software-webgpu";
import type { runWaterFftDetailProof, runWaterObjectProof, runWaterRenderingProof, runWaterTierProof } from "../apps/editor/src/testing/water-rendering-proof";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

/** Mean per-channel change (0-255) a tier capture must show against the same view without water. */
const WATER_OVER_VIEW = 8;
/** Mean per-channel change between a view's Low and High captures. */
const LOW_TO_HIGH = 3;

async function centerColor(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    const ctx = node.getContext("2d")!;
    const data = ctx.getImageData(Math.floor(node.width * 0.45), Math.floor(node.height * 0.45), Math.max(1, Math.floor(node.width * 0.1)), Math.max(1, Math.floor(node.height * 0.1))).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let channel = 0; channel < 3; channel++) sum[channel] += data[i + channel]!;
    return sum.map((value) => value / (data.length / 4));
  });
}

for (const backend of ["webgl2", "webgpu"] as const) {
  test(`Water shading stays in world space when volumes move and stretch on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&waterRenderingProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __babylonslateWaterRenderingProof?: unknown }).__babylonslateWaterRenderingProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as { __babylonslateWaterRenderingProof: typeof runWaterRenderingProof }).__babylonslateWaterRenderingProof(backend), backend);
    for (const [name, png] of Object.entries(result.evidence)) {
      const bytes = Buffer.from(png.split(",")[1]!, "base64");
      await testInfo.attach(name, { body: bytes, contentType: "image/png" });
      await import("node:fs/promises").then((fs) => fs.writeFile(testInfo.outputPath(name + ".png"), bytes));
    }
    const metrics = JSON.stringify({ ...result, evidence: undefined });
    await testInfo.attach("metrics", { body: metrics, contentType: "application/json" });
    await import("node:fs/promises").then((fs) => fs.writeFile(testInfo.outputPath("metrics.json"), metrics));
    expect(errors).toEqual([]);
    expect(result.differences.realistic).toBeLessThan(2);
    expect(result.differences.stylized).toBeLessThan(2);
    // The preview lights plus a sun must still shade the water, not collapse it to black, even with seven lights.
    expect(result.brightness.realistic).toBeGreaterThan(20);
    expect(result.brightness.stylized).toBeGreaterThan(40);
    expect(result.crowded.realistic).toBeGreaterThan(20);
    expect(result.crowded.stylized).toBeGreaterThan(40);
    for (const style of ["realistic", "stylized"] as const) {
      // Crest Foam breaks steep waves into whitecaps; at 0 the sea looks exactly as it does with no foam at all.
      expect(result.whitecaps[style].calmChange).toBeLessThan(0.5);
      expect(result.whitecaps[style].breaking).toBeGreaterThan(result.whitecaps[style].calm + 0.02);
      // Surface Foam adds open-water foam, and Subsurface lightens waves seen toward a low sun.
      expect(result.surfaceFoam[style].foamy).toBeGreaterThan(result.surfaceFoam[style].clear + 6);
      expect(result.subsurface[style].on).toBeGreaterThan(result.subsurface[style].off + 3);
      // Steep Gerstner seas shade from the shared kernel for both wave models: lit (not black), and the eight
      // Ocean Spectrum components draw a different sea from the five Classic ones.
      expect(result.gerstner[style].classic).toBeGreaterThan(20);
      expect(result.gerstner[style].ocean).toBeGreaterThan(20);
      expect(result.gerstner[style].change).toBeGreaterThan(1);
    }
    // Clear water over a black floor still shows the sky's reflection.
    expect(result.clearReflection.water).toBeGreaterThan(result.clearReflection.floor + 15);
    // Under the app's large-world rendering, panning the camera must reveal different, world-anchored water.
    expect(result.pan.realistic).toBeGreaterThan(0.5);
    expect(result.pan.stylized).toBeGreaterThan(0.5);
    // Built-in water displaces its rest grid in the vertex shader: seen side-on through a thin depth slab, it draws the
    // same profile as CPU-displaced vertices to about a millimetre (2.5 mm pixels), for the eight-component Ocean
    // Spectrum at Ultra mesh density and a narrow volume whose horizontal motion fades at its banks; and with only the
    // clock changing, the profile moves.
    for (const name of ["ocean", "bank"] as const) {
      const parity = result.vertexParity[name];
      expect(parity.columns).toBeGreaterThan(result.vertexParity.width * 0.6);
      expect(parity.meanMetres).toBeLessThan(1e-3);
      expect(parity.maxPx).toBeLessThanOrEqual(2);
      expect(parity.reliefMetres).toBeGreaterThan(0.05);
      // And both follow the physics query along the slice.
      expect(parity.queryMeanMetres).toBeLessThan(0.02);
      expect(parity.motionPx).toBeGreaterThan(4);
    }
    expect(result.waveTerrain.crestHeight).toBeGreaterThan(1.6);
    expect(result.waveTerrain.troughHeight).toBeLessThan(-0.4);
    expect(result.waveTerrain.crestDifference).toBeGreaterThan(10);
    expect(result.waveTerrain.troughDifference).toBeLessThan(1);
    // Past a landscape edge there is no terrain: Stylized water there draws no band of shore foam, whether the border
    // sits above the water or just under it (where troughs dip below it), and it is water, not a hole.
    for (const name of ["dry", "shallow"] as const) {
      const edge = result.landscapeEdge[name];
      expect(edge.near, `${name} edge`).toBeLessThan(edge.far + 0.02);
      expect(edge.water, `${name} edge`).toBeGreaterThan(10);
    }
    // A gentle floor deeper than any wave trough reaches is no shore: Stylized water over it draws no foam the same view
    // without it lacks (measuring the shoreline from the full-range depth's 8-bit steps drew contour rings of foam there).
    expect(result.deepFloor.field).toBe(true);
    expect(result.deepFloor.rise).toBeLessThan(0.0002);
    // A post through a lake gets a bright foam ring on its waterline in both styles, even at the
    // realistic preset's low Foam Amount, well above open water beyond its foam and ripples.
    // On a cone the foam follows the rendered wave height: inward at a crest, outward in a trough.
    // Small waves ride outward from the post: next to it the water is far more broken up than open water.
    for (const style of ["realistic", "stylized"] as const) {
      const { ring, open, crest, trough } = result.contact[style];
      expect(result.ripples[style].near).toBeGreaterThan(result.ripples[style].open + 5);
      expect(ring).toBeGreaterThan(open + 30);
      expect(crest.inner).toBeGreaterThan(trough.inner + 20);
      expect(trough.outer).toBeGreaterThan(crest.outer + 20);
    }
  });
  test(`Water compiles and shades every Water Shading Detail in both styles on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&waterRenderingProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __babylonslateWaterTierProof?: unknown }).__babylonslateWaterTierProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as { __babylonslateWaterTierProof: typeof runWaterTierProof }).__babylonslateWaterTierProof(backend), backend);
    for (const [name, png] of Object.entries(result.evidence)) {
      await testInfo.attach(name, { body: Buffer.from(png.split(",")[1]!, "base64"), contentType: "image/png" });
    }
    await testInfo.attach("tier-captures", { body: JSON.stringify({ captures: result.captures, lowToHigh: result.lowToHigh }), contentType: "application/json" });
    // Each tier compiles its own variant (Low to Ultra, both styles, with the asset features on): none may fail to
    // compile, none may draw black, including with seven scene lights on Low (unlit) and Ultra, and every one draws
    // water over the same view without it.
    expect(errors).toEqual([]);
    expect(result.captures).toHaveLength(4 * 6);
    for (const { tier, view, light, water } of result.captures) {
      expect(light, `${view} at ${tier}`).toBeGreaterThan(20);
      expect(water, `${view} at ${tier} against no water`).toBeGreaterThan(WATER_OVER_VIEW);
    }
    // The tier reaches the GPU: Low (unlit Realistic, fewer terms) draws each view differently from High.
    expect(Object.keys(result.lowToHigh)).toHaveLength(6);
    for (const [view, change] of Object.entries(result.lowToHigh)) expect(change, view).toBeGreaterThan(LOW_TO_HIGH);
  });
  test(`Water refracts the scene copy and reflects objects in screen space and planar on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID|planar|scene copy/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&waterRenderingProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __babylonslateWaterObjectProof?: unknown }).__babylonslateWaterObjectProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as { __babylonslateWaterObjectProof: typeof runWaterObjectProof }).__babylonslateWaterObjectProof(backend), backend);
    for (const [name, png] of Object.entries(result.evidence)) {
      const bytes = Buffer.from(png.split(",")[1]!, "base64");
      await testInfo.attach(name, { body: bytes, contentType: "image/png" });
      await import("node:fs/promises").then((fs) => fs.writeFile(testInfo.outputPath(name + ".png"), bytes));
    }
    const metrics = JSON.stringify({ ...result, evidence: undefined }, null, 1);
    await testInfo.attach("metrics", { body: metrics, contentType: "application/json" });
    await import("node:fs/promises").then((fs) => fs.writeFile(testInfo.outputPath("metrics.json"), metrics));
    expect(errors).toEqual([]);
    // Views draw on the Forward FrameGraph with the scene copy whenever refraction or a screen-space march runs.
    expect(result.graphTasks["refraction-on"]).toContain("Water scene copy");
    expect(result.graphTasks["reflection-on-screen-screenSpace"]).toContain("Water scene copy");
    // Refraction: the green box in the lower part of the view shows through the refracted water where it lies and not
    // at the vertically mirrored rows, where a flipped copy lookup would put it, and the refracted floor moves with
    // the waves' normals far more than the blended surface (Refraction 0) changes between the same two wave phases.
    expect(result.refraction.on.compiled).toBe(true);
    expect(result.refraction.off.compiled).toBe(false);
    expect(result.refraction.on.calm - result.refraction.on.calmNoBox).toBeGreaterThan(20);
    expect(Math.abs(result.refraction.on.flipped - result.refraction.on.flippedNoBox)).toBeLessThan(6);
    expect(result.refraction.on.motion).toBeGreaterThan(result.refraction.off.motion * 1.5 + 1);
    // A distant orthographic view bends just as much.
    expect(result.orthographic.on.compiled).toBe(true);
    expect(result.orthographic.on.motion).toBeGreaterThan(result.orthographic.off.motion * 1.5 + 1);
    // A beacon above calm water appears at its mirrored screen position with Screen Space and Planar reflections,
    // and not with Sky Only.
    expect(result.onScreen.screenSpace).toBeGreaterThan(result.onScreen.sky + 40);
    expect(result.onScreen.planar).toBeGreaterThan(result.onScreen.sky + 40);
    // The march reflects the whole mirrored front face, and every other row the planar mirror fills shows either the
    // beacon or the Sky Only colour: no seam where the march settled beside the silhouette.
    expect(result.onScreen.extent.coverage).toBeGreaterThan(0.9);
    expect(result.onScreen.extent.seam).toBeLessThanOrEqual(2);
    // Above the top of the view no screen-space march can find it; the planar mirror still reflects it (weaker: the
    // Fresnel of this steeper view is lower).
    expect(result.offScreen.directNdcY).toBeGreaterThan(1);
    expect(result.offScreen.planar).toBeGreaterThan(result.offScreen.sky + 20);
    expect(result.offScreen.screenSpace).toBeLessThan(result.offScreen.sky + 5);
    expect(result.offScreen.planarDiagnostics?.draws).toBeGreaterThan(0);
    // At Ultra a flat pond that is not the view's dominant body (the planar mirror serves the large lake) still
    // reflects the beacon through the screen-space march.
    expect(result.planarBody).toBe("reflection-dominant");
    expect(result.nonDominant.planar).toBeGreaterThan(result.nonDominant.sky + 40);
    // Every Water Shading Detail in both styles draws lit water, with its copy and reflection features on.
    expect(result.tiers).toHaveLength(8);
    for (const { tier, style, light, water } of result.tiers) {
      expect(light, `${style} at ${tier}`).toBeGreaterThan(20);
      expect(water, `${style} at ${tier} against no water`).toBeGreaterThan(WATER_OVER_VIEW);
    }
    // The largest variant (Ultra Realistic with refraction, the march and the planar mirror) compiles with a seventh
    // light slot, and the lamps light it.
    expect(result.sevenLights.lights).toBe(7);
    expect(result.sevenLights.largestVariant).toBe(true);
    expect(result.sevenLights.light).toBeGreaterThan(20);
    expect(result.sevenLights.water).toBeGreaterThan(WATER_OVER_VIEW);
    expect(result.sevenLights.lamps).toBeGreaterThan(0.5);
    // Scene Linear: refraction over a floor brighter than 1 crosses the shore fade without a dark contour, like the
    // blended surface.
    expect(result.sceneLinear.on.compiled).toBe(true);
    expect(result.sceneLinear.on.contour).toBeLessThan(result.sceneLinear.off.contour + 8);
    // In scene fog the refracted floor keeps its own fog only, matching the blended surface.
    expect(result.fog.compiled).toBe(true);
    expect(result.fog.difference).toBeLessThan(2);
  });
  test(`Water samples the FFT ocean detail band at High and Ultra on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID/i.test(message.text())) errors.push(message.text());
    });
    await page.goto("/?test=1&waterRenderingProof=1");
    await page.waitForFunction(() => typeof (window as unknown as { __babylonslateWaterFftDetailProof?: unknown }).__babylonslateWaterFftDetailProof === "function");
    const result = await page.evaluate((backend) => (window as unknown as { __babylonslateWaterFftDetailProof: typeof runWaterFftDetailProof }).__babylonslateWaterFftDetailProof(backend), backend);
    for (const [name, png] of Object.entries(result.evidence)) {
      const bytes = Buffer.from(png.split(",")[1]!, "base64");
      await testInfo.attach(name, { body: bytes, contentType: "image/png" });
      await import("node:fs/promises").then((fs) => fs.writeFile(testInfo.outputPath(name + ".png"), bytes));
    }
    const metrics = JSON.stringify({ ...result, evidence: undefined }, null, 1);
    await testInfo.attach("metrics", { body: metrics, contentType: "application/json" });
    await import("node:fs/promises").then((fs) => fs.writeFile(testInfo.outputPath("metrics.json"), metrics));
    expect(errors).toEqual([]);
    const tiers = Object.fromEntries(result.tiers.map((entry) => [entry.tier, entry]));
    // Low and Medium compile no band: Detail Waves changes nothing they draw.
    for (const tier of ["low", "medium"] as const) {
      expect(tiers[tier]!.compiled, tier).toBe(0);
      expect(tiers[tier]!.change, tier).toBe(0);
    }
    // High and Ultra sample their preset cascades once the band is ready: more small-scale detail, still lit water with
    // no black (or NaN) pixels.
    for (const [tier, cascades] of [["high", 2], ["ultra", 3]] as const) {
      const entry = tiers[tier]!;
      expect(entry.compiled, tier).toBe(cascades);
      expect(entry.ready, tier).toBe(true);
      expect(entry.change, tier).toBeGreaterThan(1);
      expect(entry.on.detail, tier).toBeGreaterThan(entry.off.detail * 1.1);
      expect(entry.on.black, tier).toBe(0);
      expect(entry.on.light, tier).toBeGreaterThan(20);
    }
    // Ultra splits the same band more finely than High, and each cascade fades by its shortest wavelength, so Ultra's band
    // adds clearly more detail than High's, and still adds some over the farther water, where High's has faded.
    const gain = (entry: (typeof result.tiers)[number], key: "detail" | "farDetail") => entry.on[key] - entry.off[key];
    expect(gain(tiers.ultra!, "detail"), "Ultra over High").toBeGreaterThan(1.5 * gain(tiers.high!, "detail"));
    expect(gain(tiers.ultra!, "farDetail"), "Ultra over High, farther").toBeGreaterThan(Math.max(0.05, 2 * gain(tiers.high!, "farDetail")));
    for (const [name, stats] of Object.entries(result.extra)) {
      expect(stats.black, name).toBe(0);
      expect(stats.light, name).toBeGreaterThan(20);
    }
    // The band is dispatched once per step at that step's water time, and its own part of the capture (Detail Waves 1
    // minus 0 at the same time) changes between steps: it animates rather than freezing.
    for (const [index, step] of result.clock.entries()) {
      expect(step.simulationTime, `step ${index}`).toBeCloseTo(step.time, 9);
      if (index) expect(step.dispatches, `step ${index}`).toBe(result.clock[index - 1]!.dispatches + 1);
    }
    for (const step of result.sequence) expect(step).toBeGreaterThan(0.3);
    // Far from the world origin, straight down: moving the camera moves the band's own part with the world (the
    // floating-origin uv offset), not with the camera. (The analytic surface alone correlates at about 0.97 there, and a
    // difference of two captures doubles its residual, so the band part lands near 0.83 rather than 1.)
    expect(result.anchoring.bandLevel).toBeGreaterThan(1);
    expect(result.anchoring.analytic).toBeGreaterThan(0.9);
    expect(result.anchoring.world).toBeGreaterThan(0.7);
    expect(result.anchoring.camera).toBeLessThan(0.2);
    // Side on, the band displaces the GPU vertices within its bound (Ultra's first cascade, which the 0.125 m grid
    // resolves; finer cascades stay per-pixel); the CPU vertex path draws the analytic surface.
    expect(result.profile.band.columns).toBeGreaterThan(200);
    expect(result.profile.band.meanMetres).toBeGreaterThan(0.004);
    expect(result.profile.band.maxMetres).toBeLessThan(2 * result.profile.bound);
    expect(result.profile.cpu.meanMetres).toBeLessThan(1e-3);
    expect(result.profile.cpu.maxMetres).toBeLessThanOrEqual(2 * result.profile.metresPerPixel);
  });
  test(`Water presets and a custom Water Surface material render on ${backend}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type()) && /shader|WebGPU uncaptured|VALIDATE_STATUS|ERROR: 0:|GL_INVALID/i.test(message.text())) errors.push(message.text());
    });
    const files = await minimalProjectFiles();
    const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
    project.settings.render.gpuBackend = backend;
    files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
    const materialGuid = "00000000-0000-4000-8000-000000000020";
    const material = createDefaultMaterialDocument("Water Effect");
    material.shadingModel = "unlit";
    material.nodes = material.nodes.filter((node) => node.id === "output");
    material.nodes[0]!.properties["default:baseColor"] = [0, 0, 0];
    material.nodes.push(
      { id: "water", type: "input.waterSurface", position: { x: 0, y: 0 }, properties: {} },
      { id: "scale", type: "math.multiply", position: { x: 200, y: 0 }, properties: { "default:b": [0.08] } },
      { id: "color", type: "vector.combine", position: { x: 400, y: 0 }, properties: { "default:y": [0.02], "default:z": [0.6] } },
    );
    material.edges = [
      { id: "bank", sourceNodeId: "water", sourcePinId: "bankDistance", targetNodeId: "scale", targetPinId: "a" },
      { id: "red", sourceNodeId: "scale", sourcePinId: "out", targetNodeId: "color", targetPinId: "x" },
      { id: "surface", sourceNodeId: "color", sourcePinId: "xyz", targetNodeId: "output", targetPinId: "emissive" },
    ];
    files.set("assets/WaterEffect.material.babasset", await encodeAssetDocument({ guid: materialGuid, type: "Material", name: "Water Effect", version: MATERIAL_PAYLOAD_VERSION, payload: material as unknown as Record<string, unknown> }));
    for (const [index, style] of ["realistic", "stylized", "custom"].entries()) {
      files.set(`assets/${style}.water.babasset`, await encodeAssetDocument({
        guid: `00000000-0000-4000-8000-00000000001${index}`, type: "Water", name: style, version: 1,
        payload: { ...createDefaultWaterDefinition(style === "stylized" ? "stylized" : "realistic"), ...(style === "custom" ? { materialGuid } : {}) },
      }, { dependencies: style === "custom" ? [materialGuid] : [] }));
    }
    await openMinimalTestProject(page, files);
    await openMainScene(page);
    for (const style of ["realistic", "stylized", "custom"]) {
      await openAssetFromBrowser(page, `assets/${style}.water.babasset`);
      const canvas = page.getByTestId("water-preview-canvas").filter({ visible: true });
      await expect(canvas).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("water-details-panel").filter({ visible: true })).toBeVisible({ timeout: 30_000 });
      try {
        await expect.poll(async () => {
          const [r, g, b] = await centerColor(canvas);
          return style === "custom" ? Math.min(r! - g!, b! - g!) : Math.min(g! - r!, b! - r!);
        }, { timeout: 20_000 }).toBeGreaterThan(8);
      } finally {
        await canvas.screenshot({ path: testInfo.outputPath(`${style}-${backend}.png`) });
        await testInfo.attach(`${style}-shader-errors`, { body: JSON.stringify(errors), contentType: "application/json" });
      }
      await expect(page.getByText("Preview Failed", { exact: true })).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}
