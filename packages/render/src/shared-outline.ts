import {
  Constants, RawTexture, Texture, VertexBuffer,
  type AbstractMesh, type InstancedMesh, type Mesh, type Scene,
} from "@babylonjs/core";
import type { WebGPUDrawContext } from "@babylonjs/core/Engines/WebGPU/webgpuDrawContext";
import {
  beginManagedRenderAllocation, releaseManagedRenderLeaseAfterDisposal,
  type ManagedRenderLease,
} from "./managed-render-resources";

export const SHARED_OUTLINE_ATTRIBUTE = "babylonSlateOutlineIdentity";
export const SHARED_OUTLINE_MAX_ID = 65_535;
export const SHARED_OUTLINE_MAX_WIDTH = 8;
export type SharedOutlineGroup = "strict" | "through" | "selection";
export const SHARED_OUTLINE_GROUPS: readonly SharedOutlineGroup[] = ["strict", "through", "selection"];
export interface SharedOutlineTarget {
  /** Stable authored actor/group key, shared by every consumer of this target. */
  key: string;
  meshes: readonly AbstractMesh[];
}
export interface SharedOutlineContribution {
  kind: "global" | "component" | "selection";
  targets: readonly SharedOutlineTarget[];
  color: readonly [number, number, number];
  /** Actual output pixels; independent of DPR and dynamic-resolution requests. */
  width: number;
  throughMeshes?: boolean;
}
type BufferRecord = { buffer: VertexBuffer; data: Float32Array; length: number; lease: ManagedRenderLease };
type SourceRecord = {
  original: Mesh["_processInstancedBuffers"];
  wrapper: Mesh["_processInstancedBuffers"];
  buffers: Map<number, BufferRecord>;
};
type StyleRecord = { texture: RawTexture; data: Float32Array; lease: ManagedRenderLease };
const owners = new WeakMap<Scene, SharedOutlineOwner>();

/** Scene identity ownership is deliberately separate from per-view styles. */
export class SharedOutlineOwner {
  static forScene(scene: Scene): SharedOutlineOwner {
    let owner = owners.get(scene);
    if (!owner) { owner = new SharedOutlineOwner(scene); owners.set(scene, owner); }
    return owner;
  }
  readonly scene: Scene;
  private readonly views = new Set<SharedOutlineView>();
  private readonly identities = new Map<string, number>();
  private readonly meshIdentity = new Map<AbstractMesh, number>();
  private readonly sources = new Map<Mesh, SourceRecord>();
  private readonly renderPasses = new Set<number>();
  private readonly releases = new Set<Promise<void>>();
  private uploads = 0;
  private bufferBytes = 0;
  private disposed = false;
  meshRevision = 0;
  private readonly stopWatchingMeshes: () => void;

  private constructor(scene: Scene) {
    this.scene = scene;
    const added = scene.onNewMeshAddedObservable.add(() => { this.meshRevision++; });
    const removed = scene.onMeshRemovedObservable.add((mesh) => {
      this.meshRevision++;
      const record = this.sources.get(mesh as Mesh);
      if (record) this.releaseSource(mesh as Mesh, record);
    });
    this.stopWatchingMeshes = () => {
      scene.onNewMeshAddedObservable.remove(added); scene.onMeshRemovedObservable.remove(removed);
    };
    scene.onDisposeObservable.addOnce(() => this.dispose());
  }
  createView(key: string): SharedOutlineView {
    if (this.disposed || [...this.views].some((view) => view.key === key))
      throw new Error("Shared outline view requires a unique live view key.");
    const view = new SharedOutlineView(this, key);
    this.views.add(view);
    return view;
  }
  identityFor(mesh: AbstractMesh): number {
    return this.meshIdentity.get(mesh) ??
      (mesh._masterMesh ? this.meshIdentity.get(mesh._masterMesh) : undefined) ?? 0;
  }
  identityForKey(key: string): number { return this.identities.get(key) ?? 0; }
  get maximumIdentity(): number { return this.identities.size; }

