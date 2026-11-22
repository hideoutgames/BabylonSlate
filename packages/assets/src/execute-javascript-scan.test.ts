import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { encodeAssetDocument } from "./asset-document";
import { createVfsBlobStore } from "./blob-store";
import { projectContentRoot } from "./content-root";
import { encodeHasset } from "./hasset";
import { decodeProjectZip, encodeProjectZip } from "./hproject";
import {
  executeJavaScriptInImportFile,
  executeJavaScriptInPlugin,
  UnconfirmedExecuteJavaScriptError,
} from "./execute-javascript-scan";
import { exportPluginZip, inspectHplugin } from "./plugin-package";
import { writeProjectPlugin } from "./plugin-host";
import { createDefaultPluginSettings } from "./plugin-settings";
import { AssetRegistry } from "./registry";

/** A Class whose event graph runs `body` on Begin Play; `padding` pushes its document past the blob threshold. */
function classBytes(guid: string, name: string, body: string, options: { padding?: number; blobs?: ReturnType<typeof createVfsBlobStore> } = {}) {
  return encodeAssetDocument({
    type: "Class", name, guid, version: 1,
    payload: {
      nodes: [
        { id: "begin", type: "flow.event.beginPlay", position: { x: 0, y: 0 }, data: {} },
        { id: "js", type: "debug.executeJavaScript", position: { x: 200, y: 0 }, data: { body, inputs: [], outputs: [] } },
      ],
      edges: [{ id: "e", source: "begin", target: "js", sourceHandle: "execOut", targetHandle: "execIn" }],
      ...(options.padding ? { note: "x".repeat(options.padding) } : {}),
    },
  }, { parentClass: "Actor", blobs: options.blobs });
}

function textureBytes(guid: string) {
  return encodeHasset({
    header: { dependencyMetadataVersion: 1, requiredDependencies: [], guid, type: "Texture", name: guid, engineVersion: "0.0.0", version: 1, mode: "thin", dependencies: [], payload: {} },
    chunks: [{ id: "pixels", kind: "pixels", mime: "image/png", data: new Uint8Array([1, 2, 3]) }],
  });
}

/** Every file and folder under the project, so a test sees anything an import wrote. */
async function tree(storage: MemoryStorageAdapter, path = ""): Promise<string[]> {
  const entries = await storage.readdir(path).catch(() => []);
  const paths: string[] = [];
  for (const entry of entries) {
    const child = path ? `${path}/${entry.name}` : entry.name;
    paths.push(child, ...(entry.isDir ? await tree(storage, child) : []));
  }
  return paths.sort();
}

async function project() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Trust.hproject");
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  return { storage, registry };
}

describe("executeJavaScriptInImportFile", () => {
  it("reads a bundled .hasset's nested assets, and nothing but .hasset files", async () => {
    const hero = await classBytes("hero", "Hero", "ctx.log('hi')");
    const quiet = await classBytes("quiet", "Quiet", "  ");
    const bundle = await encodeHasset({
      header: { dependencyMetadataVersion: 1, requiredDependencies: [], guid: "pack", type: "Texture", name: "Pack", engineVersion: "0.0.0", version: 1, mode: "bundled", dependencies: [], payload: {} },
      chunks: [],
      nestedAssets: [{ guid: "hero", bytes: hero }, { guid: "quiet", bytes: quiet }],
    });
    const found = await executeJavaScriptInImportFile("Pack.HASSET", bundle, "Props/Pack.HASSET");
    expect(found).toEqual([{ guid: "hero", name: "Hero", type: "Class", path: "Props/Pack.HASSET", nodes: [{ nodeId: "js", body: "ctx.log('hi')" }] }]);
    expect(await executeJavaScriptInImportFile("Texture.hasset", await textureBytes("t"))).toEqual([]);
    // Any other extension goes to an importer that makes no graphs, whatever the bytes are.
    expect(await executeJavaScriptInImportFile("Hero.png", hero)).toEqual([]);
  });
});

describe("AssetRegistry.importFile", () => {
  it("writes nothing for unconfirmed Execute JavaScript and imports it once confirmed", async () => {
    const { storage, registry } = await project();
    const bytes = await classBytes("hero", "Hero", "fetch('https://example.invalid')");
    const before = await tree(storage);
    const refused = registry.importFile("project", "", "Hero.hasset", bytes);
    await expect(refused).rejects.toBeInstanceOf(UnconfirmedExecuteJavaScriptError);
    await expect(refused).rejects.toThrow("It contains Execute JavaScript (Hero)");
    expect(await tree(storage)).toEqual(before);
    expect(registry.list()).toEqual([]);

    const created = await registry.importFile("project", "", "Hero.hasset", bytes, { allowExecuteJavaScript: true });
    expect(created.map((asset) => asset.header.name)).toEqual(["Hero"]);
  });

  it("needs no confirmation for a file without Execute JavaScript", async () => {
    const { registry } = await project();
    const created = await registry.importFile("project", "", "Quiet.hasset", await classBytes("quiet", "Quiet", "\n"));
    expect(created.map((asset) => asset.header.name)).toEqual(["Quiet"]);
  });
});

describe("executeJavaScriptInPlugin", () => {
  async function pluginZip(): Promise<Uint8Array> {
    const { storage } = await project();
    const descriptor = await writeProjectPlugin(storage, "pack", createDefaultPluginSettings({ pluginGuid: "pack-guid", displayName: "Pack" }));
    const blobs = createVfsBlobStore(storage, "plugins/pack/assets/.blobs");
    // Past the blob threshold, so the document chunk is a blob beside the file, as an exported plugin stores it.
    await storage.writeBinary("plugins/pack/assets/Hero.class.hasset", await classBytes("hero", "Hero", "ctx.log('hi')", { padding: 70_000, blobs }));
    await storage.writeBinary("plugins/pack/assets/Plain.hasset", await textureBytes("plain"));
    return exportPluginZip(storage, descriptor);
  }

  it("reads each asset's document through the plugin's blobs", async () => {
    const found = await executeJavaScriptInPlugin(await inspectHplugin(await pluginZip()));
    expect(found.map(({ name, path, nodes }) => ({ name, path, count: nodes.length })))
      .toEqual([{ name: "Hero", path: "assets/Hero.class.hasset", count: 1 }]);
  });

  it("refuses a plugin whose document it cannot read rather than install it unchecked", async () => {
    const files = decodeProjectZip(await pluginZip()).filter((file) => !file.path.includes(".blobs/"));
    const zip = encodeProjectZip(files);
    await expect(executeJavaScriptInPlugin(await inspectHplugin(zip))).rejects.toThrow("assets/Hero.class.hasset could not be read");
  });
});
