import { expect, it, vi } from "vitest";
import { createDefaultScene, normalizeScene } from "@babylonslate/core";
import { createBakedLightingFixture } from "@babylonslate/test-kit/baked-lighting-fixtures";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { decodeAssetDocument, encodeAssetDocument } from "./asset-document";
import { projectContentRoot } from "./content-root";
import {
  loadBakedLightingReference,
  publishBakedLighting,
} from "./baked-lighting-store";
import { AssetRegistry } from "./registry";

async function setup() {
  const fixture = await createBakedLightingFixture(64, 64);
  const storage = new MemoryStorageAdapter();
  await storage.pickProjectFolder("Bake Test");
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  for (const [guid, type] of [
    ["model", "Model"],
    ["cube", "Texture"],
  ]) {
    await registry.createAsset("project", `${guid}.babasset`, {
      guid: guid!,
      type: type!,
      name: guid!,
      version: 1,
      dependencies: [],
      payload: {},
      chunks: [],
    });
  }
  let owner = {
    sceneGuid: "scene",
    generation: 1,
    inputs: fixture.manifest.inputs,
  };
  const scene = createDefaultScene();
  const commit = vi.fn((guid: string) => {
    scene.settings.bakedLightingAssetGuid = guid;
    return true;
  });
  const options = {
    registry,
    rootId: "project",
    name: "Bake",
    ...fixture,
    current: () => owner,
    commit,
  };
  const published = await publishBakedLighting(options);
  if (published.status !== "published")
    throw new Error("Fixture publication was refused");
  return {
    ...fixture,
    storage,
    registry,
    scene,
    options,
    published,
    commit,
    replaceOwner: (next: typeof owner) => {
      owner = next;
    },
  };
}

it("reopens a persisted Scene and its external atlas blobs, retaining valid and stale output separately", async () => {
  const { storage, registry, scene, manifest, bytes, published } =
    await setup();
  const asset = registry.getByGuid(published.guid)!;
  expect(
    asset.header.chunks.find((chunk) => chunk.id === "atlas:atlas")?.locator,
  ).toHaveProperty("blob");
  const encoded = await encodeAssetDocument(
    {
      type: "Scene",
      guid: "scene",
      name: "Scene",
      version: 4,
      payload: scene as unknown as Record<string, unknown>,
    },
    { dependencies: [published.guid] },
  );
  await storage.writeBinary("assets/Scene.babasset", encoded);
  const reopened = new AssetRegistry(storage);
  await reopened.mountRoot(projectContentRoot());
  const document = await decodeAssetDocument(
    await storage.readBinary("assets/Scene.babasset"),
  );
  const restored = normalizeScene(document.payload);
  expect(restored.settings.bakedLightingAssetGuid).toBe(published.guid);
  const options = {
    registry: reopened,
    guid: restored.settings.bakedLightingAssetGuid,
    sceneGuid: "scene",
    inputs: manifest.inputs,
  };
  const loaded = await loadBakedLightingReference(options);
  expect(loaded.validity.status).toBe("valid");
  expect(loaded.retained?.atlases.get("atlas")).toEqual(bytes);
  const stale = await loadBakedLightingReference({
    ...options,
    inputs: { ...manifest.inputs, uv: "f".repeat(64) },
  });
  expect(stale.validity).toEqual({ status: "stale", reasons: ["uv changed"] });
  expect(stale.referenceGuid).toBe(published.guid);
  expect(stale.retained?.atlases.get("atlas")).toEqual(bytes);
  await storage.remove(asset.path);
  const missing = await loadBakedLightingReference(options);
  expect(missing.validity.status).toBe("missing");
  expect(missing.referenceGuid).toBe(published.guid);
});

it.each(["generation", "hash", "abort", "refuse", "write failure"] as const)(
  "preserves the last usable Scene reference when a replacement encounters %s during storage",
  async (failure) => {
    const {
      storage,
      registry,
      scene,
      options,
      published,
      commit,
      replaceOwner,
    } = await setup();
    let release!: () => void;
    let writing!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      writing = resolve;
    });
    const original = storage.writeBinary.bind(storage);
    const write = vi
      .spyOn(storage, "writeBinary")
      .mockImplementation(async (path, data) => {
        if (path.endsWith(".babasset")) {
          writing();
          await held;
          if (failure === "write failure") throw new Error("Disk full");
        }
        await original(path, data);
      });
    const abort = new AbortController();
    const pending = publishBakedLighting({ ...options, signal: abort.signal });
    const outcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await started;
    if (failure === "generation")
      replaceOwner({ ...options.current(), generation: 2 });
    if (failure === "hash")
      replaceOwner({
        ...options.current(),
        inputs: { ...options.current().inputs, lights: "f".repeat(64) },
      });
    if (failure === "abort") abort.abort();
    if (failure === "refuse") commit.mockImplementationOnce(() => false);
    release();
    const result = await outcome;
    write.mockRestore();
    expect(scene.settings.bakedLightingAssetGuid).toBe(published.guid);
    expect(registry.getByGuid(published.guid)).toBeDefined();
    if (failure === "write failure") {
      expect(result).toHaveProperty(
        "error",
        expect.objectContaining({ message: "Disk full" }),
      );
    } else {
      expect(result).toHaveProperty(
        "value",
        expect.objectContaining({
          status: "refused",
          reason:
            failure === "refuse"
              ? "not-accepted"
              : failure === "abort"
                ? "aborted"
                : "stale",
        }),
      );
      // An already written immutable candidate is retained, without replacing the old one.
      expect(registry.list({ type: "BakedLighting" })).toHaveLength(2);
    }
    expect(commit).toHaveBeenCalledTimes(failure === "refuse" ? 2 : 1);
  },
);

it("does not write pre-cancelled or already stale candidates, and reports missing input dependencies on reopen", async () => {
  const { registry, options, published } = await setup();
  const abort = new AbortController();
  abort.abort();
  expect(
    await publishBakedLighting({ ...options, signal: abort.signal }),
  ).toEqual({ status: "refused", reason: "aborted", candidateGuid: null });
  expect(
    await publishBakedLighting({
      ...options,
      current: () => ({ ...options.current(), sceneGuid: "copy" }),
    }),
  ).toEqual({ status: "refused", reason: "stale", candidateGuid: null });
  expect(registry.list({ type: "BakedLighting" })).toHaveLength(1);
  await registry.deleteAsset("cube");
  const loaded = await loadBakedLightingReference({
    registry,
    guid: published.guid,
    sceneGuid: "scene",
    inputs: options.manifest.inputs,
  });
  expect(loaded.validity).toEqual({
    status: "missing",
    reason: "Baked lighting input asset cube is unavailable.",
  });
  expect(loaded.referenceGuid).toBe(published.guid);
  expect(loaded.retained).not.toBeNull();
});