  /** Validate the complete replacement before mutating live source registrations. */
  reconcile(): void {
    const requested = new Map<AbstractMesh, string>();
    const keys = new Set<string>();
    for (const view of this.views) for (const contribution of view.contributions.values())
      for (const target of contribution.targets) {
        keys.add(target.key);
        for (const mesh of target.meshes) {
          if (mesh.isDisposed() || mesh.getScene() !== this.scene) continue;
          const old = requested.get(mesh);
          if (old !== undefined && old !== target.key)
            throw new Error("Shared outline consumers must use the same actor key for the same mesh.");
          requested.set(mesh, target.key);
        }
      }
    const newKeys = [...keys].filter((key) => !this.identities.has(key));
    if (this.identities.size + newKeys.length > SHARED_OUTLINE_MAX_ID)
      throw new Error("Shared outline identity capacity (65,535 actor keys over the Scene lifetime) exceeded.");
    const next = new Map<AbstractMesh, number>();
    const requiredSources = new Set<Mesh>();
    for (const mesh of requested.keys()) {
      if (!mesh.hasThinInstances && (mesh.isAnInstance || mesh.hasInstances)) {
        const source = mesh.isAnInstance ? (mesh as InstancedMesh).sourceMesh : mesh as Mesh;
        requiredSources.add(source);
        for (const lod of source.getLODLevels()) if (lod.mesh) requiredSources.add(lod.mesh);
      }
    }
    for (const source of requiredSources) if (!this.sources.has(source) && source.instancedBuffers?.[SHARED_OUTLINE_ATTRIBUTE] !== undefined)
      throw new Error("Shared outline identity registration already belongs to another owner.");
    const acquired: Mesh[] = [];
    try {
      for (const source of requiredSources) if (!this.sources.has(source)) { this.acquireSource(source); acquired.push(source); }
    } catch (error) {
      for (const source of acquired) this.releaseSource(source, this.sources.get(source)!);
      throw error;
    }
    for (const key of newKeys.sort()) this.identities.set(key, this.identities.size + 1);
    for (const [mesh, key] of requested) next.set(mesh, this.identities.get(key)!);
    for (const [source, record] of this.sources) if (!requiredSources.has(source)) this.releaseSource(source, record);
    for (const mesh of this.meshIdentity.keys()) if (!next.has(mesh) && mesh.instancedBuffers)
      mesh.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE] = 0;
    this.meshIdentity.clear();
    for (const [mesh, id] of next) this.meshIdentity.set(mesh, id);
    for (const source of requiredSources) {
      source.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE] = this.identityFor(source);
      for (const instance of source.instances)
        instance.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE] = this.identityFor(instance);
    }
  }
  /** Admit a late instance source/LOD only when its actual mask draw needs it. */
  prepareRenderSource(source: Mesh): void {
    if (source.hasThinInstances || this.sources.has(source)) return;
    const master = source._masterMesh;
    if (!source.hasInstances && !master?.hasInstances) return;
    this.acquireSource(source);
    source.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE] = this.identityFor(source);
    for (const instance of source.instances)
      instance.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE] = this.identityFor(instance);
  }
  private acquireSource(source: Mesh): void {
    if (this.sources.has(source)) return;
    if (source.instancedBuffers?.[SHARED_OUTLINE_ATTRIBUTE] !== undefined)
      throw new Error("Shared outline identity registration already belongs to another owner.");
    // The public registration also initializes existing instances and invalidates
    // native attribute caches. Replace only our stream, never another user's data.
    source.registerInstancedBuffer(SHARED_OUTLINE_ATTRIBUTE, 1);
    const storage = source._userInstancedBuffersStorage!;
    storage.vertexBuffers[SHARED_OUTLINE_ATTRIBUTE]?.dispose();
    delete storage.vertexBuffers[SHARED_OUTLINE_ATTRIBUTE];
    const original = source._processInstancedBuffers;
    const record: SourceRecord = { original, wrapper: original, buffers: new Map() };
    record.wrapper = (visibleInstances, renderSelf) => {
      const value = source.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE];
      delete source.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE];
      try { original.call(source, visibleInstances, renderSelf); }
      finally { source.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE] = value; }
      if (this.renderPasses.has(this.scene.getEngine().currentRenderPassId))
        this.updateInstanceBuffer(source, record, visibleInstances, renderSelf);
    };
    source._processInstancedBuffers = record.wrapper;
    this.sources.set(source, record);
  }
  private updateInstanceBuffer(source: Mesh, record: SourceRecord,
    instances: InstancedMesh[] | null, renderSelf: boolean): void {
    const engine = this.scene.getEngine();
    const pass = engine.currentRenderPassId;
    const length = (instances?.length ?? 0) + Number(renderSelf);
    let state = record.buffers.get(pass);
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(32, length)));
    let replacement = false;
    if (!state || state.data.length < capacity) {
      const lease = beginManagedRenderAllocation(engine, capacity * 4);
      if (!lease) throw new Error("Shared outline instance buffer exceeds the Engine resource reservation.");
      const data = new Float32Array(capacity);
      try {
        const buffer = new VertexBuffer(engine, data, SHARED_OUTLINE_ATTRIBUTE, true, false, 1, true);
        lease.commit([{ handle: buffer.getBuffer()!, bytes: capacity * 4, category: "geometry" }]);
        if (state) this.retireBuffer(state);
        state = { buffer, data, length: 0, lease };
        record.buffers.set(pass, state);
        this.bufferBytes += capacity * 4;
        replacement = true;
      } catch (error) { lease.release(); throw error; }
    }
    let first = capacity, last = -1, offset = 0;
    const put = (id: number) => {
      if (state!.data[offset] !== id || replacement) {
        state!.data[offset] = id; first = Math.min(first, offset); last = offset;
      }
      offset++;
    };
    if (renderSelf) put(this.identityFor(source));
    for (const instance of instances ?? []) put(this.identityFor(instance));
    if (last >= first) {
      state.buffer.updateDirectly(state.data.subarray(first, last + 1), first);
      this.uploads++;
    }
    state.length = length;
    const storage = source._userInstancedBuffersStorage!;
    storage.data[SHARED_OUTLINE_ATTRIBUTE] = state.data;
    storage.sizes[SHARED_OUTLINE_ATTRIBUTE] = capacity;
    if (engine.isWebGPU) {
      storage.renderPasses ??= {};
      storage.renderPasses[pass] ??= {};
      storage.renderPasses[pass][SHARED_OUTLINE_ATTRIBUTE] = state.buffer;
    } else if (storage.vertexBuffers[SHARED_OUTLINE_ATTRIBUTE] !== state.buffer) {
      storage.vertexBuffers[SHARED_OUTLINE_ATTRIBUTE] = state.buffer;
      // WebGL VAOs capture the buffer handle, not just its layout. A pass may
      // retain its own unchanged data while another pass renders a different list.
      source._invalidateInstanceVertexArrayObject();
    }
    if (replacement) this.invalidateBindings(source, pass);
  }
  private retireBuffer(record: BufferRecord): void {
    record.buffer.dispose(); this.bufferBytes -= record.data.byteLength;
    this.trackRelease(releaseManagedRenderLeaseAfterDisposal(this.scene.getEngine(), record.lease));
  }
  private releaseSource(source: Mesh, record: SourceRecord): void {
    if (source._processInstancedBuffers === record.wrapper) source._processInstancedBuffers = record.original;
    for (const buffer of record.buffers.values()) this.retireBuffer(buffer);
    const storage = source._userInstancedBuffersStorage;
    if (storage) {
      for (const buffers of Object.values(storage.renderPasses ?? {})) delete buffers[SHARED_OUTLINE_ATTRIBUTE];
      delete storage.vertexBuffers[SHARED_OUTLINE_ATTRIBUTE];
      delete storage.data[SHARED_OUTLINE_ATTRIBUTE];
      delete storage.strides[SHARED_OUTLINE_ATTRIBUTE];
      delete storage.sizes[SHARED_OUTLINE_ATTRIBUTE];
    }
    if (source.instancedBuffers) delete source.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE];
    for (const instance of source.instances) if (instance.instancedBuffers) delete instance.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE];
    this.invalidateBindings(source);
    this.sources.delete(source);
  }
  trackRelease(release: Promise<void>): void {
    this.releases.add(release);
    void release.then(() => this.releases.delete(release), () => {});
  }
  /** Graph replacement must not leave source-owned buffers for dead pass IDs. */
  registerRenderPass(pass: number): void { this.renderPasses.add(pass); }
  retireRenderPass(pass: number): void {
    this.renderPasses.delete(pass);
    for (const [source, record] of this.sources) {
      const buffer = record.buffers.get(pass);
      if (!buffer) continue;
      this.retireBuffer(buffer); record.buffers.delete(pass);
      const storage = source._userInstancedBuffersStorage;
      if (storage?.renderPasses?.[pass]) delete storage.renderPasses[pass][SHARED_OUTLINE_ATTRIBUTE];
      if (storage?.vertexBuffers[SHARED_OUTLINE_ATTRIBUTE] === buffer.buffer) delete storage.vertexBuffers[SHARED_OUTLINE_ATTRIBUTE];
      this.invalidateBindings(source, pass);
    }
  }
  private invalidateBindings(source: Mesh, pass?: number): void {
    source._invalidateInstanceVertexArrayObject();
    // A new VBO invalidates captured vertex handles, not compiled shaders.
    // resetDrawCache() disposes owned Effects and races task retirement.
    for (const subMesh of source.subMeshes ?? []) {
      for (const id of pass === undefined ? this.renderPasses : [pass]) {
        const wrapper = subMesh._getDrawWrapper(id);
        // This can run after material binding inside a native mesh draw. A
        // full reset would erase this frame's uniform/storage-buffer bindings.
        // Vertex handles are captured only by the fast bundle; its layout and
        // uniform bind groups are unchanged by replacement of this ID stream.
        if (this.scene.getEngine().isWebGPU && wrapper?.drawContext)
          (wrapper.drawContext as WebGPUDrawContext).fastBundle = undefined;
        if (wrapper) wrapper._forceRebindOnNextCall = true;
      }
    }
  }
  removeView(view: SharedOutlineView): void { this.views.delete(view); this.reconcile(); }
  diagnostics() {
    return { identityCount: this.identities.size, sourceCount: this.sources.size,
      instanceBufferBytes: this.bufferBytes, instanceUploadCount: this.uploads };
  }
  async whenReleased(): Promise<void> { await Promise.all(this.releases); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopWatchingMeshes();
    for (const view of [...this.views]) view.dispose();
    for (const [source, record] of this.sources) this.releaseSource(source, record);
    this.meshIdentity.clear(); owners.delete(this.scene);
  }
}

