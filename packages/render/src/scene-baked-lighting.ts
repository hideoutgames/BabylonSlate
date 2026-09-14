import {
  Geometry,
  Mesh,
  VertexBuffer,
  type Scene,
  type RawTexture,
  type Matrix,
} from "@babylonjs/core";
import type {
  BakeGeometrySource,
  BakeInputHashes,
  BakedReceiverBinding,
  BakedReceiverIdentity,
  BakedLightingValidity,
} from "@babylonslate/core";
import {
  applyBakedGeometry,
  bakedReceiverKey,
  fingerprintBakeGeometry,
  loadRuntimeBake,
  type BakeRuntimeAssetReader,
  type LoadedRuntimeBake,
} from "@babylonslate/assets";
import { snapshotBakeMesh } from "./bake-mesh-snapshot";
import {
  acquireBakedAtlas,
  beginBakedUpload,
  reserveBakedGpuBytes,
} from "./baked-lighting-resources";

export interface BakedRuntimeReceiver {
  identity: BakedReceiverIdentity;
  mesh: Mesh;
  hashes: BakedReceiverBinding["hashes"];
}
export interface RuntimeIrradianceBinding {
  /** Shared immutable sampling resource. Scene/material owners must not mutate it. */
  readonly texture: RawTexture;
  readonly receiver: Readonly<BakedReceiverBinding>;
  readonly assetGuid: string;
}
type ValidBake = Extract<LoadedRuntimeBake, { lighting: unknown }>;
interface Candidate {
  mesh: Mesh;
  expected: Geometry;
  original: Geometry;
  originalMaterialIndex: number;
  world: Matrix;
  geometry?: Geometry;
  holder?: Mesh;
  releaseGeometry?: () => void;
  atlas: Awaited<ReturnType<typeof acquireBakedAtlas>>;
  binding: RuntimeIrradianceBinding;
}
const formats = {
  i8: VertexBuffer.BYTE,
  u8: VertexBuffer.UNSIGNED_BYTE,
  i16: VertexBuffer.SHORT,
  u16: VertexBuffer.UNSIGNED_SHORT,
  u32: VertexBuffer.UNSIGNED_INT,
  f32: VertexBuffer.FLOAT,
};

function sameSource(a: BakeGeometrySource, b: BakeGeometrySource) {
  if (
    a.vertexCount !== b.vertexCount ||
    a.indices.length !== b.indices.length ||
    a.indices.some((index, offset) => index !== b.indices[offset]) ||
    a.attributes.length !== b.attributes.length
  )
    return false;
  return a.attributes.every((attribute) => {
    const other = b.attributes.find((value) => value.name === attribute.name);
    return (
      other &&
      attribute.componentType === other.componentType &&
      attribute.components === other.components &&
      attribute.normalized === other.normalized &&
      attribute.data.byteLength === other.data.byteLength &&
      attribute.data.every((byte, offset) => byte === other.data[offset])
    );
  });
}

function hiddenMesh(scene: Scene, name: string) {
  const mesh = new Mesh(name, scene);
  mesh.setEnabled(false);
  mesh.isVisible = false;
  mesh.isPickable = false;
  mesh.doNotSerialize = true;
  return mesh;
}

