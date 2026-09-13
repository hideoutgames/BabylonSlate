import { expect, test, type Locator } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { PROJECT_FILE } from "../packages/core/src/project";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser } from "./open-test-project";
import { compileMaterialPreview, connectMaterialPins } from "./material-graph";

async function pixels(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((node: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = node.width;
    copy.height = node.height;
    const ctx = copy.getContext("2d")!;
    ctx.drawImage(node, 0, 0);
    return Array.from(ctx.getImageData(0, 0, copy.width, copy.height).data);
  });
}

function differentPixels(a: number[], b: number[]): number {
  expect(b.length).toBe(a.length);
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    if ([0, 1, 2].some((channel) => Math.abs(a[i + channel]! - b[i + channel]!) > 5)) count++;
  }
  return count;
}

for (const mode of ["pbr", "cel"]) {
  test(`${mode} flat normal fallback changes lighting and a connected Normal takes precedence`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && /shader|ERROR: 0:|VALIDATE_STATUS/i.test(message.text())) errors.push(message.text());
    });
    const doc = createDefaultMaterialDocument("Normals");
    doc.preview.mesh = "sphere";
    doc.nodes.push({ id: "modelNormal", type: "input.vertexNormalWS", position: { x: -300, y: 300 }, properties: {} });
    const files = await minimalProjectFiles();
    const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
    project.settings.render.mode = mode;
    files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
    const path = "assets/Normals.material.babasset";
    files.set(path, await encodeAssetDocument({ guid: "00000000-0000-4000-8000-000000000010", type: "Material", name: "Normals", version: 1, payload: doc as unknown as Record<string, unknown> }));
    await openMinimalTestProject(page, files);
    await openAssetFromBrowser(page, path);
    await compileMaterialPreview(page);
    const canvas = page.getByTestId("material-preview-canvas");
    const model = await pixels(canvas);
    await canvas.screenshot({ path: testInfo.outputPath(`${mode}-model-normals.png`) });
    await page.getByTestId("property-defaultNormals").click();
    await page.getByRole("option", { name: "Flat Normals", exact: true }).click();
    await compileMaterialPreview(page);
    await expect.poll(async () => differentPixels(model, await pixels(canvas))).toBeGreaterThan(100);
    await canvas.screenshot({ path: testInfo.outputPath(`${mode}-flat-normals.png`) });
    await connectMaterialPins(page, "modelNormal", "normal", '[data-id="output"]', "normal");
    await compileMaterialPreview(page);
    await expect.poll(async () => differentPixels(model, await pixels(canvas))).toBeLessThan(30);
    expect(errors).toEqual([]);
  });
}
