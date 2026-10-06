import { ArcRotateCamera, Color3, InputBlock, NodeMaterial, RenderTargetTexture, type Scene } from "@babylonjs/core";
import { normalizeModelPayload } from "@babylonslate/assets";
import { createActor, createDefaultScene, createMeshComponent, identitySerializedTransform } from "@babylonslate/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAssetThumbnailPng } from "./asset-thumbnail";
import { createTestEngine } from "./create-null-engine";
import { encodeTriangleGlb } from "./glb-test-fixtures";
import { MATERIAL_PREVIEW_MESH_NAME } from "./material-preview";
import { encodeRgbaPng, PNG_SIGNATURE } from "./png-encode";
import { acquireMaterialTexture, releaseResourceCacheForEngine, resourceCacheForEngine } from "./resource-cache";
import { nativePreparationForEngine } from "./native-preparation";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { scene, engine } of handles.splice(0)) {
    scene.dispose();
    releaseResourceCacheForEngine(engine);
    engine.dispose();
  }
});

function fixture() {
  const handle = createTestEngine();
  handles.push(handle);
  return handle;
}

describe("asset thumbnail capture", () => {
  it("renders the authored Material on a sphere and retires its temporary scene", async () => {
    const { engine, scene } = fixture();
    const document = createDefaultMaterialDocument();
    document.nodes[0]!.properties.value = [0.15, 0.45, 0.8];
    // The document's cube preference must not replace the Content Browser sphere.
    document.preview.mesh = "cube";
    let captured: { vertices: number; colors: number[][]; alpha: number; target: unknown } | undefined;
    const read = vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockImplementation(function (this: RenderTargetTexture) {
      const preview = this.getScene()!;
      const sphere = preview.getMeshByName(MATERIAL_PREVIEW_MESH_NAME)!;
      const material = sphere.material as NodeMaterial;
      captured = {
        vertices: sphere.getTotalVertices(),
        colors: material.attachedBlocks.flatMap((block) => block instanceof InputBlock && block.value instanceof Color3 ? [block.value.asArray()] : []),
        alpha: preview.clearColor.a,
        target: preview.activeCamera!.outputRenderTarget,
      };
      return Promise.resolve(new Uint8Array(32 * 32 * 4));
    });
    const png = await captureAssetThumbnailPng(engine, {
      kind: "Material", materialGuid: "paint", materials: new Map([["paint", document]]),
    }, undefined, 32);
    expect(png?.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(new DataView(png!.buffer, png!.byteOffset).getUint32(16)).toBe(32);
    expect(captured?.vertices).toBeGreaterThan(100);
    expect(captured?.colors).toContainEqual([0.15, 0.45, 0.8]);
    expect(captured?.alpha).toBe(0);
    expect(captured?.target).toBeInstanceOf(RenderTargetTexture);
    expect(read).toHaveBeenCalledOnce();
    expect(engine.scenes).toEqual([scene]);
    expect(scene.meshes).toHaveLength(0);
  });

  it("captures parented prefab models with slot materials and frames only visible authored geometry", async () => {
    const { engine, scene } = fixture();
    const scheduler = nativePreparationForEngine(engine, { maxConcurrent: 1 });
    let unblock!: () => void;
    const blocker = scheduler.schedule({ label: "Active Gameplay", temporaryBytes: 1 }, () => new Promise<void>((resolve) => { unblock = resolve; }));
    const order: string[] = [];
    // NullEngine retains raw bytes but never marks uploads ready. Model the
    // missing GPU completion for the default checker, retaining real material
    // readiness and compilation (as in create-engine.play.test.ts).
    const upload = engine.createRawTexture.bind(engine);
    vi.spyOn(engine, "createRawTexture").mockImplementation((...args) => {
      const texture = upload(...args);
      texture.isReady = true;
      return texture;
    });
    const material = createDefaultMaterialDocument();
    const model = createMeshComponent("mesh", "box");
    model.properties.assetGuid = "triangle";
    const prefab = {
      ...createDefaultScene(),
      actors: [
        createActor("marker", "Prefab Root", { components: [createMeshComponent("pivot", "pivot")] }),
        createActor("parent", "Parent", {
          transform: { ...identitySerializedTransform(), position: [10, 0, 0] as [number, number, number] },
          components: [createMeshComponent("box", "box")],
        }),
        createActor("child", "Model", {
          parentId: "parent",
          transform: { ...identitySerializedTransform(), position: [3, 1, 0] as [number, number, number] },
          components: [model],
        }),
        createActor("hidden", "Hidden", { visible: false, components: [createMeshComponent("hidden", "sphere")] }),
        createActor("helper", "Audio", { components: [{ id: "audio", classId: "AudioComponent", properties: {} }] }),
      ],
    };
    let captured: { positions: number[][]; modelMaterial: string | undefined; target: number[]; radius: number; names: string[] } | undefined;
    vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockImplementation(function (this: RenderTargetTexture) {
      order.push("thumbnail");
      const preview = this.getScene()!;
      const meshes = preview.meshes.filter((mesh) => mesh.isVisible && mesh.visibility > 0 && mesh.getTotalVertices() > 0 && !mesh.isBlocked);
      const imported = meshes.find((mesh) => mesh.getTotalVertices() === 3)!;
      const camera = preview.activeCamera as ArcRotateCamera;
      captured = {
        positions: meshes.map((mesh) => mesh.getAbsolutePosition().asArray()),
        modelMaterial: imported.material?.name,
        target: camera.target.asArray(),
        radius: camera.radius,
        names: meshes.map((mesh) => mesh.name),
      };
      return Promise.resolve(new Uint8Array(128 * 128 * 4));
    });
    const capture = captureAssetThumbnailPng(engine, {
      kind: "ActorPrefab", prefab, materials: new Map([["paint", material]]),
      assets: {
        modelBytes: new Map([["triangle", encodeTriangleGlb()]]),
        modelPayloads: new Map([["triangle", normalizeModelPayload({
          importScale: 2,
          materialSlots: [{ index: 0, name: "surface", materialGuid: "paint" }],
        })]]),
      },
    });
    await vi.waitFor(() => expect(scheduler.snapshot().queued).toBe(1));
    const gameplay = scheduler.schedule({ label: "Next Actor", temporaryBytes: 1 }, async () => { order.push("gameplay"); });
    unblock();
    await Promise.all([blocker, gameplay]);
    const png = await capture;
    expect(order).toEqual(["gameplay", "thumbnail"]);
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, temporaryBytes: 0 });
    expect(png?.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(captured?.positions).toContainEqual([13, 1, 0]);
    expect(captured?.modelMaterial).toBe("material:paint");
    expect(captured?.names).toHaveLength(2);
    // Box spans x 9.25..10.75. The glTF left-handed conversion mirrors X,
    // so the triangle's scale 2 and translation 13 produce x 11..13.
    expect(captured?.target[0]).toBeCloseTo(11.125);
    expect(captured?.target[1]).toBeCloseTo(1.125);
    expect(captured?.radius).toBeLessThan(10);
    expect(engine.scenes).toEqual([scene]);
  });

  it("borrows existing engine textures and releases only the capture's leases", async () => {
    const { engine, scene } = fixture();
    const cache = resourceCacheForEngine(engine);
    const bytes = encodeRgbaPng(1, 1, new Uint8Array([128, 64, 32, 255]));
    const retained = acquireMaterialTexture(cache, "albedo", engine, bytes)!;
    await retained.ready;
    const document = createDefaultMaterialDocument();
    document.nodes.push(
      { id: "texture", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Albedo", textureGuid: "albedo" } },
      { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
      { id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: {} },
    );
    document.edges = [
      { id: "texture-sample", sourceNodeId: "texture", sourcePinId: "out", targetNodeId: "sample", targetPinId: "texture" },
      { id: "uv-sample", sourceNodeId: "uv", sourcePinId: "uv", targetNodeId: "sample", targetPinId: "uv" },
      { id: "sample-output", sourceNodeId: "sample", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" },
    ];
    let sampledExisting = false;
    vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockImplementation(function (this: RenderTargetTexture) {
      const material = this.getScene()!.getMeshByName(MATERIAL_PREVIEW_MESH_NAME)!.material!;
      sampledExisting = material.getActiveTextures().includes(retained.resource);
      return Promise.resolve(new Uint8Array(128 * 128 * 4));
    });
    const png = await captureAssetThumbnailPng(engine, {
      kind: "Material", materialGuid: "paint", materials: new Map([["paint", document]]),
      assets: { textureBytes: new Map([["albedo", bytes]]) },
    });
    expect(png).not.toBeNull();
    expect(sampledExisting).toBe(true);
    expect(cache.resourceStats().leases).toBe(1);
    expect(retained.resource.isReady()).toBe(true);
    expect(engine.scenes).toEqual([scene]);
    retained.release();
  });

  it("discards a superseded readback and releases the temporary scene", async () => {
    const { engine, scene } = fixture();
    let release!: (pixels: Uint8Array) => void;
    let capturedScene: Scene | undefined;
    let active = true;
    const read = vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockImplementation(function (this: RenderTargetTexture) {
      capturedScene = this.getScene()!;
      return new Promise((resolve) => { release = resolve; });
    });
    const capture = captureAssetThumbnailPng(engine, {
      kind: "Material", materialGuid: "paint", materials: new Map([["paint", createDefaultMaterialDocument()]]),
    }, () => active);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    active = false;
    release(new Uint8Array(128 * 128 * 4));
    expect(await capture).toBeNull();
    expect(capturedScene?.isDisposed).toBe(true);
    expect(engine.scenes).toEqual([scene]);
  });

  it("keeps unavailable materials and empty prefabs on their fallback icons", async () => {
    const { engine, scene } = fixture();
    const read = vi.spyOn(RenderTargetTexture.prototype, "readPixels");
    expect(await captureAssetThumbnailPng(engine, {
      kind: "Material", materialGuid: "missing", materials: new Map(),
    })).toBeNull();
    expect(await captureAssetThumbnailPng(engine, {
      kind: "ActorPrefab", prefab: { ...createDefaultScene(), actors: [] }, materials: new Map(),
    })).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(engine.scenes).toEqual([scene]);
  });
});
