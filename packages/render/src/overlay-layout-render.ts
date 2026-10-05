import { Matrix, Mesh, Quaternion, Vector3, type AbstractMesh, type Node, type Observer, type Scene } from "@babylonjs/core";
import { overlayRectContains, type OverlayLayoutEntry, type OverlayLayoutRect } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";

type LayoutCommand = Extract<CommandMessage, { type: "sceneLayerLayout" }>;
const clips = new WeakMap<Node, OverlayLayoutRect | null>();
const editorClipOwner = {};
const virtualDisabled = new WeakMap<AbstractMesh, boolean>();
function restoreVirtualMesh(mesh: AbstractMesh): void {
  const enabled = virtualDisabled.get(mesh);
  if (enabled !== undefined) { mesh.setEnabled(enabled); virtualDisabled.delete(mesh); }
}
function setVirtualRealized(mesh: AbstractMesh, realized: boolean): void {
  if (realized) restoreVirtualMesh(mesh);
  else {
    if (!virtualDisabled.has(mesh)) virtualDisabled.set(mesh, mesh.isEnabled(false));
    mesh.setEnabled(false);
  }
}
const sceneClips = new WeakMap<Scene, {
  owners: Set<object>;
  refresh: () => void;
  dispose: () => void;
}>();
function inheritedClip(mesh: AbstractMesh): OverlayLayoutRect | null {
  for (let current: Node | null = mesh; current; current = current.parent) {
    if (clips.has(current)) return clips.get(current) ?? null;
  }
  return null;
}
/** The same clip is checked by normal ray picks and enlarged touch targets. */
export function overlayClipAllowsPoint(mesh: AbstractMesh, x: number, y: number): boolean {
  const clip = inheritedClip(mesh);
  return !clip || overlayRectContains(clip, x, y);
}
function installClip(mesh: Mesh): () => void {
  let scissored = false;
  const beforeBind = mesh.onBeforeBindObservable.add(() => {
    const clip = inheritedClip(mesh), scene = mesh.getScene(), camera = scene.activeCamera;
    if (!clip || !camera) return;
    const engine = scene.getEngine(), width = engine.getRenderWidth(), height = engine.getRenderHeight();
    const viewport = camera.viewport.toGlobal(width, height);
    const min = Vector3.Project(new Vector3(clip.x - clip.width / 2, clip.y - clip.height / 2, 0), Matrix.IdentityReadOnly, scene.getTransformMatrix(), viewport);
    const max = Vector3.Project(new Vector3(clip.x + clip.width / 2, clip.y + clip.height / 2, 0), Matrix.IdentityReadOnly, scene.getTransformMatrix(), viewport);
    const x = Math.max(0, Math.min(width, Math.floor(Math.min(min.x, max.x))));
    const top = Math.max(0, Math.min(height, Math.floor(Math.min(min.y, max.y))));
    const right = Math.max(x, Math.min(width, Math.ceil(Math.max(min.x, max.x))));
    const bottom = Math.max(top, Math.min(height, Math.ceil(Math.max(min.y, max.y))));
    const empty = clip.width <= 0 || clip.height <= 0;
    // Babylon's canvas scissor uses a bottom-left origin on both backends.
    // WebGPU RTTs also flip geometry Y, so their unflipped scissor has the same
    // coordinates for the layer's ordinary render targets.
    engine.enableScissor(empty ? 1 : x, height - bottom, empty ? 0 : right - x, empty ? 0 : bottom - top);
    scissored = true;
  });
  const resetScissor = () => { if (scissored) { mesh.getScene().getEngine().disableScissor(); scissored = false; } };
  const afterRender = mesh.onAfterRenderObservable.add(resetScissor);
  return () => {
    mesh.onBeforeBindObservable.remove(beforeBind);
    mesh.onAfterRenderObservable.remove(afterRender);
    resetScissor();
  };
}
function setSceneClipOwner(scene: Scene, owner: object, enabled: boolean): void {
  const existing = sceneClips.get(scene);
  if (!enabled) {
    if (!existing) return;
    existing.owners.delete(owner);
    if (existing.owners.size === 0) existing.dispose();
    else existing.refresh();
    return;
  }
  if (existing) {
    existing.owners.add(owner);
    existing.refresh();
    return;
  }
  const meshes = new Map<Mesh, () => void>();
  let beforeRender: Observer<Scene> | null = null;
  let onDispose: Observer<Scene> | null = null;
  const hooks = {
    owners: new Set([owner]),
    refresh: () => {
      for (const [mesh, detach] of meshes) {
        if (!mesh.isDisposed() && inheritedClip(mesh)) continue;
        detach();
        meshes.delete(mesh);
      }
      for (const mesh of scene.meshes) {
        if (mesh instanceof Mesh && inheritedClip(mesh) && !meshes.has(mesh)) meshes.set(mesh, installClip(mesh));
      }
    },
    dispose: () => {
      scene.onBeforeRenderObservable.remove(beforeRender);
      scene.onDisposeObservable.remove(onDispose);
      for (const detach of meshes.values()) detach();
      meshes.clear();
      sceneClips.delete(scene);
    },
  };
  sceneClips.set(scene, hooks);
  beforeRender = scene.onBeforeRenderObservable.add(hooks.refresh);
  onDispose = scene.onDisposeObservable.addOnce(hooks.dispose);
  hooks.refresh();
}
export function applyEditorLayoutClips(scene: Scene, entries: ReadonlyMap<string, OverlayLayoutEntry>): void {
  for (const mesh of scene.meshes) { clips.delete(mesh); restoreVirtualMesh(mesh); }
  for (const entry of entries.values()) {
    const name = `editorActor:${entry.actorId}${entry.componentId ? `|${entry.componentId}` : ""}`;
    const mesh = scene.getMeshByName(name);
    if (mesh) { clips.set(mesh, entry.clip); setVirtualRealized(mesh, entry.realized !== false); }
  }
  setSceneClipOwner(scene, editorClipOwner, [...entries.values()].some((entry) => entry.clip !== null));
}