async function prepareGeometry(
  scene: Scene,
  source: BakeGeometrySource,
  ceiling?: number,
) {
  const engine = scene.getEngine();
  // Pinned WebGPUBufferManager aligns every separate native buffer, not their sum.
  const capacity = (bytes: number) =>
    engine.isWebGPU ? Math.ceil(bytes / 4) * 4 : bytes;
  const bytes =
    capacity(source.indices.byteLength) +
    source.attributes.reduce(
      (total, attribute) => total + capacity(attribute.data.byteLength),
      0,
    );
  const reservation = reserveBakedGpuBytes(engine, bytes, ceiling);
  let geometry: Geometry | undefined;
  let staging: Mesh | undefined;
  let nativeAllocationStarted = false;
  try {
    geometry = new Geometry("Baked receiver geometry", scene);
    for (const attribute of source.attributes) {
      const buffer = new VertexBuffer(engine, attribute.data, attribute.name, {
        updatable: false,
        postponeInternalCreation: true,
        stride: attribute.data.byteLength / source.vertexCount,
        size: attribute.components,
        type: formats[attribute.componentType],
        normalized: attribute.normalized,
        useBytes: true,
      });
      geometry.setVerticesBuffer(buffer, source.vertexCount);
    }
    geometry.setIndices(source.indices, source.vertexCount, false);
    staging = hiddenMesh(scene, "Baked geometry upload");
    const complete = beginBakedUpload(engine);
    let failed: unknown;
    try {
      nativeAllocationStarted = true;
      geometry.applyToMesh(staging);
    } catch (error) {
      failed = error;
    }
    await complete();
    if (failed) throw failed;
    if (
      !geometry.isReady() ||
      !geometry.getIndexBuffer() ||
      Object.values(geometry.getVertexBuffers() ?? {}).some(
        (buffer) => !buffer.getBuffer(),
      )
    )
      throw new Error("Baked receiver buffers are not ready.");
    const buffers = new Set([
      geometry.getIndexBuffer()!,
      ...Object.values(geometry.getVertexBuffers() ?? {}).map((buffer) =>
        buffer.getBuffer()!,
      ),
    ]);
    reservation.reconcile(
      [...buffers].reduce((total, buffer) => total + buffer.capacity, 0),
    );
    geometry.releaseForMesh(staging);
    staging.dispose();
    staging = undefined;
    const owned = geometry;
    let released = false;
    return {
      geometry,
      release() {
        if (released) return;
        released = true;
        try {
          owned.dispose();
          reservation.release();
        } catch (error) {
          reservation.quarantine();
          throw error;
        }
      },
    };
  } catch (error) {
    try {
      staging?.dispose();
      geometry?.dispose();
    } catch (cleanup) {
      reservation.quarantine();
      throw new AggregateError(
        [error, cleanup],
        "Baked geometry cleanup failed.",
      );
    }
    // Babylon may throw before assigning a just-created buffer to its wrapper.
    if (nativeAllocationStarted) reservation.quarantine();
    else reservation.release();
    throw error;
  }
}

/** Receiver-local data/geometry service. It never changes materials or realtime light admission. */
export class SceneBakedLighting {
  private epoch = 0;
  private disposed = false;
  private abort?: AbortController;
  private active: Candidate[] = [];
  private current?: () => boolean;
  private retained?: ValidBake;
  private state: BakedLightingValidity = {
    status: "missing",
    reason: "No baked lighting is bound.",
  };
  private readonly sceneObserver;
  private readonly contextObserver;
  private readonly scene: Scene;
  private readonly managedByteCeiling?: number;

  constructor(scene: Scene, managedByteCeiling?: number) {
    this.scene = scene;
    this.managedByteCeiling = managedByteCeiling;
    this.sceneObserver = scene.onDisposeObservable.add(() => this.dispose());
    this.contextObserver = scene
      .getEngine()
      .onContextLostObservable.add(() =>
        this.invalidate("The graphics context was lost."),
      );
  }

  get validity(): BakedLightingValidity {
    return structuredClone(this.state);
  }
  get lastValidAssetGuid(): string | undefined {
    return this.retained?.lighting.guid;
  }

