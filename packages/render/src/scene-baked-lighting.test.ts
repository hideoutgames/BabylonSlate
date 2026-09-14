import { afterEach, expect, it, vi } from "vitest";
import { Geometry, Mesh, Scene, VertexBuffer } from "@babylonjs/core";
import { bakeGeometryFixture } from "@babylonslate/test-kit/baked-geometry-fixtures";
import { createBakedLightingFixture } from "@babylonslate/test-kit/baked-lighting-fixtures";
import {
  bakedGeometryImportResult,
  bakedLightingImportResult,
  encodeBakedGeometryAsset,
  encodeBakedLightingAsset,
  encodeBakeTopology,
  fingerprintBakeGeometry,
  sha256Hex,
} from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { SceneBakedLighting } from "./scene-baked-lighting";
import {
  bakedGpuAllocationStatus,
  reserveBakedGpuBytes,
} from "./baked-lighting-resources";

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (cleanup.length) cleanup.pop()!();
});

async function fixture() {
  const { engine, scene } = createTestEngine();
  engine.getCaps().textureFloat = true;
  engine.getCaps().textureFloatLinearFiltering = true;
  // Pinned NullEngine omits the upload completion flag set by both real backends.
  // Keep its actual InternalTexture allocation, type and lifetime behavior.
  const createRawTexture = engine.createRawTexture.bind(engine);
  vi.spyOn(engine, "createRawTexture").mockImplementation((...args) => {
    const texture = createRawTexture(...args);
    texture.isReady = true;
    return texture;
  });
  const { source, topology } = bakeGeometryFixture();
  const sourceHash = await fingerprintBakeGeometry(source);
  const { manifest, atlases } = await createBakedLightingFixture(2, 2);
  const receiver = manifest.receivers[0]!;
  receiver.identity = {
    actorId: "receiver",
    componentId: "mesh",
    primitive: { kind: "mesh" },
  };
  receiver.hashes.geometry = sourceHash;
  manifest.inputs.geometry = sourceHash;
  const contentHash = await sha256Hex(encodeBakeTopology(topology, 4));
  receiver.generatedGeometry = { assetGuid: "geometry", contentHash };
  manifest.dependencies.push("geometry");
  const geometryBytes = await encodeBakedGeometryAsset(
    await bakedGeometryImportResult({
      guid: "geometry",
      name: "Geometry",
      topology,
      manifest: {
        version: 1,
        sceneGuid: "scene",
        receiver: receiver.identity,
        sourceHash,
        sourceVertexCount: 4,
        indexCount: 6,
        vertexCount: 6,
        contentHash,
        provider: { id: "fixture", version: "1", adapterVersion: "1" },
        layout: {
          width: 32,
          height: 32,
          paddingTexels: 2,
          uvSet: 1,
          coordinates: "normalized-bottom-first",
          mipLevels: 1,
        },
      },
    }),
  );
  const bakeBytes = await encodeBakedLightingAsset(
    await bakedLightingImportResult({
      guid: "bake",
      name: "Bake",
      manifest,
      atlases,
    }),
  );
  const payloads = new Map([
    ["bake", bakeBytes],
    ["geometry", geometryBytes],
  ]);
  const meshIn = (target: Scene) => {
    const mesh = new Mesh("Authored receiver", target);
    const geometry = new Geometry("Authored geometry", target);
    for (const attribute of source.attributes)
      geometry.setVerticesBuffer(
        new VertexBuffer(engine, attribute.data.slice(), attribute.name, {
          stride: attribute.data.byteLength / source.vertexCount,
          size: attribute.components,
          useBytes: true,
          type:
            attribute.componentType === "f32"
              ? VertexBuffer.FLOAT
              : attribute.componentType === "i16"
                ? VertexBuffer.SHORT
                : VertexBuffer.UNSIGNED_BYTE,
          normalized: attribute.normalized,
        }),
        4,
      );
    geometry.setIndices(source.indices.slice(), 4);
    geometry.applyToMesh(mesh);
    return mesh;
  };
  const mesh = meshIn(scene);
  cleanup.push(() => {
    scene.dispose();
    engine.dispose();
  });
  const optionsFor = (mesh: Mesh) => ({
    sceneGuid: "scene",
    assetGuid: "bake",
    inputs: manifest.inputs,
    receivers: [{ mesh, identity: receiver.identity, hashes: receiver.hashes }],
    readAsset: async (guid: string) => {
      const bytes = payloads.get(guid);
      return bytes && { bytes };
    },
    isCurrent: () => true,
  });
  return { engine, scene, mesh, meshIn, optionsFor, payloads };
}

