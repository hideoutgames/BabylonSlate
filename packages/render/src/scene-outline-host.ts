import { Material, type AbstractMesh, type InstancedMesh, type Mesh, type Scene } from "@babylonjs/core";
import type { OutlineBinding, SerializedScene } from "@babylonslate/core";
import { isColliderVisualTree } from "./collider-visual";
import { isSkyboxMesh } from "./skybox";
import { isViewportShadingTarget } from "./viewport-shading-mode";
import { sceneRenderingSettings } from "./render-settings";
import { SharedOutlineOwner, type SharedOutlineContribution, type SharedOutlineTarget, type SharedOutlineView } from "./shared-outline";
import type { SceneRenderCoordinator } from "./scene-render-coordinator";

type ActorOutline = { meshes: AbstractMesh[]; bindings: readonly OutlineBinding[] };

/** Outline authoring changes no geometry, illumination or authored effects. */
export function isOutlineOnlySceneEdit(previous: SerializedScene | null, next: SerializedScene): boolean {
  if (!previous) return false;
  const otherState = (scene: SerializedScene) => {
    const cel = { ...scene.settings.celShading };
    delete cel.outlinesEnabled; delete cel.outlineColor; delete cel.outlineWidth;
    delete cel.outlineDistanceFadeEnabled; delete cel.outlineFadeStart; delete cel.outlineFadeEnd;
    return { ...scene, settings: { ...scene.settings, celShading: cel }, actors: scene.actors.map((actor) => ({
      ...actor, components: actor.components.flatMap((component) => component.classId !== "OutlineComponent" ? [component]
        // A component can also be an attachment parent. Retain that structure
        // so its transform edits still revalidate baked geometry and assets.
        : actor.components.some((child) => child.parentId === component.id) ? [{ ...component, properties: {} }] : []),
    })) };
  };
  return previous === next || JSON.stringify(otherState(previous)) === JSON.stringify(otherState(next));
}
export interface SceneOutlineSelection {
  set(meshes: Iterable<AbstractMesh | null | undefined>): void;
  selected(): AbstractMesh[];
  clear(): void;
  dispose(): void;
}

/** One view's authored gameplay contributions and optional editor selection.
 * Actor keys group model parts and keep shared assets independently styled. */
export class SceneOutlineHost {
  readonly view: SharedOutlineView;
  readonly selection: SceneOutlineSelection;
  private actors = new Map<string, ActorOutline>();
  private selectedActors: string[] = [];
  private settingsKey = "";
  private disposed = false;
  private readonly detach: () => void;
  private readonly scene: Scene;
  private readonly invalidate: () => void;

  constructor(scene: Scene, renderer: SceneRenderCoordinator, invalidate: () => void) {
    this.scene = scene; this.invalidate = invalidate;
    this.view = SharedOutlineOwner.forScene(scene).createView("authored-world");
    this.detach = renderer.attachSharedOutline(this.view);
    this.selection = {
      set: (meshes) => {
        const chosen = new Set([...meshes].filter((mesh): mesh is AbstractMesh => !!mesh));
        this.setSelection([...this.actors].filter(([, actor]) => actor.meshes.some((mesh) => chosen.has(mesh))).map(([id]) => id));
      },
      selected: () => this.selectedActors.flatMap((id) => this.actors.get(id)?.meshes ?? []).filter((mesh) => !mesh.isDisposed()),
      clear: () => this.setSelection([]),
      dispose: () => this.setSelection([]),
    };
  }

  setActor(actorId: string, meshes: readonly AbstractMesh[], bindings: readonly OutlineBinding[], previousActorId?: string): void {
    if (this.disposed) return;
    const eligible = meshes.filter((mesh) => this.eligible(mesh));
    const actors = new Map(this.actors);
    if (previousActorId && previousActorId !== actorId) actors.delete(previousActorId);
    actors.set(actorId, { meshes: eligible, bindings });
    this.sync(actors);
  }

  replaceActors(actors: readonly { id: string; meshes: readonly AbstractMesh[]; bindings: readonly OutlineBinding[] }[]): void {
    if (this.disposed) return;
    this.sync(new Map(actors.map((actor) => [actor.id, { meshes: actor.meshes.filter((mesh) => this.eligible(mesh)), bindings: actor.bindings }])));
  }

  removeActor(actorId: string): void {
    if (this.disposed || !this.actors.has(actorId)) return;
    const actors = new Map(this.actors); actors.delete(actorId);
    this.sync(actors);
  }

  setSelection(actorIds: readonly string[]): void {
    if (this.disposed) return;
    this.sync(this.actors, [...actorIds]);
  }

  /** Scalar comparison only on unchanged frames; no membership scan/upload. */
  refreshSettings(): void {
    if (this.disposed) return;
    const { mode, cel } = sceneRenderingSettings(this.scene);
    const key = `${mode}|${cel.outlinesEnabled}|${cel.outlineWidth}|${cel.outlineColor.join(",")}|${cel.outlineDistanceFadeEnabled}|${cel.outlineFadeStart}|${cel.outlineFadeEnd}`;
    if (key === this.settingsKey) return;
    this.sync();
    this.settingsKey = key;
  }

  private eligible(mesh: AbstractMesh): boolean {
    if (mesh.isDisposed() || mesh.getScene() !== this.scene || mesh.getTotalVertices() === 0 ||
      isSkyboxMesh(mesh) || isColliderVisualTree(mesh)) return false;
    const source = mesh.isAnInstance ? (mesh as InstancedMesh).sourceMesh : mesh as Mesh;
    if (!isViewportShadingTarget(source)) return false;
    const fill = (mesh.material ?? this.scene.defaultMaterial).fillMode;
    return fill === Material.TriangleFillMode || fill === Material.TriangleStripDrawMode || fill === Material.TriangleFanDrawMode;
  }

  private sync(actors = this.actors, selectedActors = this.selectedActors): void {
    const revision = this.view.revision;
    const { mode, cel } = sceneRenderingSettings(this.scene);
    const targets: SharedOutlineTarget[] = [...actors].filter(([, actor]) => actor.meshes.length > 0)
      .map(([key, actor]) => ({ key, meshes: actor.meshes }));
    const contributions = new Map<string, SharedOutlineContribution>();
    if (mode === "cel" && cel.outlinesEnabled && targets.length) {
      contributions.set("global", { kind: "global", targets, color: cel.outlineColor, width: cel.outlineWidth, throughMeshes: false,
        distanceFade: cel.outlineDistanceFadeEnabled ? { start: cel.outlineFadeStart, end: cel.outlineFadeEnd } : undefined });
    }
    for (const [actorId, actor] of actors) for (const binding of actor.bindings) {
      if (!binding.enabled || !actor.meshes.length) continue;
      contributions.set(`component:${actorId}:${binding.id}`, {
        kind: "component", targets: [{ key: actorId, meshes: actor.meshes }],
        color: binding.color, width: binding.width, throughMeshes: binding.throughMeshes,
      });
    }
    const selected = targets.filter((target) => selectedActors.includes(target.key));
    if (selected.length) contributions.set("selection", { kind: "selection", targets: selected,
      color: [0.42, 0.78, 1], width: 1, throughMeshes: true });
    // Publish a complete validated snapshot before committing host state. A
    // rejected registration/capacity request preserves all previous consumers.
    this.view.replaceContributions(contributions, targets.flatMap((target) => target.meshes));
    this.actors = actors; this.selectedActors = selectedActors;
    if (revision !== this.view.revision) this.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach(); this.view.dispose(); this.actors.clear();
  }
  whenReleased(): Promise<void> { return this.view.owner.whenReleased(); }
}