  /** The caller's predicate covers authored document/source generation, including material/light changes. */
  async load(options: {
    assetGuid?: string;
    sceneGuid: string;
    inputs: BakeInputHashes;
    receivers: readonly BakedRuntimeReceiver[];
    readAsset: BakeRuntimeAssetReader;
    isCurrent(): boolean;
    signal?: AbortSignal;
  }): Promise<boolean> {
    if (this.disposed) throw new Error("The baked lighting owner is disposed.");
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const cancel = () => abort.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const epoch = ++this.epoch;
    const check = () => {
      abort.signal.throwIfAborted();
      if (
        this.disposed ||
        this.scene.isDisposed ||
        epoch !== this.epoch ||
        !options.isCurrent()
      )
        throw new DOMException(
          "The baked lighting owner changed.",
          "AbortError",
        );
    };
    const candidates: Candidate[] = [];
    try {
      check();
      if (this.current && !this.current()) this.releaseActive();
      if (options.receivers.length > 64)
        throw new Error("Too many runtime baked receivers.");
      let sourceBytes = 0;
      const targets = options.receivers.map((receiver) => {
        const active = this.active.find(
          (candidate) => candidate.mesh === receiver.mesh,
        );
        const sourceMesh = active?.holder ?? receiver.mesh;
        if (
          receiver.mesh.getScene() !== this.scene ||
          receiver.mesh.isDisposed() ||
          !receiver.mesh.geometry
        )
          throw new Error("A baked receiver is not owned by the target Scene.");
        const source = snapshotBakeMesh(sourceMesh);
        sourceBytes +=
          source.indices.byteLength +
          source.attributes.reduce(
            (bytes, attribute) => bytes + attribute.data.byteLength,
            0,
          );
        if (sourceBytes > 32 * 1024 * 1024)
          throw new Error(
            "Runtime baked receiver sources exceed their aggregate byte limit.",
          );
        return {
          ...receiver,
          identity: structuredClone(receiver.identity),
          hashes: { ...receiver.hashes },
          expected: receiver.mesh.geometry,
          original: sourceMesh.geometry!,
          source,
          world: receiver.mesh.computeWorldMatrix(true).clone(),
          materialIndex: receiver.mesh.subMeshes[0].materialIndex,
        };
      });
      if (
        targets.length > 64 ||
        new Set(targets.map((target) => target.mesh)).size !== targets.length ||
        new Set(targets.map((target) => bakedReceiverKey(target.identity)))
          .size !== targets.length
      )
        throw new Error(
          "Baked runtime receivers must be unique and within the 64 receiver limit.",
        );
      const loaded = await loadRuntimeBake({
        ...options,
        signal: abort.signal,
      });
      check();
      if (!("lighting" in loaded)) {
        if (!this.current?.()) this.releaseActive();
        if (!this.active.length) this.state = loaded.validity;
        return false;
      }
      if (loaded.lighting.manifest.receivers.length !== targets.length)
        throw new Error(
          "The runtime does not own every receiver required by this bake.",
        );
      for (const receiver of loaded.lighting.manifest.receivers) {
        check();
        const key = bakedReceiverKey(receiver.identity);
        const target = targets.find(
          (value) => bakedReceiverKey(value.identity) === key,
        );
        if (
          !target ||
          Object.keys(receiver.hashes).some(
            (key) =>
              receiver.hashes[key as keyof typeof receiver.hashes] !==
              target.hashes[key as keyof typeof receiver.hashes],
          )
        )
          throw new Error(
            "A baked receiver's authored identity or source hashes changed.",
          );
        if (
          (await fingerprintBakeGeometry(target.source)) !==
          receiver.hashes.geometry
        )
          throw new Error(
            "A baked receiver's realized source geometry is stale.",
          );
        const generated = loaded.geometries.get(key);
        const source = generated
          ? await applyBakedGeometry(target.source, generated)
          : target.source;
        if (
          !generated &&
          !source.attributes.some(
            (attribute) =>
              attribute.name === "uv2" &&
              attribute.components === 2 &&
              attribute.componentType === "f32",
          )
        )
          throw new Error(
            "The authored baked receiver has no supported UV2 channel.",
          );
        check();
        const atlasInfo = loaded.lighting.manifest.atlases.find(
          (atlas) => atlas.guid === receiver.atlasGuid,
        )!;
        const atlas = await acquireBakedAtlas(
          this.scene.getEngine(),
          atlasInfo,
          loaded.lighting.atlases.get(receiver.atlasGuid)!,
          this.managedByteCeiling,
        );
        const candidate: Candidate = {
          mesh: target.mesh,
          expected: target.expected,
          original: target.original,
          originalMaterialIndex: target.materialIndex,
          world: target.world,
          atlas,
          binding: Object.freeze({
            texture: atlas.texture,
            receiver: structuredClone(receiver),
            assetGuid: loaded.lighting.guid,
          }),
        };
        candidates.push(candidate);
        check();
        if (generated) {
          const prepared = await prepareGeometry(
            this.scene,
            source,
            this.managedByteCeiling,
          );
          candidate.geometry = prepared.geometry;
          candidate.releaseGeometry = prepared.release;
        }
      }
      // Recheck every actual source byte after all awaited work; no hash await opens another edit window.
      for (const target of targets) {
        const active = this.active.find(
          (candidate) => candidate.mesh === target.mesh,
        );
        if (
          !sameSource(
            snapshotBakeMesh(active?.holder ?? target.mesh),
            target.source,
          )
        )
          throw new Error("A baked receiver changed during upload.");
      }
      check();
      if (
        targets.some(
          (target) =>
            target.mesh.isDisposed() ||
            target.mesh.geometry !== target.expected ||
            !target.mesh.computeWorldMatrix(true).equals(target.world),
        )
      )
        throw new DOMException(
          "A baked receiver was replaced or moved during upload.",
          "AbortError",
        );
      for (const candidate of candidates)
        if (candidate.geometry) {
          candidate.holder = hiddenMesh(this.scene, "Baked source retention");
          candidate.original.applyToMesh(candidate.holder);
        }
      check();
      try {
        for (const candidate of candidates)
          if (candidate.geometry) {
            candidate.geometry.applyToMesh(candidate.mesh);
            candidate.mesh.subMeshes[0].materialIndex =
              candidate.originalMaterialIndex;
          }
        check();
      } catch (error) {
        for (const candidate of candidates)
          if (
            candidate.mesh.geometry === candidate.geometry &&
            !candidate.mesh.isDisposed()
          ) {
            candidate.expected.applyToMesh(candidate.mesh);
            candidate.mesh.subMeshes[0].materialIndex =
              candidate.originalMaterialIndex;
          }
        throw error;
      }
      this.releaseActive();
      this.active = candidates.splice(0);
      this.current = options.isCurrent;
      this.retained = loaded;
      this.state = { status: "valid" };
      return true;
    } catch (error) {
      if (epoch === this.epoch && !this.disposed) {
        if (this.current && !this.current()) this.releaseActive();
        if (!this.active.length)
          this.state = {
            status: "missing",
            reason:
              error instanceof Error
                ? error.message
                : "Baked lighting could not bind.",
          };
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      if (this.abort === abort) this.abort = undefined;
      this.releaseCandidates(candidates);
    }
  }

  bindingFor(mesh: Mesh): RuntimeIrradianceBinding | undefined {
    if (this.current && !this.current())
      this.invalidate("The baked source changed.");
    const candidate = this.active.find((candidate) => candidate.mesh === mesh);
    if (
      candidate &&
      (mesh.isDisposed() ||
        mesh.geometry !== (candidate.geometry ?? candidate.expected) ||
        !mesh.computeWorldMatrix(true).equals(candidate.world))
    ) {
      this.invalidate("A baked receiver moved or was replaced.");
      return undefined;
    }
    return candidate &&
      !mesh.isDisposed() &&
      (!candidate.geometry || mesh.geometry === candidate.geometry) &&
      candidate.atlas.texture.isReady()
      ? candidate.binding
      : undefined;
  }

  isReady(): boolean {
    return (
      !this.abort &&
      this.state.status === "valid" &&
      this.active.every((candidate) => !!this.bindingFor(candidate.mesh))
    );
  }

  invalidate(reason = "The baked source changed.") {
    this.epoch++;
    this.abort?.abort();
    this.releaseActive();
    this.state = { status: "stale", reasons: [reason] };
  }

  private releaseCandidates(candidates: Candidate[]) {
    const failures: unknown[] = [];
    for (const candidate of candidates) {
      try {
        if (
          candidate.geometry &&
          candidate.mesh.geometry === candidate.geometry &&
          !candidate.mesh.isDisposed() &&
          !candidate.original.isDisposed()
        ) {
          candidate.original.applyToMesh(candidate.mesh);
          candidate.mesh.subMeshes[0].materialIndex =
            candidate.originalMaterialIndex;
        }
      } catch (error) {
        failures.push(error);
      }
      for (const release of [
        candidate.releaseGeometry,
        () => candidate.holder?.dispose(),
        () => candidate.atlas.release(),
      ]) {
        try {
          release?.();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    candidates.length = 0;
    if (failures.length)
      throw new AggregateError(failures, "Baked receiver cleanup failed.");
  }
  private releaseActive() {
    this.current = undefined;
    this.releaseCandidates(this.active);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // Scene disposal iterates the live observer array; immediate self-removal skips its next owner.
    this.sceneObserver?.remove(true);
    this.contextObserver?.remove(true);
    this.invalidate("The baked lighting owner was disposed.");
    this.retained = undefined;
  }
}
