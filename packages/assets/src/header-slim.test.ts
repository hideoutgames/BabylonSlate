import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { decodeAssetDocument } from "./asset-document";
import { projectContentRoot } from "./content-root";
import { normalizeModelPayload } from "./model-payload";
import { AssetRegistry } from "./registry";

const CABIN = fileURLToPath(new URL("../../../engine-content/kenney-assets/Holiday Pack/cabin-corner.glb", import.meta.url));
const headerBytes = (payload: unknown) => new TextEncoder().encode(JSON.stringify(payload)).byteLength;

describe("slim .hasset headers", () => {
  it("keeps an imported Model's collision hulls and its Materials' graphs out of the scanned header", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Headers.hproject");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    const imported = await registry.importFile("project", "", "cabin-corner.glb", new Uint8Array(readFileSync(CABIN)));

    const model = imported.find((asset) => asset.header.type === "Model")!;
    const stored = normalizeModelPayload((await decodeAssetDocument(await storage.readBinary(model.path))).payload);
    expect(stored.simpleColliders.length).toBeGreaterThan(0);
    expect(model.header.payload).not.toHaveProperty("simpleColliders");
    expect(model.header.payload.simpleColliderCount).toBe(stored.simpleColliders.length);
    expect(model.header.payload.materialSlots).toEqual(stored.materialSlots);
    expect(headerBytes(model.header.payload)).toBeLessThan(headerBytes(stored));
    expect(headerBytes(model.header.payload)).toBeLessThan(2048);

    const materials = imported.filter((asset) => asset.header.type === "Material");
    expect(materials.length).toBeGreaterThan(0);
    for (const material of materials) {
      expect(material.header.payload).toEqual({ domain: "surface" });
      const graph = (await decodeAssetDocument(await storage.readBinary(material.path))).payload;
      expect(Array.isArray(graph.nodes)).toBe(true);
    }
  });
});
