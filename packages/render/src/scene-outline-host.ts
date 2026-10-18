import { Material, type AbstractMesh, type InstancedMesh, type Mesh, type Scene } from "@babylonjs/core";
import type { CelShadingSettings, OutlineBinding, RenderMode, SerializedActor, SerializedScene } from "@babylonslate/core";
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
  if (previous === next) return true;
  if (previous.actors.length !== next.actors.length) return false;
  const actorState = (actor: SerializedActor) => JSON.stringify({
    ...actor, components: actor.components.flatMap((component) => component.classId !== "OutlineComponent" ? [component]
      // A component can also be an attachment parent. Retain that structure
      // so its transform edits still update child geometry and assets.
      : actor.components.some((child) => child.parentId === component.id) ? [{ ...component, properties: {} }] : []),
  });
  // Immutable scene edits keep untouched actors' identity, so only replaced
  // actors are serialized. The placeholder keeps the actors key in place.
  for (let index = 0; index < next.actors.length; index++) {
    const before = previous.actors[index]!;
    const after = next.actors[index]!;
    if (before !== after && actorState(before) !== actorState(after)) return false;
  }
  const otherState = (scene: SerializedScene) => {
    const cel = { ...scene.settings.celShading };
    delete cel.outlinesEnabled; delete cel.outlineColor; delete cel.outlineWidth;
    delete cel.outlineDistanceFadeEnabled; delete cel.outlineFadeStart; delete cel.outlineFadeEnd;
    return JSON.stringify({ ...scene, settings: { ...scene.settings, celShading: cel }, actors: null });
  };
  return otherState(previous) === otherState(next);
}
export interface SceneOutlineSelection {
  set(meshes: Iterable<AbstractMesh | null | undefined>): void;
  selected(): AbstractMesh[];
  clear(): void;
  dispose(): void;
}

/** One view's authored gameplay contributions and optional editor selection.
 * Actor keys group model parts and keep shared assets independently styled. */
/** One Full Quality capture's outline view: its graph detach and the meshes it may outline. */
type CaptureView = { detach: () => void; includes: (mesh: AbstractMesh) => boolean };

export class SceneOutlineHost {
  readonly view: SharedOutlineView;
  readonly selection: SceneOutlineSelection;
  private actors = new Map<string, ActorOutline>();
  private selectedActors: string[] = [];
  private settingsKey = "";
  private settingsMode: RenderMode | undefined;
  private settingsCel: CelShadingSettings | undefined;
  private disposed = false;
  private readonly detach: () => void;
  private readonly scene: Scene;
  private readonly invalidate: () => void;
  /** Full Quality capture views: the gameplay contributions, never the selection. */
  private readonly captureViews = new Map<SharedOutlineView, CaptureView>();
  private captureViewCount = 0;
  private gameplay: ReadonlyMap<string, SharedOutlineContribution> = new Map();
  private occluders: AbstractMesh[] = [];

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
    // Settings updates replace the resolved CEL object; they never mutate it.
    if (mode === this.settingsMode && cel === this.settingsCel) return;
    const key = `${mode}|${cel.outlinesEnabled}|${cel.outlineWidth}|${cel.outlineColor.join(",")}|${cel.outlineDistanceFadeEnabled}|${cel.outlineFadeStart}|${cel.outlineFadeEnd}`;
    if (key !== this.settingsKey) {
      this.sync();
      this.settingsKey = key;
    }
    this.settingsMode = mode; this.settingsCel = cel;
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
    const selectedKeys = new Set(selectedActors);
    const selected = targets.filter((target) => selectedKeys.has(target.key));
    if (selected.length) contributions.set("selection", { kind: "selection", targets: selected,
      color: [0.42, 0.78, 1], width: 1, throughMeshes: true });
    // Publish a complete validated snapshot before committing host state. A
    // rejected registration/capacity request preserves all previous consumers.
    const occluders = targets.flatMap((target) => target.meshes);
    this.view.replaceContributions(contributions, occluders);
    this.actors = actors; this.selectedActors = selectedActors;
    contributions.delete("selection");
    this.gameplay = contributions;
    this.occluders = occluders;
    for (const [view, capture] of this.captureViews) this.publishCaptureView(view, capture);
    if (revision !== this.view.revision) this.invalidate();
  }

  /**
   * A Full Quality capture's view of the scene's gameplay outlines (Outline
   * components and CEL outlines); the editor selection never reaches it. Only
   * meshes `includes` accepts are outlined or occlude outlines: a capture of
   * chosen actors draws no other. `refresh` republishes after `includes`
   * changes; `detach` also disposes the view.
   */
  attachCaptureView(renderer: SceneRenderCoordinator, includes: (mesh: AbstractMesh) => boolean = () => true):
    { refresh(): void; detach(): void } {
    if (this.disposed) return { refresh() {}, detach() {} };
    const view = SharedOutlineOwner.forScene(this.scene).createView(`capture:${++this.captureViewCount}`);
    let detach: () => void;
    try {
      detach = renderer.attachSharedOutline(view);
    } catch (error) {
      view.dispose();
      throw error;
    }
    const capture: CaptureView = { detach, includes };
    this.captureViews.set(view, capture);
    this.publishCaptureView(view, capture);
    return {
      refresh: () => { if (this.captureViews.get(view) === capture) this.publishCaptureView(view, capture); },
      detach: () => {
        if (!this.captureViews.delete(view)) return;
        detach();
        view.dispose();
      },
    };
  }

  /** A capture view that cannot take the snapshot keeps its previous outlines; the scene view is unaffected. */
  private publishCaptureView(view: SharedOutlineView, capture: CaptureView): void {
    const contributions = new Map<string, SharedOutlineContribution>();
    for (const [key, contribution] of this.gameplay) {
      const targets = contribution.targets
        .map((target) => ({ key: target.key, meshes: target.meshes.filter(capture.includes) }))
        .filter((target) => target.meshes.length > 0);
      if (targets.length) contributions.set(key, { ...contribution, targets });
    }
    try { view.replaceContributions(contributions, this.occluders.filter(capture.includes)); }
    catch (error) { console.warn(`[render] Capture outlines kept their previous state: ${String(error)}`); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [view, { detach }] of this.captureViews) { detach(); view.dispose(); }
    this.captureViews.clear();
    this.detach(); this.view.dispose(); this.actors.clear();
  }
  whenReleased(): Promise<void> { return this.view.owner.whenReleased(); }
}