/** One camera/view's styles; gameplay and editor memberships cannot cross views. */
export class SharedOutlineView {
  readonly contributions = new Map<string, SharedOutlineContribution>();
  readonly scene: Scene;
  readonly key: string;
  readonly owner: SharedOutlineOwner;
  revision = 0;
  isDisposed = false;
  private preparedRevision = -1;
  private readonly styles = new Map<SharedOutlineGroup, StyleRecord>();
  private readonly activeGroups = new Set<SharedOutlineGroup>();
  private occluders: readonly AbstractMesh[] | null = null;
  private readonly meshLists = new Map<SharedOutlineGroup, { revision: number; sceneRevision: number; meshes: AbstractMesh[] }>();
  private styleUploads = 0;
  tableWidth = 1;
  tableHeight = 1;
  maximumWidth = 0;
  constructor(owner: SharedOutlineOwner, key: string) { this.owner = owner; this.scene = owner.scene; this.key = key; }
  get active(): boolean { return !this.isDisposed && [...this.contributions.values()].some((entry) => entry.targets.length > 0); }
  /** Hosts supply authored world occluders, excluding editor helpers and guides. */
  setOccluders(meshes: readonly AbstractMesh[] | null): void {
    const next = meshes ? [...new Set(meshes)] : null;
    if (next === null ? this.occluders === null : this.occluders !== null &&
      next.length === this.occluders.length && next.every((mesh) => this.occluders!.includes(mesh))) return;
    this.occluders = next; this.revision++;
  }
  setContribution(key: string, input: SharedOutlineContribution): void {
    if (this.isDisposed) throw new Error("Shared outline view is disposed.");
    const next = normalizedContribution(key, input);
    const previous = this.contributions.get(key);
    if (previous && sameContribution(previous, next)) return;
    this.contributions.set(key, next);
    try { if (!previous || !sameTargets(previous, next)) this.owner.reconcile(); }
    catch (error) { if (previous) this.contributions.set(key, previous); else this.contributions.delete(key); throw error; }
    this.revision++;
  }
  /** Publish a complete host snapshot or retain the previous accepted snapshot. */
  replaceContributions(entries: ReadonlyMap<string, SharedOutlineContribution>, occluders: readonly AbstractMesh[] | null): void {
    if (this.isDisposed) throw new Error("Shared outline view is disposed.");
    const next = new Map([...entries].map(([key, entry]) => [key, normalizedContribution(key, entry)]));
    const nextOccluders = occluders ? [...new Set(occluders)] : null;
    const contributionsChanged = next.size !== this.contributions.size || [...next].some(([key, value]) => {
      const previous = this.contributions.get(key); return !previous || !sameContribution(previous, value);
    });
    const occludersChanged = nextOccluders === null ? this.occluders !== null : this.occluders === null ||
      nextOccluders.length !== this.occluders.length || nextOccluders.some((mesh) => !this.occluders!.includes(mesh));
    if (!contributionsChanged && !occludersChanged) return;
    if (contributionsChanged) {
      const previous = new Map(this.contributions);
      const membershipChanged = previous.size !== next.size || [...next].some(([key, value]) => {
        const before = previous.get(key); return !before || !sameTargets(before, value);
      });
      this.contributions.clear();
      for (const [key, value] of next) this.contributions.set(key, value);
      try { if (membershipChanged) this.owner.reconcile(); }
      catch (error) {
        this.contributions.clear();
        for (const [key, value] of previous) this.contributions.set(key, value);
        throw error;
      }
    }
    this.occluders = nextOccluders;
    this.revision++;
    if (!this.active) this.releaseStyles();
  }
  removeContribution(key: string): void {
    if (!this.contributions.delete(key)) return;
    this.owner.reconcile(); this.revision++;
    if (!this.active) this.releaseStyles();
  }
  /** Style data changes are independent of graph/material topology. */
  prepare(): void {
    if (!this.active) { this.releaseStyles(); return; }
    if (this.preparedRevision === this.revision) return;
    const count = 2 ** Math.ceil(Math.log2(Math.max(16, this.owner.maximumIdentity + 1)));
    const maxSize = this.scene.getEngine().getCaps().maxTextureSize;
    const width = Math.min(256, count, maxSize), height = Math.ceil(count / width);
    if (height > maxSize) throw new Error("Shared outline style table exceeds texture capacity.");
    const arrays = new Map(SHARED_OUTLINE_GROUPS.map((group) => [group, new Float32Array(width * height * 4)]));
    const priority = { global: 0, component: 1, selection: 2 };
    let maximumWidth = 0;
    for (const [, entry] of [...this.contributions].sort((a, b) => priority[a[1].kind] - priority[b[1].kind] || a[0].localeCompare(b[0]))) {
      const group: SharedOutlineGroup = entry.kind === "selection" ? "selection" : entry.throughMeshes && entry.kind === "component" ? "through" : "strict";
      for (const target of entry.targets) {
        const offset = this.owner.identityForKey(target.key) * 4;
        if (entry.kind === "component") { arrays.get("strict")!.fill(0, offset, offset + 4); arrays.get("through")!.fill(0, offset, offset + 4); }
        arrays.get(group)!.set([...entry.color, entry.width], offset);
      }
      maximumWidth = Math.max(maximumWidth, entry.width);
    }
    const replacements = new Map<SharedOutlineGroup, StyleRecord>();
    try {
      // Build all replacement tables before retiring any valid prior table.
      for (const group of SHARED_OUTLINE_GROUPS) {
        const data = arrays.get(group)!;
        const record = this.styles.get(group);
        if (!record || record.data.length !== data.length) {
          const engine = this.scene.getEngine();
          const lease = beginManagedRenderAllocation(engine, data.byteLength);
          if (!lease) throw new Error("Shared outline styles exceed the Engine resource reservation.");
          let texture: RawTexture | undefined;
          try {
            texture = new RawTexture(data, width, height, Constants.TEXTUREFORMAT_RGBA, this.scene,
              false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
            texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
            lease.commit([{ handle: texture.getInternalTexture()!, bytes: data.byteLength, category: "postprocess" }]);
            replacements.set(group, { texture, data, lease });
          } catch (error) {
            texture?.dispose();
            this.owner.trackRelease(releaseManagedRenderLeaseAfterDisposal(engine, lease));
            throw error;
          }
        }
      }
    } catch (error) {
      for (const record of replacements.values()) this.retireStyle(record);
      throw error;
    }
    for (const group of SHARED_OUTLINE_GROUPS) {
      const replacement = replacements.get(group), previous = this.styles.get(group);
      if (replacement) {
        if (previous) this.retireStyle(previous);
        this.styles.set(group, replacement); this.styleUploads++;
      } else if (previous) {
        const data = arrays.get(group)!;
        if (data.some((value, index) => value !== previous.data[index])) {
          previous.texture.update(data); previous.data = data; this.styleUploads++;
        }
      }
    }
    this.maximumWidth = maximumWidth;
    this.activeGroups.clear();
    for (const group of SHARED_OUTLINE_GROUPS) {
      const data = arrays.get(group)!;
      for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) {
        this.activeGroups.add(group); break;
      }
    }
    this.tableWidth = width; this.tableHeight = height; this.preparedRevision = this.revision;
  }
  styleTexture(group: SharedOutlineGroup): RawTexture { this.prepare(); return this.styles.get(group)!.texture; }
  groupActive(group: SharedOutlineGroup): boolean {
    this.prepare(); return this.activeGroups.has(group);
  }
  meshesForGroup(group: SharedOutlineGroup): AbstractMesh[] {
    this.prepare();
    const previous = this.meshLists.get(group);
    if (previous?.revision === this.revision && previous.sceneRevision === this.owner.meshRevision) return previous.meshes;
    const data = this.styles.get(group)?.data;
    const meshes = group === "strict" ? (this.occluders ?? this.scene.meshes).filter((mesh) => !mesh.isDisposed()) :
      this.scene.meshes.filter((mesh) => !mesh.isDisposed() && (data?.[this.owner.identityFor(mesh) * 4 + 3] ?? 0) > 0);
    this.meshLists.set(group, { revision: this.revision, sceneRevision: this.owner.meshRevision, meshes });
    return meshes;
  }
  diagnostics() {
    return { revision: this.revision, consumerCount: this.contributions.size,
      targetCount: new Set([...this.contributions.values()].flatMap((entry) => entry.targets.map((target) => target.key))).size,
      activeGroups: this.active ? SHARED_OUTLINE_GROUPS.filter((group) => this.groupActive(group)) : [], styleUploadCount: this.styleUploads };
  }
  private retireStyle(record: StyleRecord): void {
    record.texture.dispose();
    this.owner.trackRelease(releaseManagedRenderLeaseAfterDisposal(this.scene.getEngine(), record.lease));
  }
  private releaseStyles(): void { for (const record of this.styles.values()) this.retireStyle(record); this.styles.clear(); this.activeGroups.clear(); this.preparedRevision = -1; }
  dispose(): void {
    if (this.isDisposed) return; this.isDisposed = true;
    this.contributions.clear(); this.meshLists.clear(); this.releaseStyles(); this.owner.removeView(this); this.revision++;
  }
}
function sameContribution(a: SharedOutlineContribution, b: SharedOutlineContribution): boolean {
  return a.kind === b.kind && a.width === b.width && !!a.throughMeshes === !!b.throughMeshes &&
    a.color.every((value, index) => value === b.color[index]) && sameTargets(a, b);
}
function normalizedContribution(key: string, input: SharedOutlineContribution): SharedOutlineContribution {
  if (!key || !["global", "component", "selection"].includes(input.kind) ||
    !Number.isFinite(input.width) || input.width < 0.25 || input.width > SHARED_OUTLINE_MAX_WIDTH ||
    input.color.length !== 3 || input.color.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
    input.targets.some((target) => !target.key))
    throw new Error("Shared outline contribution has invalid identity, color, or width (0.25–8 pixels).");
  return { ...input, color: [...input.color], targets: [...input.targets]
    .map((target) => ({ key: target.key, meshes: [...target.meshes] })).sort((a, b) => a.key.localeCompare(b.key)) };
}
function sameTargets(a: SharedOutlineContribution, b: SharedOutlineContribution): boolean {
  return a.targets.length === b.targets.length &&
    a.targets.every((target, index) => target.key === b.targets[index]!.key && target.meshes.length === b.targets[index]!.meshes.length &&
      target.meshes.every((mesh) => b.targets[index]!.meshes.includes(mesh)));
}
