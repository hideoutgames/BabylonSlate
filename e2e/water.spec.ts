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
import type { runWaterRenderingProof, runWaterTierProof } from "../apps/editor/src/testing/water-rendering-proof";

test.use({ launchOptions: { args: SOFTWARE_WEBGPU_ARGS } });

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
    await testInfo.attach("tier-captures", { body: JSON.stringify(result.captures), contentType: "application/json" });
    // Each tier compiles its own variant (Low to Ultra, both styles, with the asset features on): none may fail to
    // compile, and none may draw black, including with seven scene lights on Low (unlit) and Ultra.
    expect(errors).toEqual([]);
    expect(result.captures).toHaveLength(4 * 6);
    for (const { tier, view, light } of result.captures) expect(light, `${view} at ${tier}`).toBeGreaterThan(20);
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
