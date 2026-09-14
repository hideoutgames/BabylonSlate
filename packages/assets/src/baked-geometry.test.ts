import { expect, it, vi } from "vitest";
import type { BakedGeometryManifest } from "@babylonslate/core";
import { bakeGeometryFixture } from "@babylonslate/test-kit/baked-geometry-fixtures";
import { createBakedLightingFixture } from "@babylonslate/test-kit/baked-lighting-fixtures";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { fingerprintBakeGeometry, remapBakeGeometry } from "./bake-geometry";
import {
  applyBakedGeometry,
  bakedGeometryImportResult,
  decodeBakedGeometryAsset,
  encodeBakedGeometryAsset,
  encodeBakeTopology,
  readBakedGeometryAssetChunks,
} from "./baked-geometry";
import { sha256Hex } from "./bytes";
import { decodeBabasset } from "./babasset";
import { importBabasset } from "./importers/babasset";
import { AssetRegistry } from "./registry";
import { projectContentRoot } from "./content-root";
import { loadBakedGeometryBindings } from "./baked-geometry-store";
import {
  loadBakedLightingReference,
  publishBakedLighting,
} from "./baked-lighting-store";

async function fixture() {
  const { source, topology } = bakeGeometryFixture();
  const manifest: BakedGeometryManifest = {
    version: 1,
    sceneGuid: "scene",
    receiver: {
      actorId: "receiver",
      componentId: "mesh",
      primitive: { kind: "mesh" },
    },
    sourceHash: await fingerprintBakeGeometry(source),
    sourceVertexCount: 4,
    indexCount: 6,
    vertexCount: 6,
    contentHash: await sha256Hex(encodeBakeTopology(topology, 4)),
    provider: { id: "fixture", version: "1", adapterVersion: "1" },
    layout: {
      width: 32,
      height: 32,
      paddingTexels: 2,
      uvSet: 1,
      coordinates: "normalized-bottom-first",
      mipLevels: 1,
    },
  };
  const result = await bakedGeometryImportResult({
    guid: "geometry",
    name: "Generated UV",
    manifest,
    topology,
  });
  return { source, topology, manifest, result };
}

it("duplicates all exact vertex bytes across seams without mutating the shared original", async () => {
  const { source, topology } = bakeGeometryFixture();
  const before = structuredClone(source);
  const remapped = remapBakeGeometry(source, topology);
  expect(remapped.vertexCount).toBe(6);
  expect([
    ...remapped.attributes.find((attribute) => attribute.name === "color")!
      .data,
  ]).toEqual([
    1, 2, 3, 255, 7, 8, 9, 255, 4, 5, 6, 255, 1, 2, 3, 255, 10, 11, 12, 255, 7,
    8, 9, 255,
  ]);
  expect([
    ...remapped.attributes.find((attribute) => attribute.name === "custom")!
      .data,
  ]).toEqual([255, 255, 255, 127, 0, 128, 255, 255, 17, 0, 255, 127]);
  expect(
    remapped.attributes.find((attribute) => attribute.name === "color"),
  ).toMatchObject({ componentType: "u8", normalized: true });
  expect(source).toEqual(before);
  topology.indices[0] = 2;
  expect(() => remapBakeGeometry(source, topology)).toThrow(
    /triangle order or winding/,
  );
});

it("roundtrips a bounded generated asset and rejects stale original attributes before applying it", async () => {
  const { result, source, topology } = await fixture();
  const bytes = await encodeBakedGeometryAsset(result);
  const decoded = await decodeBakedGeometryAsset(bytes);
  expect(decoded.topology).toEqual(topology);
  const first = await applyBakedGeometry(source, decoded);
  const second = await applyBakedGeometry(source, decoded);
  first.attributes[0]!.data[0] = 255;
  expect(second.attributes[0]!.data[0]).toBe(0);
  source.attributes[1]!.data[0] = 99;
  await expect(applyBakedGeometry(source, decoded)).rejects.toThrow(
    /source is stale/,
  );
  const imported = await importBabasset(bytes, {
    fileName: "Generated.babasset",
    existingGuids: new Set(["geometry"]),
  });
  expect(imported[0]!.guid).not.toBe("geometry");
  expect(
    (
      await decodeBakedGeometryAsset(
        await encodeBakedGeometryAsset(imported[0]!),
      )
    ).topology,
  ).toEqual(topology);
});

it("rejects oversized declarations and invalid remaps without fetching topology payloads", async () => {
  const { result } = await fixture();
  const decoded = await decodeBabasset(await encodeBakedGeometryAsset(result));
  const read = vi.fn(async (entry: { id: string }) =>
    decoded.chunks.get(entry.id)!,
  );
  const bad = structuredClone(decoded.header);
  bad.chunks[1]!.locator = { inline: { offset: 0, length: 128 * 1024 * 1024 } };
  await expect(readBakedGeometryAssetChunks(bad, read)).rejects.toThrow(
    /Oversized/,
  );
  expect(read).not.toHaveBeenCalled();
  const invalid = bakeGeometryFixture();
  invalid.topology.originalVertices[2] = 4;
  expect(() => encodeBakeTopology(invalid.topology, 4)).toThrow(
    /range or length/,
  );
  invalid.topology.originalVertices[2] = 1;
  invalid.topology.uv2[0] = NaN;
  expect(() => encodeBakeTopology(invalid.topology, 4)).toThrow(
    /range or length/,
  );
});

it("persists per-receiver topology through reopen and retains the last bake when geometry is missing or belongs to another receiver", async () => {
  const { result, manifest } = await fixture();
  const lighting = await createBakedLightingFixture();
  lighting.manifest.dependencies = ["geometry"];
  lighting.manifest.sources = [];
  const receiver = lighting.manifest.receivers[0]!;
  receiver.identity = manifest.receiver;
  receiver.hashes.geometry = manifest.sourceHash;
  receiver.contributions = [];
  receiver.generatedGeometry = {
    assetGuid: "geometry",
    contentHash: manifest.contentHash,
  };
  const storage = new MemoryStorageAdapter();
  await storage.pickProjectFolder("Generated UV Test");
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  await registry.createAsset("project", "Generated.babasset", result);
  let reference: string | null = null;
  const publication = await publishBakedLighting({
    ...lighting,
    registry,
    rootId: "project",
    name: "Bake",
    current: () => ({
      sceneGuid: "scene",
      generation: 1,
      inputs: lighting.manifest.inputs,
    }),
    commit: (guid) => {
      reference = guid;
      return true;
    },
  });
  expect(publication.status).toBe("published");
  const reopened = new AssetRegistry(storage);
  await reopened.mountRoot(projectContentRoot());
  const options = {
    registry: reopened,
    guid: reference,
    sceneGuid: "scene",
    inputs: lighting.manifest.inputs,
  };
  expect((await loadBakedLightingReference(options)).validity.status).toBe(
    "valid",
  );
  receiver.identity = { ...receiver.identity, componentId: "replacement" };
  await expect(
    loadBakedGeometryBindings(reopened, lighting.manifest),
  ).rejects.toThrow(/identity or source is stale/);
  await storage.remove(reopened.getByGuid("geometry")!.path);
  const missing = await loadBakedLightingReference(options);
  expect(missing.validity.status).toBe("missing");
  expect(missing.referenceGuid).toBe(reference);
  expect(missing.retained?.atlases.size).toBe(1);
});
