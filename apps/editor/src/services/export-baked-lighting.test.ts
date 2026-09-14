import { expect, it } from "vitest";
import { createDefaultScene, DEFAULT_RENDER_PROJECT_SETTINGS, normalizeScene } from "@babylonslate/core";
import { bakedLightingImportResult, decodeBabasset, decodeBakedLightingAsset, encodeBakedLightingAsset, type IndexedAsset } from "@babylonslate/assets";
import { createBakedLightingFixture } from "@babylonslate/test-kit/baked-lighting-fixtures";
import { decodeBabpack } from "@babylonslate/exporter";
import { assetHeaderDependencies, assetReferencesIncludingOpenDocuments } from "../lib/content-browser-helpers";
import { loadExportDocuments } from "./export-game-inputs";
import { assetsFromIndexed, collectAndExportGame } from "./export-game";

async function fixture() {
  const { manifest, bytes, atlases } = await createBakedLightingFixture();
  const second = structuredClone(manifest.atlases[0]!);
  second.guid = "second-atlas"; second.chunkId = "atlas:second";
  manifest.atlases.push(second);
  manifest.receivers.push({ ...structuredClone(manifest.receivers[0]!),
    identity: { actorId: "other", componentId: "mesh", primitive: { kind: "mesh" } }, atlasGuid: second.guid });
  atlases.set(second.guid, bytes.slice());
  const result = await bakedLightingImportResult({ guid: "bake", name: "Bake", manifest, atlases });
  const decoded = await decodeBabasset(await encodeBakedLightingAsset(result));
  const bake: IndexedAsset = { rootId: "project", path: "assets/Bake.babasset", header: decoded.header };
  const scene = createDefaultScene();
  scene.settings.bakedLightingAssetGuid = "bake";
  const sceneAsset: IndexedAsset = { rootId: "project", path: "assets/Scene.babasset", header: {
    ...bake.header, guid: "scene", name: "Scene", type: "Scene", chunks: [],
    dependencies: assetHeaderDependencies("Scene", scene as unknown as Record<string, unknown>) } };
  const sources = ["model", "cube"].map((guid): IndexedAsset => ({ ...bake, path: `assets/${guid}.babasset`,
    header: { ...bake.header, guid, type: "Binary", name: guid, dependencies: [],
      chunks: [{ ...bake.header.chunks[1]!, id: "source", kind: "source" }] } }));
  const assets = [sceneAsset, bake, ...sources];
  const readAssetChunk = async (path: string, id: string) => path === bake.path ? decoded.chunks.get(id) ?? null
    : id === "source" ? new Uint8Array([1, 2, 3]) : null;
  return { scene, bake, assets, bytes, readAssetChunk };
}

it("retains Scene references, all atlas chunks and source dependencies through packed export and reopen", async () => {
  const { scene, bake, assets, bytes, readAssetChunk } = await fixture();
  const payload = scene as unknown as Record<string, unknown>;
  expect(assetHeaderDependencies("Scene", payload)).toEqual(["bake"]);
  expect(assetReferencesIncludingOpenDocuments("bake", assets, [{ ref: { path: "assets/Scene.babasset" }, content: payload }]).inbound).toEqual(["scene"]);
  const loaded = await loadExportDocuments({ assets, loadDocument: async () => scene, readAssetChunk });
  const result = await collectAndExportGame({
    startupSceneGuid: "scene", assets: assetsFromIndexed(assets), plugins: [], projectPluginOverrides: {},
    parentOf: () => null, ...loaded, customResolution: DEFAULT_RENDER_PROJECT_SETTINGS, playFrameCap: 60,
    physicsWorld: "3d", previewBuild: true,
    playerFiles: new Map([["index.html", new TextEncoder().encode("<html></html>")], ["player.js", new TextEncoder().encode("void 0")]]),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  expect(result.value.manifest.assets.map((asset) => asset.guid).sort()).toEqual(["bake", "cube", "model", "scene"]);
  const entry = result.value.manifest.assets.find((asset) => asset.guid === bake.header.guid)!;
  const pack = decodeBabpack(result.value.files.get(entry.pack)!);
  const restored = await decodeBakedLightingAsset(pack.read("bake"));
  expect(restored.manifest.dependencies).toEqual(["model", "cube"]);
  expect([...restored.atlases.keys()]).toEqual(["atlas", "second-atlas"]);
  for (const atlas of restored.atlases.values()) expect(atlas).toEqual(bytes);
  const sceneEntry = result.value.manifest.assets.find((asset) => asset.guid === "scene")!;
  const scenePack = decodeBabpack(result.value.files.get(sceneEntry.pack)!);
  expect(normalizeScene(JSON.parse(new TextDecoder().decode(scenePack.read("scene")))).settings.bakedLightingAssetGuid).toBe("bake");
  scene.settings.bakedLightingAssetGuid = null;
  expect(assetHeaderDependencies("Scene", payload)).not.toContain("bake");
});

it("fails export explicitly if any assigned bake atlas is missing instead of packing a partial output", async () => {
  const { scene, assets, readAssetChunk } = await fixture();
  const loaded = await loadExportDocuments({ assets, loadDocument: async () => scene,
    readAssetChunk: (path, id) => id === "atlas:second" ? Promise.resolve(null) : readAssetChunk(path, id) });
  expect(() => loaded.bytesByGuid("bake")).toThrow("Missing baked lighting chunk atlas:second");
  scene.settings.bakedLightingAssetGuid = null;
  assets[0]!.header.dependencies = [];
  const unrelated = await collectAndExportGame({ startupSceneGuid: "scene", assets: assetsFromIndexed(assets),
    plugins: [], projectPluginOverrides: {}, parentOf: () => null, ...loaded,
    customResolution: DEFAULT_RENDER_PROJECT_SETTINGS, playFrameCap: 60, physicsWorld: "3d", previewBuild: true,
    playerFiles: new Map([["index.html", new TextEncoder().encode("<html></html>")], ["player.js", new TextEncoder().encode("void 0")]]) });
  expect(unrelated.ok).toBe(true);
  if (unrelated.ok) expect(unrelated.value.manifest.assets.map((asset) => asset.guid)).toEqual(["scene"]);
});
