import { expect, test, type Page } from "@playwright/test";
import { encodeGlbJsonBin } from "../packages/assets/src/importers/glb-parse";
import { guidForPath } from "./material-graph";
import { openContentBrowser, openMainScene, openTestProject } from "./open-test-project";

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;

/**
 * A skinned 2 x 2 quad with no NORMAL, like the Khronos Fox, tilted so that its
 * face normal (0, 0.6, -0.8) points at the editor camera and up toward the sun.
 */
function skinnedQuadWithoutNormals(): Uint8Array {
  const [a, b, c, d] = [[-1, 0, 0], [1, 0, 0], [-1, 1.6, 1.2], [1, 1.6, 1.2]];
  const positions = Float32Array.from([a, c, b, b, c, d].flat());
  const joints = new Uint8Array(6 * 4);
  const weights = Float32Array.from(Array.from({ length: 6 }, () => [1, 0, 0, 0]).flat());
  const arrays = [positions, joints, weights];
  const bin = new Uint8Array(arrays.reduce((total, array) => total + array.byteLength, 0));
  let offset = 0;
  const bufferViews = arrays.map((array) => {
    bin.set(new Uint8Array(array.buffer), offset);
    offset += array.byteLength;
    return { buffer: 0, byteOffset: offset - array.byteLength, byteLength: array.byteLength };
  });
  return encodeGlbJsonBin(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0, skin: 0 }, { children: [2] }, {}],
      skins: [{ joints: [1, 2] }],
      materials: [{ name: "Red", pbrMetallicRoughness: { baseColorFactor: [0.9, 0.2, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, material: 0 }] }],
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: 6, type: "VEC3", min: [-1, 0, 0], max: [1, 1.6, 1.2] },
        { bufferView: 1, componentType: UNSIGNED_BYTE, count: 6, type: "VEC4" },
        { bufferView: 2, componentType: FLOAT, count: 6, type: "VEC4" },
      ],
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
    },
    bin,
  );
}

/** Pixels in the quad's warm red: not the blue sky and grid, and far more of them than the selection outline and gizmo draw. */
async function litRedPixels(page: Page): Promise<number> {
  return page.getByTestId("viewport-canvas").evaluate((canvas: HTMLCanvasElement) => {
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(canvas, 0, 0);
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index]! > 100 && data[index]! > data[index + 1]! * 1.4 && data[index]! > data[index + 2]! * 1.8) count++;
    }
    return count;
  });
}

test("a skinned model whose file has no normals is lit, not black", async ({ page }) => {
  await openTestProject(page);
  await openMainScene(page);
  await openContentBrowser(page);
  await page.getByTestId("content-browser-import-input").setInputFiles({
    name: "FlatQuad.glb",
    mimeType: "model/gltf-binary",
    buffer: Buffer.from(skinnedQuadWithoutNormals()),
  });
  await expect(page.locator('[data-asset-path="assets/FlatQuad.babasset"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("importing-overlay")).toHaveCount(0);
  const modelGuid = await guidForPath(page, "assets/FlatQuad.babasset");
  await openMainScene(page);
  await page.getByTestId("outliner-add-actor").click();
  await page.getByTestId("place-actors-catalog-search").fill("FlatQuad");
  await page.getByTestId(`place-actors-item-asset-${modelGuid}`).click();
  // An unlit quad would stay black; a lit one shows its red base color over thousands of pixels.
  await expect.poll(() => litRedPixels(page), { timeout: 30_000 }).toBeGreaterThan(3000);
});
