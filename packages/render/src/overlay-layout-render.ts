import { Matrix, Mesh, Quaternion, Vector3, Viewport, type AbstractMesh, type Node, type Observer, type Scene } from "@babylonjs/core";
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
/**
 * `inheritedClip` for the refresh pass: shares work between meshes with common
 * ancestors and records every parent link the answer depends on, so a later
 * frame can tell whether any of them was reparented.
 */
function watchedInheritedClip(
  mesh: AbstractMesh,
  resolved: Map<Node, OverlayLayoutRect | null>,
  watched: Map<Node, Node | null>,
): OverlayLayoutRect | null {
  const path: Node[] = [];
  let clip: OverlayLayoutRect | null = null;
  for (let current: Node | null = mesh; current; current = current.parent) {
    if (resolved.has(current)) { clip = resolved.get(current) ?? null; break; }
    if (clips.has(current)) { clip = clips.get(current) ?? null; resolved.set(current, clip); break; }
    path.push(current);
  }
  for (const node of path) { resolved.set(node, clip); watched.set(node, node.parent); }
  return clip;
}
/** The same clip is checked by normal ray picks and enlarged touch targets. */
export function overlayClipAllowsPoint(mesh: AbstractMesh, x: number, y: number): boolean {
  const clip = inheritedClip(mesh);
  return !clip || overlayRectContains(clip, x, y);
}
// Clipped meshes bind every frame; project their corners through shared scratch.
const scratchViewport = new Viewport(0, 0, 1, 1);
const scratchCorner = new Vector3();
const scratchProjected = new Vector3();
function installClip(mesh: Mesh): () => void {
  let scissored = false;
  const beforeBind = mesh.onBeforeBindObservable.add(() => {
    const clip = inheritedClip(mesh), scene = mesh.getScene(), camera = scene.activeCamera;
    if (!clip || !camera) return;
    const engine = scene.getEngine(), width = engine.getRenderWidth(), height = engine.getRenderHeight();
    camera.viewport.toGlobalToRef(width, height, scratchViewport);
    // All four corners: a turned Scene Layer camera puts any of them at the screen extremes.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let corner = 0; corner < 4; corner++) {
      scratchCorner.set(clip.x + (corner & 1 ? 1 : -1) * clip.width / 2, clip.y + (corner & 2 ? 1 : -1) * clip.height / 2, 0);
      const projected = Vector3.ProjectToRef(scratchCorner, Matrix.IdentityReadOnly, scene.getTransformMatrix(), scratchViewport, scratchProjected);
      minX = Math.min(minX, projected.x); maxX = Math.max(maxX, projected.x);
      minY = Math.min(minY, projected.y); maxY = Math.max(maxY, projected.y);
    }
    const x = Math.max(0, Math.min(width, Math.floor(minX)));
    const top = Math.max(0, Math.min(height, Math.floor(minY)));
    const right = Math.max(x, Math.min(width, Math.ceil(maxX)));
    const bottom = Math.max(top, Math.min(height, Math.ceil(maxY)));
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
  let addedMesh: Observer<AbstractMesh> | null = null;
  let removedMesh: Observer<AbstractMesh> | null = null;
  // A full refresh walks every mesh. Clip assignments change only in
  // applyEditorLayoutClips and OverlayLayoutRenderer, which refresh explicitly.
  // What else decides which meshes need a hook is the mesh list and the parent
  // links the last refresh read. Babylon announces additions late and never
  // announces reparenting, so each frame compares the mesh count, the
  // added/removed flag and those links, and refreshes only when one differs.
  let dirty = true;
  let seenMeshCount = -1;
  let watchedNodes: Node[] = [];
  let watchedParents: (Node | null)[] = [];
  const refresh = () => {
    dirty = false;
    seenMeshCount = scene.meshes.length;
    const resolved = new Map<Node, OverlayLayoutRect | null>();
    const watched = new Map<Node, Node | null>();
    for (const [mesh, detach] of meshes) {
      if (!mesh.isDisposed() && watchedInheritedClip(mesh, resolved, watched)) continue;
      detach();
      meshes.delete(mesh);
    }
    for (const mesh of scene.meshes) {
      if (mesh instanceof Mesh && !meshes.has(mesh) && watchedInheritedClip(mesh, resolved, watched)) meshes.set(mesh, installClip(mesh));
    }
    watchedNodes = [...watched.keys()];
    watchedParents = [...watched.values()];
  };
  const stale = () => {
    if (dirty || seenMeshCount !== scene.meshes.length) return true;
    for (let index = 0; index < watchedNodes.length; index += 1) {
      if (watchedNodes[index]!.parent !== watchedParents[index]) return true;
    }
    return false;
  };
  const hooks = {
    owners: new Set([owner]),
    refresh,
    dispose: () => {
      scene.onBeforeRenderObservable.remove(beforeRender);
      scene.onDisposeObservable.remove(onDispose);
      scene.onNewMeshAddedObservable.remove(addedMesh);
      scene.onMeshRemovedObservable.remove(removedMesh);
      for (const detach of meshes.values()) detach();
      meshes.clear();
      watchedNodes = [];
      watchedParents = [];
      sceneClips.delete(scene);
    },
  };
  sceneClips.set(scene, hooks);
  addedMesh = scene.onNewMeshAddedObservable.add(() => { dirty = true; });
  removedMesh = scene.onMeshRemovedObservable.add(() => { dirty = true; });
  beforeRender = scene.onBeforeRenderObservable.add(() => { if (stale()) refresh(); });
  onDispose = scene.onDisposeObservable.addOnce(hooks.dispose);
  refresh();
}
export function applyEditorLayoutClips(scene: Scene, entries: ReadonlyMap<string, OverlayLayoutEntry>): void {
  // The first mesh of a name wins, like Scene.getMeshByName, without a scan per entry.
  const meshesByName = new Map<string, AbstractMesh>();
  for (const mesh of scene.meshes) {
    clips.delete(mesh); restoreVirtualMesh(mesh);
    if (entries.size > 0 && !meshesByName.has(mesh.name)) meshesByName.set(mesh.name, mesh);
  }
  for (const entry of entries.values()) {
    const name = `editorActor:${entry.actorId}${entry.componentId ? `|${entry.componentId}` : ""}`;
    const mesh = meshesByName.get(name);
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
