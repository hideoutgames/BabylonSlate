import { expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { encodeBabasset, readBabassetHeader } from "./babasset";
import { AssetRegistry } from "./registry";
import { projectContentRoot } from "./content-root";
import { assetsNeedingDependencyMetadataUpgrade, upgradeAssetDependencyMetadata } from "./dependency-metadata-upgrade";

it("upgrades only when requested, preserves inline data and never fetches an unrelated source blob", async () => {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("Upgrade");
  await storage.mkdir("assets", true);
  const document = new TextEncoder().encode(JSON.stringify({ materialSlots: [{ index: 0, name: "Body", materialGuid: "material" }] }));
  const original = await encodeBabasset({
    header: { guid: "model", name: "Model", type: "Model", version: 1, engineVersion: "0", mode: "thin", dependencies: [], payload: {} },
    chunks: [
      { id: "document", kind: "document", mime: "application/json", data: document },
      { id: "source", kind: "model", mime: "model/gltf-binary", data: new Uint8Array(1024) },
    ],
    blobThreshold: 512,
    writeBlob: async () => {}, // Missing source demonstrates that maintenance never fetches it.
  });
  await storage.writeBinary("assets/model.babasset", original);
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  expect(assetsNeedingDependencyMetadataUpgrade(registry.list()).map(asset => asset.header.guid)).toEqual(["model"]);
  expect(await storage.readBinary("assets/model.babasset")).toEqual(original);
  expect(await upgradeAssetDependencyMetadata(registry)).toEqual({ upgraded: ["model"], readOnly: [] });
  const updated = await storage.readBinary("assets/model.babasset");
  const header = readBabassetHeader(updated);
  expect(header.requiredDependencies).toEqual(["material"]);
  expect(header.dependencies).toEqual(["material"]);
  expect(header.chunks).toEqual(readBabassetHeader(original).chunks);
  expect(await registry.readChunk("model", "document")).toEqual(document);
  expect(await upgradeAssetDependencyMetadata(registry)).toEqual({ upgraded: [], readOnly: [] });
});
