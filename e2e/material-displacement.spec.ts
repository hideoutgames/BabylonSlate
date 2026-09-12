import { expect, test } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { createContentBrowserAsset, openAssetFromBrowser } from "./open-test-project";
import { addMaterialPaletteNode, compileMaterialPreview, connectMaterialPins } from "./material-graph";
import { PROJECT_FILE } from "../packages/core/src/project";

for (const mode of ["pbr", "cel"]) {
test(`animated normal displacement keeps the ${mode} Material preview rendering`, async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /shader|ERROR: 0:|VALIDATE_STATUS/i.test(message.text())) {
      errors.push(message.text());
    }
  });
  const doc = createDefaultMaterialDocument();
  doc.preview.mesh = "sphere";
  doc.nodes.push(
    { id: "time", type: "input.time", position: { x: -500, y: 0 }, properties: { timeMode: "seconds" } },
    { id: "sine", type: "math.sin", position: { x: -250, y: 0 }, properties: {} },
    { id: "normal", type: "input.vertexNormalWS", position: { x: -250, y: 250 }, properties: {} },
    { id: "multiply", type: "math.multiply", position: { x: 0, y: 250 }, properties: {} },
  );
  doc.edges.push(
    { id: "time-sine", sourceNodeId: "time", sourcePinId: "time", targetNodeId: "sine", targetPinId: "value" },
    { id: "sine-multiply", sourceNodeId: "sine", sourcePinId: "out", targetNodeId: "multiply", targetPinId: "a" },
    { id: "normal-multiply", sourceNodeId: "normal", sourcePinId: "normal", targetNodeId: "multiply", targetPinId: "b" },
    { id: "multiply-emissive", sourceNodeId: "multiply", sourcePinId: "out", targetNodeId: "output", targetPinId: "emissive" },
  );
  const files = await minimalProjectFiles();
  const project = JSON.parse(new TextDecoder().decode(files.get(PROJECT_FILE)!));
  project.settings.render.mode = mode;
  files.set(PROJECT_FILE, new TextEncoder().encode(JSON.stringify(project)));
  const path = "assets/Displacement.material.babasset";
  files.set(path, await encodeAssetDocument({
    guid: "00000000-0000-4000-8000-000000000010",
    type: "Material", name: "Displacement", version: 1,
    payload: doc as unknown as Record<string, unknown>,
  }));
  await openMinimalTestProject(page, files);
  await openAssetFromBrowser(page, path);
  await compileMaterialPreview(page);
  const canvas = page.getByTestId("material-preview-canvas");
  await connectMaterialPins(page, "multiply", "out", '[data-id="output"]', "worldPositionOffset");
  await expect(page.getByTestId("material-graph-editor").locator('.react-flow__edge')).toHaveCount(doc.edges.length + 1);
  await compileMaterialPreview(page);
  const first = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
  await expect.poll(() => errors).toEqual([]);
  await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL()), { timeout: 10_000 }).not.toBe(first);
  const second = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
  await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL()), { timeout: 10_000 }).not.toBe(second);
  expect(errors).toEqual([]);
});
}

test("authoring Time Sine Multiply and VertexNormalWS keeps the preview live", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /shader|ERROR: 0:|VALIDATE_STATUS/i.test(message.text())) errors.push(message.text());
  });
  await openMinimalTestProject(page);
  await createContentBrowserAsset(page, "Material", "Animated");
  await openAssetFromBrowser(page, "assets/Animated.material.babasset");
  const graph = page.getByTestId("material-graph-editor");
  for (const [title, type, dx, dy] of [
    ["Time", "input.time", -230, -140],
    ["Sine", "math.sin", -110, 0],
    ["Multiply", "math.multiply", 150, 100],
    ["VertexNormalWS", "input.vertexNormalWS", -180, 180],
  ] as const) {
    await addMaterialPaletteNode(page, title, type);
    const node = graph.locator(`.react-flow__node[data-id^="${type}-"]`);
    const box = await node.locator("[data-node-role] > div").first().boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + Math.min(20, box!.width / 2);
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 8 });
    await page.mouse.up();
  }
  await connectMaterialPins(page, "input.time-", "time", '[data-id^="math.sin-"]', "value");
  await connectMaterialPins(page, "math.sin-", "out", '[data-id^="math.multiply-"]', "a");
  await connectMaterialPins(page, "input.vertexNormalWS-", "normal", '[data-id^="math.multiply-"]', "b");
  await connectMaterialPins(page, "math.multiply-", "out", '[data-id="output"]', "worldPositionOffset");
  await expect(graph.locator('.react-flow__edge')).toHaveCount(5);
  await compileMaterialPreview(page);
  const canvas = page.getByTestId("material-preview-canvas");
  const first = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
  await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL()), { timeout: 10_000 }).not.toBe(first);
  expect(errors).toEqual([]);
});
