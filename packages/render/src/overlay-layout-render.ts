import { Matrix, Mesh, Quaternion, Vector3, type AbstractMesh, type Node, type Scene } from "@babylonjs/core";
import { overlayRectContains, type OverlayLayoutEntry, type OverlayLayoutRect } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";

type LayoutCommand = Extract<CommandMessage, { type: "sceneLayerLayout" }>;
const clips = new WeakMap<Node, OverlayLayoutRect | null>();
const installed = new WeakSet<Mesh>();
const sceneInstalled = new WeakSet<Scene>();
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
function installClip(mesh: Mesh): void {
  if (installed.has(mesh)) return;
  installed.add(mesh);
  let scissored = false;
  mesh.onBeforeBindObservable.add(() => {
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
  mesh.onAfterRenderObservable.add(() => { if (scissored) { mesh.getScene().getEngine().disableScissor(); scissored = false; } });
}
function installScene(scene: Scene): void {
  if (sceneInstalled.has(scene)) return;
  sceneInstalled.add(scene);
  scene.onBeforeRenderObservable.add(() => { for (const mesh of scene.meshes) if (mesh instanceof Mesh) installClip(mesh); });
}
export function applyEditorLayoutClips(scene: Scene, entries: ReadonlyMap<string, OverlayLayoutEntry>): void {
  installScene(scene);
  for (const mesh of scene.meshes) clips.delete(mesh);
  for (const entry of entries.values()) {
    const name = `editorActor:${entry.actorId}${entry.componentId ? `|${entry.componentId}` : ""}`;
    const mesh = scene.getMeshByName(name);
    if (mesh) clips.set(mesh, entry.clip);
  }
}

/** Retains layout independently from asynchronous visual replacement. */
export class OverlayLayoutRenderer {
  private readonly layers = new Map<string, LayoutCommand>();
  private readonly layerMeshes = new Map<string, Set<AbstractMesh>>();
  private readonly observers = new Map<Scene, ReturnType<Scene["onBeforeRenderObservable"]["add"]>>();
  constructor(private readonly sceneForLayer: (id: string) => Scene | undefined) {}
  apply(command: LayoutCommand): void {
    this.layers.set(command.layerId, command);
    const scene = this.sceneForLayer(command.layerId);
    if (!scene) return;
    installScene(scene);
    if (!this.observers.has(scene)) {
      this.observers.set(scene, scene.onBeforeRenderObservable.add(() => this.sync(command.layerId)));
      scene.onDisposeObservable.addOnce(() => this.observers.delete(scene));
    }
    this.sync(command.layerId);
  }
  private sync(layerId: string): void {
    const scene = this.sceneForLayer(layerId), command = this.layers.get(layerId);
    if (!scene || !command) return;
    // A reparented child may no longer occur in the new layout command.
    for (const mesh of this.layerMeshes.get(layerId) ?? []) clips.delete(mesh);
    const currentMeshes = new Set<AbstractMesh>();
    this.layerMeshes.set(layerId, currentMeshes);
    for (const entry of command.entries) {
      const mesh = scene.getMeshByName(`actor-${entry.slotId}${entry.componentId ? `|${entry.componentId}` : ""}`);
      if (!mesh) continue;
      clips.set(mesh, entry.clip);
      currentMeshes.add(mesh);
      if (entry.componentId && entry.transform) {
        mesh.unfreezeWorldMatrix();
        mesh.position.copyFromFloats(...entry.transform.position);
        mesh.rotationQuaternion ??= Quaternion.Identity();
        mesh.rotationQuaternion.copyFromFloats(...entry.transform.rotation);
        mesh.scaling.copyFromFloats(...entry.transform.scale);
      }
    }
  }
  scrollAt(layerId: string, x: number, y: number): OverlayLayoutEntry | undefined {
    const entries = this.layers.get(layerId)?.entries ?? [];
    return entries.filter(e => e.scroll && overlayRectContains(e.rect, x, y) && (!e.clip || overlayRectContains(e.clip, x, y)))
      .sort((a, b) => b.scrollAncestors.length - a.scrollAncestors.length)[0];
  }
  remove(layerId: string): void {
    this.layers.delete(layerId);
    for (const mesh of this.layerMeshes.get(layerId) ?? []) clips.delete(mesh);
    this.layerMeshes.delete(layerId);
  }
  dispose(): void {
    for (const [scene, observer] of this.observers) scene.onBeforeRenderObservable.remove(observer);
    this.observers.clear();
    for (const layerId of this.layers.keys()) this.remove(layerId);
  }
}