it("owns seam geometry per receiver, preserving shared source attributes and restoring after sibling disposal", async () => {
  const f = await fixture();
  const original = f.mesh.geometry!;
  const sibling = f.mesh.clone("Unbaked sibling")!;
  const owner = new SceneBakedLighting(f.scene);
  expect(await owner.load(f.optionsFor(f.mesh))).toBe(true);
  expect(owner.isReady()).toBe(true);
  expect(f.mesh.getTotalVertices()).toBe(6);
  expect([
    ...(f.mesh.getVertexBuffer("color")!.getData() as Uint8Array),
  ]).toEqual([
    1, 2, 3, 255, 7, 8, 9, 255, 4, 5, 6, 255, 1, 2, 3, 255, 10, 11, 12, 255, 7,
    8, 9, 255,
  ]);
  expect(f.mesh.getVertexBuffer("color")!.normalized).toBe(true);
  expect(f.mesh.getVertexBuffer("custom")!.type).toBe(VertexBuffer.SHORT);
  expect(f.mesh.getVerticesData("uv2")![0]).toBeCloseTo(0.1);
  expect(sibling.geometry).toBe(original);
  expect(original.getTotalVertices()).toBe(4);
  const binding = owner.bindingFor(f.mesh)!;
  expect(binding.texture.gammaSpace).toBe(false);
  expect(binding.texture.getInternalTexture()!.generateMipMaps).toBe(false);
  expect(binding.receiver.contributions[0]).toEqual({
    sourceId: "sun",
    term: "directAndIndirect",
  });
  sibling.dispose();
  expect(original.isDisposed()).toBe(false);
  owner.invalidate();
  expect(f.mesh.geometry).toBe(original);
  expect(owner.bindingFor(f.mesh)).toBeUndefined();
  expect(owner.lastValidAssetGuid).toBe("bake");
  expect(bakedGpuAllocationStatus(f.engine)).toEqual({
    managedBytes: 0,
    quarantined: false,
  });
  owner.dispose();
});

it("shares only the immutable atlas across Scenes and releases it after the last owner", async () => {
  const f = await fixture();
  const other = new Scene(f.engine);
  const otherMesh = f.meshIn(other);
  const a = new SceneBakedLighting(f.scene),
    b = new SceneBakedLighting(other);
  await a.load(f.optionsFor(f.mesh));
  await b.load(f.optionsFor(otherMesh));
  const texture = a.bindingFor(f.mesh)!.texture;
  expect(b.bindingFor(otherMesh)!.texture).toBe(texture);
  expect(bakedGpuAllocationStatus(f.engine).managedBytes).toBe(424); // 64 atlas + 180 bytes for each remapped geometry.
  const later = vi.fn();
  f.scene.onDisposeObservable.add(later);
  f.scene.dispose();
  expect(later).toHaveBeenCalledOnce();
  expect(b.isReady()).toBe(true);
  expect(texture.isReady()).toBe(true);
  expect(bakedGpuAllocationStatus(f.engine).managedBytes).toBe(244);
  other.dispose();
  expect(bakedGpuAllocationStatus(f.engine).managedBytes).toBe(0);
});

it("keeps a still-valid previous binding when the replacement peak exceeds admission", async () => {
  const f = await fixture();
  const owner = new SceneBakedLighting(f.scene, 300);
  await owner.load(f.optionsFor(f.mesh));
  const previous = f.mesh.geometry;
  await expect(owner.load(f.optionsFor(f.mesh))).rejects.toThrow(
    /allocation budget/,
  );
  expect(owner.isReady()).toBe(true);
  expect(f.mesh.geometry).toBe(previous);
  expect(bakedGpuAllocationStatus(f.engine)).toEqual({
    managedBytes: 244,
    quarantined: false,
  });
  expect(
    await owner.load({
      ...f.optionsFor(f.mesh),
      readAsset: async () => undefined,
    }),
  ).toBe(false);
  expect(owner.bindingFor(f.mesh)?.assetGuid).toBe("bake");
  expect(owner.isReady()).toBe(true);
  owner.dispose();
});

