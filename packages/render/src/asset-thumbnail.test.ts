import { ArcRotateCamera, Color3, InputBlock, Mesh, NodeMaterial, RenderTargetTexture, type Scene } from "@babylonjs/core";
import { normalizeModelPayload } from "@babylonslate/assets";
import { createActor, createDefaultScene, createMeshComponent, identitySerializedTransform } from "@babylonslate/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAssetThumbnailPng } from "./asset-thumbnail";
import { createTestEngine as createNullTestEngine } from "./create-null-engine";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";

/** Thumbnails draw through the FrameGraph into a color/depth target. */
function createTestEngine() {
  const handle = createNullTestEngine();
  adaptNullEngineFrameGraph(handle.engine);
  return handle;
}
import { encodeTriangleGlb } from "./glb-test-fixtures";
import { MATERIAL_PREVIEW_MESH_NAME } from "./material-preview";
import { encodeRgbaPng, PNG_SIGNATURE } from "./png-encode";
import { acquireMaterialTexture, releaseResourceCacheForEngine, resourceCacheForEngine } from "./resource-cache";
import { nativePreparationForEngine } from "./native-preparation";
import { SCENE_CAPTURE_CEILING_MS, SCENE_SHADER_WARM_TIMEOUT_MS } from "./stall-deadline";
import type { ThumbnailCaptureResult } from "./thumbnail-capture";
import { installVirtualClock, POLL_MS } from "./virtual-clock-test-fixtures";

/** How long loading and readback may take before a capture expires. */
const CAPTURE_BOUND_MS = 30_000;

