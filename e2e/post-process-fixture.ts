import type { Page } from "@playwright/test";
import { encodeAssetDocument } from "../packages/assets/src/asset-document";
import { minimalProjectFiles } from "../packages/assets/src/test-support/minimal-project";
import { createDefaultScene, MAIN_SCENE_FILE, type SerializedScene } from "../packages/core/src/index";
import type { ExportIndexedAsset } from "../packages/exporter/src/index";
import { createDefaultMaterialDocument, type MaterialDocument } from "../packages/shader-graph/src/index";

const guid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
export const POST_PROCESS_SCENE_GUID = guid(1);
export const DISABLED_MASK_GUID = guid(24);

function connect(doc: MaterialDocument, source: string, pin: string, target: string, input: string) {
  doc.edges.push({ id: `${source}-${pin}-${target}-${input}`, sourceNodeId: source, sourcePinId: pin, targetNodeId: target, targetPinId: input });
}

function numericSource() {
  const doc = createDefaultMaterialDocument("Numeric Source", "postProcess");
  doc.nodes.push({ id: "white", type: "const.vec4", position: { x: 0, y: 0 }, properties: { value: [1, 1, 1, 1] } });
  doc.edges = [];
  connect(doc, "white", "out", "output", "color");
  return doc;
}

/** The same saved asset must produce independently parameterized camera passes. */
export function numericTexturePostProcess(): MaterialDocument {
  const doc = createDefaultMaterialDocument("Numeric Texture Gain", "postProcess");
  const node = (id: string, type: string, properties = {}) => ({ id, type, properties, position: { x: 0, y: 0 } });
  doc.nodes.push(
    node("mask", "param.texture", { name: "Mask", textureGuid: guid(21) }),
    node("gain", "param.float", { name: "Gain", value: [1] }),
    node("sample", "texture.sample"), node("tint", "math.multiply"),
    node("multiply", "math.multiply"), node("split", "vector.split"), node("opaque", "vector.combine"),
  );
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-scene-output");
  connect(doc, "mask", "out", "sample", "texture");
  connect(doc, "screenUv", "uv", "sample", "uv");
  connect(doc, "sceneColor", "color", "tint", "a");
  connect(doc, "sample", "rgba", "tint", "b");
  connect(doc, "tint", "out", "multiply", "a");
  connect(doc, "gain", "out", "multiply", "b");
  connect(doc, "multiply", "out", "split", "value");
  for (const channel of ["x", "y", "z"]) connect(doc, "split", channel, "opaque", channel);
  connect(doc, "opaque", "xyzw", "output", "color");
  return doc;
}

/** Numeric 1x1 pixels, generated in memory; no illustration or external asset. */
async function numericPng(page: Page, rgba: readonly number[]): Promise<Uint8Array> {
  return new Uint8Array(await page.evaluate(async (color) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(color), 1, 1), 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Numeric PNG encoding failed")), "image/png"));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, [...rgba]));
}

export async function postProcessFixture(page: Page) {
  const files = await minimalProjectFiles();
  const scene: SerializedScene = createDefaultScene();
  scene.actors = scene.actors.filter((actor) => actor.id === scene.settings.mainCameraActorId);
  scene.settings.grid.showGrid = false;
  scene.settings.postProcessStack = [
    { id: "numeric-source", materialGuid: guid(10), enabled: true },
    { id: "first-tint", materialGuid: guid(11), enabled: true, parameters: { Gain: { kind: "float", value: 0.75 }, Mask: { kind: "texture", textureAssetGuid: guid(22) } } },
    { id: "second-tint", materialGuid: guid(11), enabled: true, parameters: { Gain: { kind: "float", value: 0.5 }, Mask: { kind: "texture", textureAssetGuid: guid(23) } } },
    { id: "disabled-tint", materialGuid: guid(11), enabled: false, parameters: { Gain: { kind: "float", value: 0.5 }, Mask: { kind: "texture", textureAssetGuid: DISABLED_MASK_GUID } } },
  ];
  const assets: ExportIndexedAsset[] = [];
  const payloads = new Map<string, unknown>();
  const bytes = new Map<string, Uint8Array>();
  const add = async (id: string, type: string, name: string, payload: unknown, dependencies: string[], pixels?: Uint8Array) => {
    const path = type === "Scene" ? MAIN_SCENE_FILE : `assets/${name}.${type.toLowerCase()}.babasset`;
    assets.push({ guid: id, type, name, path, rootId: "project", dependencies });
    payloads.set(id, payload);
    bytes.set(id, pixels ?? new TextEncoder().encode(JSON.stringify(payload)));
    files.set(path, await encodeAssetDocument({ guid: id, type, name, version: type === "Scene" ? 3 : 1, payload: payload as Record<string, unknown> }, {
      dependencies,
      ...(pixels ? { headerPayload: payload as Record<string, unknown>, extraChunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data: pixels }] } : {}),
    }));
  };
  await add(guid(10), "Material", "Numeric Source", numericSource(), []);
  await add(guid(11), "Material", "Numeric Texture Gain", numericTexturePostProcess(), [guid(21)]);
  for (const [id, rgba] of [
    [21, [255, 255, 255, 255]], [22, [128, 255, 255, 255]],
    [23, [255, 64, 255, 255]], [24, [255, 255, 128, 255]],
  ] as const) {
    await add(guid(id), "Texture", `Numeric ${id}`, { width: 1, height: 1, usage: "pixelArt", compressionState: "fallback_uncompressed" }, [], await numericPng(page, rgba));
  }
  // Override textures are deliberately absent from stored dependency metadata.
  // Production collectors must discover enabled and disabled entry parameters.
  await add(POST_PROCESS_SCENE_GUID, "Scene", "Main", scene, [guid(10), guid(11)]);
  return { files, scene, assets, payloads, bytes };
}