it("accounts unexpected native buffer capacity and keeps realtime geometry after admission fails", async () => {
  const f = await fixture();
  const original = f.mesh.geometry;
  // Model a backend allocation boundary returning more capacity than requested.
  // Actual wrapper ownership/disposal remains Babylon's.
  const create = f.engine.createVertexBuffer.bind(f.engine);
  const allocate = vi
    .spyOn(f.engine, "createVertexBuffer")
    .mockImplementation((...args) => {
      const buffer = create(...args);
      buffer.capacity = 512;
      return buffer;
    });
  const owner = new SceneBakedLighting(f.scene, 300);
  await expect(owner.load(f.optionsFor(f.mesh))).rejects.toThrow(
    /native buffers exceeded/,
  );
  expect(f.mesh.geometry).toBe(original);
  expect(owner.bindingFor(f.mesh)).toBeUndefined();
  expect(bakedGpuAllocationStatus(f.engine).quarantined).toBe(true);
  expect(
    bakedGpuAllocationStatus(f.engine).managedBytes,
  ).toBeGreaterThanOrEqual(2048);
  const allocations = allocate.mock.calls.length;
  await expect(owner.load(f.optionsFor(f.mesh))).rejects.toThrow(/quarantined/);
  expect(allocate).toHaveBeenCalledTimes(allocations);
  owner.dispose();
});

it("retains WebGPU charges when disposal occurs inside the current end-frame notification", async () => {
  const { engine, scene } = createTestEngine();
  cleanup.push(() => {
    scene.dispose();
    engine.dispose();
  });
  // Only backend identity is substituted for this observer-boundary regression;
  // the browser proof exercises actual native deferred destruction.
  vi.spyOn(engine, "isWebGPU", "get").mockReturnValue(true);
  const lease = reserveBakedGpuBytes(engine, 100);
  engine.onEndFrameObservable.addOnce(() => lease.release());
  engine.endFrame();
  expect(bakedGpuAllocationStatus(engine).managedBytes).toBe(100);
  await Promise.resolve();
  expect(bakedGpuAllocationStatus(engine).managedBytes).toBe(100);
  const laterOwner = vi.fn();
  engine.onEndFrameObservable.add(laterOwner);
  engine.endFrame();
  expect(bakedGpuAllocationStatus(engine).managedBytes).toBe(0);
  expect(laterOwner).toHaveBeenCalledOnce();
});

it("discards uploads when a receiver moves and restores realtime geometry on later invalidation", async () => {
  const f = await fixture();
  const owner = new SceneBakedLighting(f.scene);
  const original = f.mesh.geometry;
  const options = f.optionsFor(f.mesh);
  await expect(
    owner.load({
      ...options,
      readAsset: async (guid) => {
        const value = await options.readAsset(guid);
        if (guid === "geometry") f.mesh.position.x = 1;
        return value;
      },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(f.mesh.geometry).toBe(original);
  expect(bakedGpuAllocationStatus(f.engine).managedBytes).toBe(0);
  f.mesh.position.x = 0;
  await owner.load(options);
  f.mesh.position.z = 2;
  expect(owner.bindingFor(f.mesh)).toBeUndefined();
  expect(f.mesh.geometry).toBe(original);
  expect(owner.validity.status).toBe("stale");
  owner.dispose();
});

it("blocks readiness for pending IO and never applies a cancelled owner after late completion", async () => {
  const f = await fixture();
  const owner = new SceneBakedLighting(f.scene);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const options = f.optionsFor(f.mesh);
  const loading = owner.load({
    ...options,
    readAsset: async (guid) => {
      began();
      await wait;
      return options.readAsset(guid);
    },
  });
  await started;
  expect(owner.isReady()).toBe(false);
  owner.dispose();
  await expect(loading).rejects.toMatchObject({ name: "AbortError" });
  expect(f.mesh.getTotalVertices()).toBe(4);
  expect(bakedGpuAllocationStatus(f.engine).managedBytes).toBe(0);
  release();
});

it("rejects unsupported float filtering before allocation and quarantines hidden constructor failures", async () => {
  const f = await fixture();
  const owner = new SceneBakedLighting(f.scene);
  f.engine.getCaps().textureFloatLinearFiltering = false;
  const create = vi.spyOn(f.engine, "createRawTexture");
  await expect(owner.load(f.optionsFor(f.mesh))).rejects.toThrow(
    /cannot sample/,
  );
  expect(create).not.toHaveBeenCalled();
  f.engine.getCaps().textureFloatLinearFiltering = true;
  create.mockImplementation(() => {
    throw new Error("Native allocation failed");
  });
  await expect(owner.load(f.optionsFor(f.mesh))).rejects.toThrow(
    /Native allocation/,
  );
  expect(bakedGpuAllocationStatus(f.engine)).toEqual({
    managedBytes: 64,
    quarantined: true,
  });
  await expect(owner.load(f.optionsFor(f.mesh))).rejects.toThrow(/quarantined/);
  expect(create).toHaveBeenCalledOnce();
  expect(f.mesh.getTotalVertices()).toBe(4);
  owner.dispose();
});
