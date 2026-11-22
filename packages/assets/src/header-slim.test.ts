import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { normalizeAnimationPayload } from "./animation-payload";
import { ROOT_MOTION_STEP_MS } from "./animation-root-motion";
import { decodeAssetDocument } from "./asset-document";
import { projectContentRoot } from "./content-root";
import { normalizeModelPayload } from "./model-payload";
import { AssetRegistry } from "./registry";
import { buildMinimalGlbFixture } from "./test-support/glb-fixtures";

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

  it("keeps an Animation's root motion track in its document and only its bone in the scanned header", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("Headers.hproject");
    const registry = new AssetRegistry(storage);
    await registry.mountRoot(projectContentRoot());
    // A 20 s clip sampled at 30 Hz: 601 samples of travel and turn.
    const samples = Array.from({ length: 601 }, (_, index) => index);
    const payload = normalizeAnimationPayload({
      clipName: "Walk_Long", modelGuid: "model", skeletonGuid: "rig", durationMs: 20000, clipDurationMs: 20000,
      rootMotion: {
        bone: "hips",
        track: {
          durationMs: 20000, stepMs: ROOT_MOTION_STEP_MS,
          x: samples.map((index) => index * 0.0013), z: samples.map((index) => index * 0.0471), yaw: samples.map((index) => index * 0.03),
        },
      },
    });
    const animation = await registry.createAsset("project", "Walk_Long.hasset", {
      type: "Animation", name: "Walk_Long", guid: "walk-long", version: 1, dependencies: ["model", "rig"], payload, chunks: [],
    });

    expect(animation.header.payload).toEqual({
      clipName: "Walk_Long", modelGuid: "model", skeletonGuid: "rig", sourceAnimationGuid: null,
      durationMs: 20000, clipDurationMs: 20000, rootMotionBone: "hips",
    });
    expect(headerBytes(animation.header.payload)).toBeLessThan(256);
    expect(headerBytes(payload)).toBeGreaterThan(10_000);
    expect((await decodeAssetDocument(await storage.readBinary(animation.path))).payload).toEqual(payload);

    // An imported clip has no root motion: its document holds the payload, which its header repeats.
    const imported = await registry.importFile("project", "", "clip.glb", buildMinimalGlbFixture({ animationName: "Wave" }));
    const clip = imported.find((asset) => asset.header.type === "Animation")!;
    expect(clip.header.chunks.map((chunk) => chunk.id)).toContain("document");
    expect((await decodeAssetDocument(await storage.readBinary(clip.path))).payload).toEqual(clip.header.payload);
  });
});