/** Retains layout independently from asynchronous visual replacement. */
export class OverlayLayoutRenderer {
  private readonly layers = new Map<string, LayoutCommand>();
  private readonly layerMeshes = new Map<string, Set<AbstractMesh>>();
  private readonly bindings = new Map<string, {
    scene: Scene;
    beforeRender: Observer<Scene> | null;
    onDispose: Observer<Scene> | null;
    addedMesh: Observer<AbstractMesh> | null;
    removedMesh: Observer<AbstractMesh> | null;
    dirty: boolean;
    meshCount: number;
  }>();
  private readonly sceneForLayer: (id: string) => Scene | undefined;
  constructor(sceneForLayer: (id: string) => Scene | undefined) { this.sceneForLayer = sceneForLayer; }
  apply(command: LayoutCommand): void {
    this.layers.set(command.layerId, command);
    const scene = this.sceneForLayer(command.layerId);
    let binding = this.bindings.get(command.layerId);
    if (binding && (binding.scene !== scene || command.entries.length === 0)) {
      this.releaseBinding(command.layerId);
      binding = undefined;
    }
    if (!scene) return;
    if (command.entries.length === 0) return;
    if (!binding) {
      binding = { scene, beforeRender: null, onDispose: null, addedMesh: null, removedMesh: null, dirty: true, meshCount: -1 };
      this.bindings.set(command.layerId, binding);
      const current = binding;
      binding.addedMesh = scene.onNewMeshAddedObservable.add(() => { current.dirty = true; });
      binding.removedMesh = scene.onMeshRemovedObservable.add(() => { current.dirty = true; });
      binding.beforeRender = scene.onBeforeRenderObservable.add(() => {
        // Babylon defers mesh-added notifications; the count also catches a
        // visual created immediately before this scene's first draw.
        if (current.dirty || current.meshCount !== scene.meshes.length) this.sync(command.layerId);
      });
      binding.onDispose = scene.onDisposeObservable.addOnce(() => this.remove(command.layerId));
    }
    this.sync(command.layerId);
    setSceneClipOwner(scene, binding, command.entries.some((entry) => entry.clip !== null));
  }
  private sync(layerId: string): void {
    const scene = this.sceneForLayer(layerId), command = this.layers.get(layerId);
    if (!scene || !command) return;
    const binding = this.bindings.get(layerId);
    if (binding) {
      binding.dirty = false;
      binding.meshCount = scene.meshes.length;
    }
    // A reparented child may no longer occur in the new layout command.
    for (const mesh of this.layerMeshes.get(layerId) ?? []) { clips.delete(mesh); restoreVirtualMesh(mesh); }
    const currentMeshes = new Set<AbstractMesh>();
    this.layerMeshes.set(layerId, currentMeshes);
    const meshesByName = new Map<string, AbstractMesh>();
    for (const mesh of scene.meshes) if (!meshesByName.has(mesh.name)) meshesByName.set(mesh.name, mesh);
    for (const entry of command.entries) {
      const mesh = meshesByName.get(`actor-${entry.slotId}${entry.componentId ? `|${entry.componentId}` : ""}`);
      if (!mesh) continue;
      clips.set(mesh, entry.clip);
      setVirtualRealized(mesh, entry.realized !== false);
      currentMeshes.add(mesh);
      if (entry.componentId && entry.transform) {
        if (mesh.position.equalsToFloats(...entry.transform.position) &&
          mesh.rotationQuaternion?.equalsToFloats(...entry.transform.rotation) &&
          mesh.scaling.equalsToFloats(...entry.transform.scale)) continue;
        mesh.unfreezeWorldMatrix();
        mesh.position.copyFromFloats(...entry.transform.position);
        mesh.rotationQuaternion ??= Quaternion.Identity();
        mesh.rotationQuaternion.copyFromFloats(...entry.transform.rotation);
        mesh.scaling.copyFromFloats(...entry.transform.scale);
      }
    }
    sceneClips.get(scene)?.refresh();
  }
  scrollAt(layerId: string, x: number, y: number): OverlayLayoutEntry | undefined {
    const entries = this.layers.get(layerId)?.entries ?? [];
    return entries.filter(e => e.interactive !== false && e.scroll && overlayRectContains(e.rect, x, y) && (!e.clip || overlayRectContains(e.clip, x, y)))
      .sort((a, b) => b.scrollAncestors.length - a.scrollAncestors.length)[0];
  }
  remove(layerId: string): void {
    this.layers.delete(layerId);
    this.releaseBinding(layerId);
  }
  private releaseBinding(layerId: string): void {
    for (const mesh of this.layerMeshes.get(layerId) ?? []) { clips.delete(mesh); restoreVirtualMesh(mesh); }
    this.layerMeshes.delete(layerId);
    const binding = this.bindings.get(layerId);
    if (!binding) return;
    this.bindings.delete(layerId);
    binding.scene.onBeforeRenderObservable.remove(binding.beforeRender);
    binding.scene.onDisposeObservable.remove(binding.onDispose);
    binding.scene.onNewMeshAddedObservable.remove(binding.addedMesh);
    binding.scene.onMeshRemovedObservable.remove(binding.removedMesh);
    setSceneClipOwner(binding.scene, binding, false);
  }
  dispose(): void {
    for (const layerId of this.layers.keys()) this.remove(layerId);
  }
}
