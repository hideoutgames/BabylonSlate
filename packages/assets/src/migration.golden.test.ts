import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readGoldenBinary } from "@babylonslate/test-kit";
import { readBabassetHeader } from "./babasset";
import { decodeAssetDocument, encodeAssetDocument } from "./asset-document";
import { loadPayloadWithMigration } from "./migrate-on-load";
import { createDefaultMigrationRegistry } from "./migration";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

describe("historical migration goldens", () => {
  it("migrates Graph v0 golden payload to current", () => {
    const registry = createDefaultMigrationRegistry();
    // Frozen pre-nodes/edges file: never regenerate it with the current writer.
    const golden = readGoldenBinary(FIXTURE_DIR, "__fixtures__/graph-v0.babasset");
    const header = readBabassetHeader(golden);
    expect(header.version).toBe(0);
    expect(header.payload).toEqual({});
    expect(header.dependencyMetadataVersion).toBeUndefined();

    const loaded = loadPayloadWithMigration(registry, {
      type: "Graph",
      version: header.version,
      payload: header.payload,
      path: "assets/legacy.graph.babasset",
    });
    expect(loaded.pending).not.toBeNull();
    expect(loaded.version).toBe(1);
    expect(loaded.payload.nodes).toEqual([]);
    expect(loaded.payload.edges).toEqual([]);
  });

  it("migrates a Scene v0 document golden to current", async () => {
    const registry = createDefaultMigrationRegistry();
    // Frozen v0 document chunk without modern dependency or chunk-length fields.
    const golden = readGoldenBinary(FIXTURE_DIR, "__fixtures__/scene-v0.babasset");
    const header = readBabassetHeader(golden);
    expect(header.dependencyMetadataVersion).toBeUndefined();
    expect(header.chunks[0]!.byteLength).toBeUndefined();

    const decoded = await decodeAssetDocument(golden);
    expect(decoded.version).toBe(0);
    expect(decoded.payload).toEqual({ name: "Legacy" });

    const loaded = loadPayloadWithMigration(registry, {
      type: decoded.type,
      version: decoded.version,
      payload: decoded.payload,
      path: "assets/legacy.scene.babasset",
    });
    expect(loaded.pending).toEqual({
      type: "Scene",
      fromVersion: 0,
      toVersion: 4,
      path: "assets/legacy.scene.babasset",
    });
    expect(loaded.payload.name).toBe("Legacy");
    expect(loaded.payload.actors).toEqual([]);
    expect(loaded.payload.viewportMode).toBe("3d");
    expect(loaded.payload.meshes).toBeUndefined();
  });

  it("migrates a Scene v1 mesh list into actors with mesh components", () => {
    const registry = createDefaultMigrationRegistry();
    const loaded = loadPayloadWithMigration(registry, {
      type: "Scene",
      version: 1,
      payload: {
        name: "Legacy",
        meshes: [{ id: "cube", type: "box", position: [1, 2, 3] }],
      },
      path: "assets/legacy.scene.babasset",
    });

    expect(loaded.version).toBe(4);
    expect(loaded.payload.actors).toEqual([
      {
        id: "cube",
        name: "cube",
        classId: "Actor",
        parentId: null,
        transform: {
          position: [1, 2, 3],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        visible: true,
        locked: false,
        components: [
          {
            id: "cube-mesh",
            classId: "MeshComponent",
            properties: { meshKind: "box", assetGuid: null },
          },
        ],
      },
    ]);
  });

  it("refuses a golden written by a newer engine", async () => {
    const registry = createDefaultMigrationRegistry();
    const future = await encodeAssetDocument({
      type: "Scene",
      name: "Future",
      guid: "00000000-0000-4000-8000-0000000000c0",
      version: 99,
      payload: {},
    });
    const decoded = await decodeAssetDocument(future);
    expect(() =>
      loadPayloadWithMigration(registry, {
        type: decoded.type,
        version: decoded.version,
        payload: decoded.payload,
        path: "assets/future.scene.babasset",
      }),
    ).toThrow(/newer engine version/);
  });

  it("does not silently mark current assets as pending migration", () => {
    const registry = createDefaultMigrationRegistry();
    const loaded = loadPayloadWithMigration(registry, {
      type: "Graph",
      version: 1,
      payload: { nodes: [], edges: [] },
      path: "x",
    });
    expect(loaded.pending).toBeNull();
  });
});
