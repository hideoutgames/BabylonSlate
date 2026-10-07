import type { AbstractMesh, BaseTexture, IParticleSystem, Light, Scene } from "@babylonjs/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import type { SnapshotSceneBinding } from "./snapshot-apply";
import { decodeSceneStreamEvent, type SceneStreamIdentity } from "./scene-stream-commands";

type Scope = {
  binding: SnapshotSceneBinding;
  baseline: Set<AbstractMesh>;
  textures: Set<BaseTexture>;
  particles: Set<IParticleSystem>;
  slots: Map<number, SceneStreamIdentity & { instanceActorGuid: string }>;
  textureScratch: Set<BaseTexture>;
  liveScratch: Set<BaseTexture | IParticleSystem>;
  cached?: {
    meshes: AbstractMesh[];
    meshSet: Set<AbstractMesh>;
    meshCount: number;
    slotCount: number;
    newestMesh?: AbstractMesh;
    particles?: IParticleSystem[];
    particleCount?: number;
    particleSlotCount?: number;
    newestParticle?: IParticleSystem;
  };
};
const scopes = new WeakMap<Scene, Scope>();
const particleSlots = new WeakMap<IParticleSystem, number>();

export function registerSceneStreamParticle(system: IParticleSystem, slotId: number): void {
  particleSlots.set(system, slotId);
}

export function isSceneStreamSlotPending(scene: Scene, slotId: number): boolean {
  return scopes.get(scene)?.slots.has(slotId) ?? false;
}

/** Undefined retains ordinary whole-scene readiness when no stream is staged. */
export function admittedSceneMeshes(scene: Scene): AbstractMesh[] | undefined {
  const scope = scopes.get(scene);
  if (!scope) return undefined;
  const cached = scope.cached;
  const newestMesh = scene.meshes.at(-1);
  if (cached && cached.meshCount === scene.meshes.length && cached.slotCount === scope.binding.meshes.size && cached.newestMesh === newestMesh)
    return cached.meshes;
  for (const mesh of scope.baseline) if (mesh.isDisposed()) scope.baseline.delete(mesh);
  const meshes = new Set(scope.baseline);
  for (const [slot, root] of scope.binding.meshes) {
    if (scope.slots.has(slot) || root.isDisposed() || root.getScene() !== scene) continue;
    meshes.add(root);
    for (const child of root.getChildMeshes()) meshes.add(child);
  }
  const result = [...meshes];
  scope.cached = { meshes: result, meshSet: meshes, meshCount: scene.meshes.length, slotCount: scope.binding.meshes.size, newestMesh };
  return result;
}

export function admittedSceneParticles(scene: Scene): IParticleSystem[] | undefined {
  const scope = scopes.get(scene);
  if (!scope) return undefined;
  admittedSceneMeshes(scene);
  const cached = scope.cached!;
  const newestParticle = scene.particleSystems.at(-1);
  if (cached.particles && cached.particleCount === scene.particleSystems.length &&
      cached.particleSlotCount === scope.slots.size && cached.newestParticle === newestParticle) return cached.particles;
  const live = scope.liveScratch;
  live.clear();
  for (const system of scene.particleSystems) live.add(system);
  for (const system of scope.particles) if (!live.has(system)) scope.particles.delete(system);
  const particles = cached.particles ?? [];
  let count = 0;
  for (const system of scene.particleSystems) {
    const slot = particleSlots.get(system);
    if (slot === undefined ? scope.particles.has(system) : !scope.slots.has(slot)) particles[count++] = system;
  }
  particles.length = count;
  cached.particles = particles;
  cached.particleCount = scene.particleSystems.length;
  cached.particleSlotCount = scope.slots.size;
  cached.newestParticle = newestParticle;
  return particles;
}

/** Keep failed or newly changed parent textures strict while ignoring staged uploads. The returned Set is borrowed until the next call. */
export function admittedSceneTextures(scene: Scene, meshes: readonly AbstractMesh[]): Set<BaseTexture> | undefined {
  const scope = scopes.get(scene);
  if (!scope) return undefined;
  const live = scope.liveScratch;
  live.clear();
  for (const texture of scene.textures) live.add(texture);
  for (const texture of scope.textures) if (!live.has(texture)) scope.textures.delete(texture);
  const textures = scope.textureScratch;
  textures.clear();
  for (const texture of scope.textures) textures.add(texture);
  for (const mesh of meshes) for (const texture of (mesh.material ?? scene.defaultMaterial).getActiveTextures()) textures.add(texture);
  for (const system of admittedSceneParticles(scene) ?? []) {
    if (system.particleTexture) textures.add(system.particleTexture);
  }
  return textures;
}

