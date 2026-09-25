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
import type { runWaterRenderingProof } from "../apps/editor/src/testing/water-rendering-proof";

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
    expect(errors).toEqual([]);
    expect(result.differences.realistic).toBeLessThan(2);
    expect(result.differences.stylized).toBeLessThan(2);
    // The preview lights plus a sun must still shade the water, not collapse it to black.
    expect(result.brightness.realistic).toBeGreaterThan(20);
    expect(result.brightness.stylized).toBeGreaterThan(40);
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
      await expect(canvas).toBeVisible();
      await expect(page.getByTestId("water-details-panel").filter({ visible: true })).toBeVisible();
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
