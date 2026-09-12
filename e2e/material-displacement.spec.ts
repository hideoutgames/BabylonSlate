import { expect, test } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultMaterialDocument } from "../packages/shader-graph/src/document";
import { openMinimalTestProject } from "./minimal-project";
import { openAssetFromBrowser } from "./open-test-project";
import { compileMaterialPreview, connectMaterialPins } from "./material-graph";
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