/** Hold new instances outside the parent's readiness and drawing membership. */
export function createSceneStreamAdmission(scene: Scene, binding: SnapshotSceneBinding) {
  const streams = new Map<string, { loadId: number; loading: boolean }>();
  const heldRoots = new Map<AbstractMesh, boolean>();
  const heldLights = new Map<Light, boolean>();
  let syncedMeshes: readonly AbstractMesh[] | undefined;
  let syncedLightCount = -1;
  const ensureScope = (): Scope => {
    let scope = scopes.get(scene);
    if (!scope) {
      scope = {
        binding, baseline: new Set(scene.meshes), textures: new Set(scene.textures),
        particles: new Set(scene.particleSystems), slots: new Map(),
        textureScratch: new Set(), liveScratch: new Set(),
      };
      scopes.set(scene, scope);
    }
    return scope;
  };
  const restore = () => {
    for (const [root, enabled] of heldRoots) if (!root.isDisposed()) root.setEnabled(enabled);
    for (const [light, enabled] of heldLights) if (!light.isDisposed()) light.setEnabled(enabled);
    heldRoots.clear(); heldLights.clear();
  };
  const prune = () => {
    for (const stream of streams.values()) if (stream.loading) return;
    const scope = scopes.get(scene);
    if (!scope) return;
    // Removed precedes per-actor despawn on the reliable worker channel.
    // Keep those still-bound roots staged across the intervening frame.
    if (scope.slots.size > 0) return;
    // Native import/GPU work can outlive cancellation and its retired slot.
    // Keep excluding those consumers until they settle or leave the Scene.
    // Admitted parent consumers are still checked normally by scene-perf.
    if (scene.getWaitingItemsCount() > 0) return;
    const admitted = admittedSceneMeshes(scene)!;
    const admittedSet = scope.cached!.meshSet;
    const textures = admittedSceneTextures(scene, admitted)!;
    try {
      for (const texture of scene.textures) {
        if (!textures.has(texture) && !texture.isRenderTarget && (texture.loadingError || !texture.isReady())) return;
      }
      for (const mesh of scene.meshes) {
        if (!admittedSet.has(mesh) && !mesh.isDisposed() && !mesh.isReady(true)) return;
      }
    } catch {
      // A retired import's native failure must not become the parent's failure.
      // Keep its exclusion until the resource leaves the Scene.
      return;
    }
    restore(); scopes.delete(scene); markSceneReadinessDirty(scene);
  };
  const sync = () => {
    prune();
    const scope = scopes.get(scene);
    if (!scope) return;
    for (const root of heldRoots.keys()) if (root.isDisposed()) heldRoots.delete(root);
    for (const light of heldLights.keys()) if (light.isDisposed()) heldLights.delete(light);
    const meshes = admittedSceneMeshes(scene)!;
    if (syncedMeshes === meshes && syncedLightCount === scene.lights.length) return;
    syncedMeshes = meshes; syncedLightCount = scene.lights.length;
    for (const slot of scope.slots.keys()) {
      const root = binding.meshes.get(slot);
      if (root && !root.isDisposed()) {
        if (!heldRoots.has(root)) heldRoots.set(root, root.isEnabled(false));
        root.setEnabled(false);
      }
      const light = binding.lights.get(slot);
      if (light && !light.isDisposed()) {
        if (!heldLights.has(light)) heldLights.set(light, light.isEnabled());
        light.setEnabled(false);
      }
    }
  };
  const clear = () => {
    restore(); streams.clear(); scopes.delete(scene); syncedMeshes = undefined; markSceneReadinessDirty(scene);
  };
  return {
    sync,
    clear,
    receive(command: CommandMessage): void {
      if ("slotId" in command) {
        const scope = scopes.get(scene);
        if (scope) scope.cached = undefined;
      }
      const event = decodeSceneStreamEvent(command);
      if (event) switch (event.kind) {
        case "reset":
          clear();
          return;
        case "loading": {
          const { actorGuid, streamLoadId } = event.identity;
          const previous = streams.get(actorGuid);
          if (previous && previous.loadId >= streamLoadId) return;
          streams.set(actorGuid, { loadId: streamLoadId, loading: true });
          ensureScope(); markSceneReadinessDirty(scene);
          break;
        }
        case "removed": {
          const { actorGuid, streamLoadId } = event.identity;
          if (streams.get(actorGuid)?.loadId !== streamLoadId) return;
          streams.delete(actorGuid);
          const scope = scopes.get(scene);
          if (scope) scope.cached = undefined;
          prune();
          break;
        }
        case "realized":
          break;
      }
      if (command.type === "spawn" && command.sceneStreamActorGuid) {
        const owner = streams.get(command.sceneStreamActorGuid);
        if (owner?.loading && owner.loadId === command.streamLoadId)
          ensureScope().slots.set(command.slotId, {
            actorGuid: command.sceneStreamActorGuid,
            streamLoadId: owner.loadId,
            instanceActorGuid: command.actorGuid,
          });
      } else if (command.type === "despawn") {
        const scope = scopes.get(scene);
        if (scope?.slots.get(command.slotId)?.instanceActorGuid === command.actorGuid)
          scope.slots.delete(command.slotId);
      }
    },
    publish(slotIds: readonly number[], identity?: SceneStreamIdentity): boolean {
      if (identity && streams.get(identity.actorGuid)?.loadId !== identity.streamLoadId) return false;
      const scope = scopes.get(scene);
      if (!scope) return true;
      scope.cached = undefined;
      const owners = new Set(identity ? [identity.actorGuid] : []);
      for (const slot of slotIds) {
        const owner = scope.slots.get(slot);
        if (!owner || streams.get(owner.actorGuid)?.loadId !== owner.streamLoadId) continue;
        if (identity && (owner.actorGuid !== identity.actorGuid || owner.streamLoadId !== identity.streamLoadId)) continue;
        owners.add(owner.actorGuid);
        scope.slots.delete(slot);
        const root = binding.meshes.get(slot);
        if (root && heldRoots.has(root)) { root.setEnabled(heldRoots.get(root)!); heldRoots.delete(root); }
        const light = binding.lights.get(slot);
        if (light && heldLights.has(light)) { light.setEnabled(heldLights.get(light)!); heldLights.delete(light); }
        binding.onVisualChanged?.(slot);
      }
      for (const owner of owners) {
        const stream = streams.get(owner);
        if (stream) stream.loading = false;
      }
      sync();
      markSceneReadinessDirty(scene);
      prune();
      return true;
    },
  };
}