/** The PNG of a capture that produced one. */
const pngOf = (result: ThumbnailCaptureResult) => result.outcome === "captured" ? result.png : undefined;

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
    const png = pngOf(await captureAssetThumbnailPng(engine, {
      kind: "Material", materialGuid: "paint", materials: new Map([["paint", document]]),
    }, undefined, 32));
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
    const png = pngOf(await capture);
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
    const png = pngOf(await captureAssetThumbnailPng(engine, {
      kind: "Material", materialGuid: "paint", materials: new Map([["paint", document]]),
      assets: { textureBytes: new Map([["albedo", bytes]]) },
    }));
    expect(png).toBeDefined();
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
    expect(await capture).toEqual({ outcome: "cancelled" });
    expect(capturedScene?.isDisposed).toBe(true);
    expect(engine.scenes).toEqual([scene]);
  });

  // Without KHR_parallel_shader_compile (SwiftShader, WebKit WebGL2) one readiness probe links every
  // effect before it returns, and a cold runner held the thread for 13 to 15 s.
  describe("while the thread is held", () => {
    const material = { kind: "Material", materialGuid: "paint", materials: new Map([["paint", createDefaultMaterialDocument()]]) } as const;

    /**
     * The thumbnail sphere's readiness probe while the capture waits for its meshes,
     * before it creates its frame target: `held(probe)` virtual time per call, unready
     * until `ready(probe)`. Later probes (the renderer's own) take no part.
     */
    function probeSphere(held: (probe: number) => number, ready: (probe: number) => boolean) {
      let probes = 0;
      const isReady = Mesh.prototype.isReady;
      vi.spyOn(Mesh.prototype, "isReady").mockImplementation(function (this: Mesh, ...args) {
        const result = isReady.apply(this, args);
        const waiting = this.name === MATERIAL_PREVIEW_MESH_NAME &&
          !this.getScene().textures.some((texture) => texture.name === "assetThumbnail");
        if (!waiting) return result;
        probes += 1;
        clock.advance(held(probes));
        return result && ready(probes);
      });
    }
    let clock: ReturnType<typeof installVirtualClock>;

    afterEach(() => { vi.useRealTimers(); });

    it("captures a mesh whose readiness probe outlasts the shader warm bound", async () => {
      const { engine } = fixture();
      clock = installVirtualClock();
      probeSphere((probe) => probe === 1 ? 15_000 : POLL_MS, (probe) => probe > 1);
      vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockResolvedValue(new Uint8Array(32 * 32 * 4));
      const png = pngOf(await captureAssetThumbnailPng(engine, material, undefined, 32));
      expect(png?.subarray(0, 8)).toEqual(PNG_SIGNATURE);
      expect(clock.elapsed()).toBeGreaterThan(SCENE_SHADER_WARM_TIMEOUT_MS);
    });

    it("gives up on a mesh that never becomes ready at the shader warm bound and keeps its icon", async () => {
      const { engine } = fixture();
      clock = installVirtualClock();
      probeSphere(() => POLL_MS, () => false);
      const read = vi.spyOn(RenderTargetTexture.prototype, "readPixels");
      expect(await captureAssetThumbnailPng(engine, material, undefined, 32)).toEqual({ outcome: "expired" });
      expect(clock.elapsed()).toBeGreaterThanOrEqual(SCENE_SHADER_WARM_TIMEOUT_MS);
      expect(clock.elapsed()).toBeLessThanOrEqual(SCENE_SHADER_WARM_TIMEOUT_MS + POLL_MS);
      expect(read).not.toHaveBeenCalled();
    });

    // Captures queue one after another on the shared Engine, where other work (material editing, Play) compiles too.
    it("ends a capture at its ceiling while unrelated shaders keep finishing on the Engine", async () => {
      const { engine } = fixture();
      clock = installVirtualClock();
      const effects = (engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects;
      probeSphere((probe) => {
        effects[`elsewhere-${probe}`] = { isReady: () => true, getCompilationError: () => "" };
        return POLL_MS;
      }, () => false);
      expect(await captureAssetThumbnailPng(engine, material, undefined, 32)).toEqual({ outcome: "expired" });
      expect(clock.elapsed()).toBeGreaterThanOrEqual(SCENE_CAPTURE_CEILING_MS);
      expect(clock.elapsed()).toBeLessThanOrEqual(SCENE_CAPTURE_CEILING_MS + POLL_MS);
    });

    // A retry of a capture that ran out passes a longer ceiling.
    it("ends a capture at the ceiling it was given instead", { timeout: 20_000 }, async () => {
      const { engine } = fixture();
      clock = installVirtualClock();
      const effects = (engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects;
      probeSphere((probe) => {
        effects[`elsewhere-${probe}`] = { isReady: () => true, getCompilationError: () => "" };
        return POLL_MS;
      }, () => false);
      const ceiling = 1.5 * SCENE_CAPTURE_CEILING_MS;
      expect(await captureAssetThumbnailPng(engine, material, undefined, 32, ceiling)).toEqual({ outcome: "expired" });
      expect(clock.elapsed()).toBeGreaterThanOrEqual(ceiling);
      expect(clock.elapsed()).toBeLessThanOrEqual(ceiling + POLL_MS);
    });

    /** A readback that never returns until `release`; `onPoll` runs at each of the capture's 16 ms expiry checks. */
    function stalledReadback(onPoll: (release: () => void) => void) {
      let polling = false;
      let release!: () => void;
      vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockImplementation(() => {
        polling = true;
        return new Promise((resolve) => { release = () => resolve(new Uint8Array(32 * 32 * 4)); });
      });
      return () => { if (polling) onPoll(release); return true; };
    }

    /** A readback that a synchronous call holds past the capture bound before it returns. */
    function readbackHeldPastBound() {
      let polls = 0;
      return stalledReadback((release) => {
        polls += 1;
        if (polls === 1) clock.advance(CAPTURE_BOUND_MS + 10_000);
        else release();
      });
    }

    it("lets a readback finish after a synchronous call held the thread past the capture bound", async () => {
      const { engine } = fixture();
      clock = installVirtualClock();
      const png = pngOf(await captureAssetThumbnailPng(engine, material, readbackHeldPastBound(), 32));
      expect(png?.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    });

    // The waits of one capture run one after another, so a capture that never becomes ready would otherwise
    // hold the serialized thumbnail queue for a full budget at every step.
    it("spends one budget across the capture's waits", async () => {
      const { engine } = fixture();
      clock = installVirtualClock();
      // The mesh wait spends the whole 60 s of credit (six 10 s holds) and then succeeds...
      probeSphere((probe) => probe <= 6 ? 10_000 : POLL_MS, (probe) => probe > 6);
      // ...so the same readback that finishes above now has nothing left to be credited from.
      expect(await captureAssetThumbnailPng(engine, material, readbackHeldPastBound(), 32)).toEqual({ outcome: "expired" });
      // The capture got as far as its readback before it gave up.
      expect(RenderTargetTexture.prototype.readPixels).toHaveBeenCalledOnce();
    });

    it("expires a readback that never returns at the capture bound", async () => {
      const { engine } = fixture();
      clock = installVirtualClock();
      const shouldContinue = stalledReadback(() => { clock.advance(POLL_MS); });
      expect(await captureAssetThumbnailPng(engine, material, shouldContinue, 32)).toEqual({ outcome: "expired" });
      expect(clock.elapsed()).toBeGreaterThanOrEqual(CAPTURE_BOUND_MS);
      // The probe counts every question to `shouldContinue` as a poll, and the capture asks once more why it ended.
      expect(clock.elapsed()).toBeLessThanOrEqual(CAPTURE_BOUND_MS + 2 * POLL_MS);
    });
  });

  it("keeps unavailable materials and empty prefabs on their fallback icons", async () => {
    const { engine, scene } = fixture();
    const read = vi.spyOn(RenderTargetTexture.prototype, "readPixels");
    // Nothing a later attempt would change, unlike a capture that ran out of time.
    expect(await captureAssetThumbnailPng(engine, {
      kind: "Material", materialGuid: "missing", materials: new Map(),
    })).toEqual({ outcome: "failed" });
    expect(await captureAssetThumbnailPng(engine, {
      kind: "ActorPrefab", prefab: { ...createDefaultScene(), actors: [] }, materials: new Map(),
    })).toEqual({ outcome: "failed" });
    expect(read).not.toHaveBeenCalled();
    expect(engine.scenes).toEqual([scene]);
  });
});
