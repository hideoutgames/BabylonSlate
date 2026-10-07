import { describe, expect, it, vi } from "vitest";
import { createDefaultScene, type SerializedGraph } from "@babylonslate/core";
import { AssetRegistry, collectAssetDependencyMetadata, createRegistryAssetLoadingService, encodeBabasset, type ImportResult, type IndexedAsset, type RegistryLoadedAsset } from "@babylonslate/assets";
import { migrateLegacyShaderPayload } from "@babylonslate/shader-graph";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  applyKenneyMannequinEmptyScaffold,
  MANNEQUIN_ACTOR_ID,
  MANNEQUIN_CLASS_ID,
} from "./scaffold-empty-3d";

function indexed(
  type: string,
  guid: string,
  payload: Record<string, unknown>,
): IndexedAsset {
  return {
    rootId: "project",
    path: `Mannequin/${guid}.babasset`,
    header: {
      guid,
      type,
      name: type,
      payload,
    },
  } as IndexedAsset;
}

describe("applyKenneyMannequinEmptyScaffold", () => {
  it("adds the Mannequin capsule and prepares its authored lit material dependencies", async () => {
    const created = [
      // The importer preserves unsupported source material features; the
      // template subsequently replaces that slot with its authored lit graph.
      indexed("Model", "model-1", {
        materialSlots: [{ index: 0, name: "texture-d", materialGuid: null }],
        skeletonGuid: "skel-1",
      }),
      indexed("Skeleton", "skel-1", {
        kind: "hierarchy",
        modelGuid: "model-1",
        boneNames: ["root"],
      }),
      indexed("Animation", "idle-1", {
        clipName: "idle",
        modelGuid: "model-1",
        durationMs: 1000,
      }),
      indexed("Material", "material-1", migrateLegacyShaderPayload(
        { shadingModel: "unlit" }, { textureGuids: ["texture-1"] },
      ) as unknown as Record<string, unknown>),
      indexed("Texture", "texture-1", { width: 1, height: 1 }),
    ];
    const createAsset = vi.fn(
      async (_root: string, _path: string, result: ImportResult) => result,
    );
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("scaffold.babproject");
    for (const asset of created) {
      await storage.writeBinary(asset.path, await encodeBabasset({
        header: {
          ...asset.header,
          version: 1, engineVersion: "test", mode: "thin",
          ...collectAssetDependencyMetadata(asset.header.type, asset.header.payload, {
            dependencies: asset.header.type === "Model" ? ["material-1", "idle-1", "skel-1"] : [],
          }),
        },
        chunks: [],
      }));
    }
    const registry = {
      importFile: vi.fn(async () => created),
      createAsset,
      storageFor: () => storage,
      blobsFor: () => ({}),
      reindexPath: vi.fn(),
    };

    const scene = await applyKenneyMannequinEmptyScaffold({
      registry: registry as never,
      scene: createDefaultScene(),
      mannequinBytes: new Uint8Array([1, 2, 3]),
      modelImportScale: 10,
    });
    expect(registry.importFile).toHaveBeenCalledWith(
      "project",
      "Mannequin",
      "mannequin.glb",
      expect.any(Uint8Array),
      { modelImportScale: 10 },
    );

    const actor = scene.actors.find((entry) => entry.id === MANNEQUIN_ACTOR_ID);
    expect(actor?.classId).toBe(MANNEQUIN_CLASS_ID);
    const actorBody = actor?.components.find(
      (component) => component.classId === "RigidBodyComponent",
    );
    const actorCollider = actor?.components.find(
      (component) => component.classId === "ColliderComponent",
    );
    expect(actorBody?.properties.motionType).toBe("kinematic");
    expect(actorCollider?.properties.shape).toEqual(
      expect.objectContaining({ kind: "capsule", radius: 0.5, halfHeight: 1 }),
    );
    const actorY = actorCollider?.transform?.position[1];
    expect(actorY).toBe(1.5);

    const classCall = createAsset.mock.calls.find(([, path]) =>
      String(path).includes("Mannequin.class"),
    );
    expect(classCall).toBeDefined();
    const graph = classCall![2]!.payload as unknown as SerializedGraph;
    const classBody = graph.components?.find(
      (component) => component.classId === "RigidBodyComponent",
    );
    const classCollider = graph.components?.find(
      (component) => component.classId === "ColliderComponent",
    );
    expect(classBody?.properties.motionType).toBe("kinematic");
    expect(classCollider?.properties.shape).toEqual(
      expect.objectContaining({ kind: "capsule" }),
    );
    expect(classCollider?.transform?.position[1]).toBe(actorY);

    const catalog = new AssetRegistry(storage);
    await catalog.mountRoot({ id: "project", kind: "project", pathPrefix: "" });
    const loading = createRegistryAssetLoadingService(catalog, { projectId: "scaffold" });
    const scope = loading.createScope("Mannequin actor");
    try {
      const model = await scope.acquire<RegistryLoadedAsset>("model-1");
      expect(model.document.payload.materialSlots).toEqual([
        { index: 0, name: "texture-d", materialGuid: "material-1" },
      ]);
      expect(loading.getLoadState("material-1")).toBe("ready");
      expect(loading.getLoadState("texture-1")).toBe("ready");
      expect((await catalog.readAssetDocument("material-1")).payload.shadingModel).toBe("pbr");
      // Included animation sources remain deferred when preparing only a model.
      expect(loading.getLoadState("idle-1")).toBe("unloaded");
    } finally {
      scope.dispose();
      loading.dispose();
    }
  });
});
