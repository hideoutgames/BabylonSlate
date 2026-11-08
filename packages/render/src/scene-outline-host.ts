import { Material } from "@babylonjs/core/Materials/material";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { CelShadingSettings, OutlineBinding, RenderMode, SerializedActor, SerializedScene } from "@haptic/core";
import { isColliderVisualTree } from "./collider-visual";
import { isSkyboxMesh } from "./skybox";
import { isViewportShadingTarget } from "./viewport-shading-mode";
import { sceneRenderingSettings } from "./render-settings";
import { SELECTION_COLOR } from "./selection-style";
import { SharedOutlineOwner, type SharedOutlineContribution, type SharedOutlineTarget, type SharedOutlineView } from "./shared-outline";
import type { SceneRenderCoordinator } from "./scene-render-coordinator";

type ActorOutline = { meshes: AbstractMesh[]; bindings: readonly OutlineBinding[] };

/** Whether an enabled Outline component outlines the actor's meshes. */
function outlinesActor(actor: ActorOutline): boolean {
  return actor.meshes.length > 0 && actor.bindings.some((binding) => binding.enabled);
}

/** Whether an enabled Outline component outlines some actor's meshes. */
function hasOutlineBinding(actors: ReadonlyMap<string, ActorOutline>): boolean {
  for (const actor of actors.values()) if (outlinesActor(actor)) return true;
  return false;
}

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
/** One High or Full Quality capture's outline view: its graph detach and the meshes it may outline. */
type CaptureView = { detach: () => void; includes: (mesh: AbstractMesh) => boolean };
/** The setActor and removeActor calls a batch recorded, applied in order to a copy of the actors and published at its end. */
type PendingActors = {
  actors: Map<string, ActorOutline>;
  /** Each call as it runs without a batch, replayed one publish each when the batched publish is refused. */
  calls: (() => void)[];
  /** Keys a call made outline targets before any publish identified them, in call order (`SharedOutlineOwner.identify`). */
  identify: Set<string>;
};

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
  /** High and Full Quality capture views: the gameplay contributions, never the selection. */
  private readonly captureViews = new Map<SharedOutlineView, CaptureView>();
  private captureViewCount = 0;
  private gameplay: ReadonlyMap<string, SharedOutlineContribution> = new Map();
  private occluders: AbstractMesh[] = [];
  /** Nothing is outlined, and the views already hold no contributions or occluders. */
  private idle = false;
  /** Open `batch` calls, and the calls they recorded; only a batch holds pending calls. */
  private batching = 0;
  private pending: PendingActors | null = null;

  constructor(scene: Scene, renderer: SceneRenderCoordinator, invalidate: () => void) {
    this.scene = scene; this.invalidate = invalidate;
    this.view = SharedOutlineOwner.forScene(scene).createView("authored-world");
    this.detach = renderer.attachSharedOutline(this.view);
    this.selection = {
      set: (meshes) => {
        this.flush();
        const chosen = new Set([...meshes].filter((mesh): mesh is AbstractMesh => !!mesh));
        this.setSelection([...this.actors].filter(([, actor]) => actor.meshes.some((mesh) => chosen.has(mesh))).map(([id]) => id));
      },
      selected: () => {
        this.flush();
        return this.selectedActors.flatMap((id) => this.actors.get(id)?.meshes ?? []).filter((mesh) => !mesh.isDisposed());
      },
      clear: () => this.setSelection([]),
      dispose: () => this.setSelection([]),
    };
  }

  /**
   * Runs `apply` (one Play snapshot apply) with its setActor and removeActor calls published once, at its end, as one
   * validated snapshot instead of once each. Identities, the published state and a refused call come out as separate
   * publishes would leave them; any other host call publishes the recorded calls first.
   */
  batch(apply: () => void): void {
    this.batching++;
    try { apply(); }
    finally { if (--this.batching === 0) this.flush(); }
  }

  setActor(actorId: string, meshes: readonly AbstractMesh[], bindings: readonly OutlineBinding[], previousActorId?: string): void {
    if (this.disposed) return;
    const actor = { meshes: meshes.filter((mesh) => this.eligible(mesh)), bindings };
    if (this.pending || (this.batching && !this.staysIdle(actor))) this.recordSetActor(actorId, actor, previousActorId);
    else this.applySetActor(actorId, actor, previousActorId);
  }

  private applySetActor(actorId: string, actor: ActorOutline, previousActorId?: string): void {
    const actors = this.staysIdle(actor) ? this.actors : new Map(this.actors);
    if (previousActorId && previousActorId !== actorId) actors.delete(previousActorId);
    actors.set(actorId, actor);
    if (actors !== this.actors) this.sync(actors);
  }

  private recordSetActor(actorId: string, actor: ActorOutline, previousActorId?: string): void {
    const identifies = this.identifiesFirst(actorId, actor);
    if (identifies && this.view.owner.identityRoom <= (this.pending?.identify.size ?? 0)) {
      // Its own publish is refused for capacity: publish the calls before it, then refuse it where it would have been.
      this.flush();
      this.applySetActor(actorId, actor, previousActorId);
      return;
    }
    const pending = this.pendingActors();
    if (previousActorId && previousActorId !== actorId) pending.actors.delete(previousActorId);
    pending.actors.set(actorId, actor);
    if (identifies) pending.identify.add(actorId);
    pending.calls.push(() => this.applySetActor(actorId, actor, previousActorId));
  }

  /**
   * Whether a publish of this call alone would identify `actorId`: it makes the actor an outline target (CEL outlines,
   * an enabled Outline component or the selection, with meshes) before any publish identified its key.
   */
  private identifiesFirst(actorId: string, actor: ActorOutline): boolean {
    if (!actor.meshes.length || this.view.owner.identityForKey(actorId) !== 0 || this.pending?.identify.has(actorId)) return false;
    if (outlinesActor(actor) || this.selectedActors.includes(actorId)) return true;
    const { mode, cel } = sceneRenderingSettings(this.scene);
    return mode === "cel" && cel.outlinesEnabled;
  }

  private pendingActors(): PendingActors {
    return this.pending ??= { actors: new Map(this.actors), calls: [], identify: new Set() };
  }

  /**
   * Publishes the calls a batch recorded: once, or, when that publish is refused, one publish per call as without a
   * batch, so the calls before the first refused one keep their outlines and its refusal is what the batch throws.
   */
  private flush(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    const owner = this.view.owner;
    let identified: string[] = [];
    try {
      identified = owner.identify(pending.identify);
      this.sync(pending.actors);
    } catch {
      owner.forget(identified);
      let refusal: { error: unknown } | undefined;
      for (const call of pending.calls) {
        try { call(); } catch (error) { refusal ??= { error }; }
      }
      if (refusal) throw refusal.error;
    }
  }

  replaceActors(actors: readonly { id: string; meshes: readonly AbstractMesh[]; bindings: readonly OutlineBinding[] }[]): void {
    if (this.disposed) return;
    this.flush();
    this.sync(new Map(actors.map((actor) => [actor.id, { meshes: actor.meshes.filter((mesh) => this.eligible(mesh)), bindings: actor.bindings }])));
  }

  removeActor(actorId: string): void {
    if (this.disposed || !(this.pending?.actors ?? this.actors).has(actorId)) return;
    if (this.pending || (this.batching && !this.staysIdle())) {
      const pending = this.pendingActors();
      pending.actors.delete(actorId);
      pending.calls.push(() => this.applyRemoveActor(actorId));
    } else this.applyRemoveActor(actorId);
  }

  private applyRemoveActor(actorId: string): void {
    if (!this.actors.has(actorId)) return;
    if (this.staysIdle()) { this.actors.delete(actorId); return; }
    const actors = new Map(this.actors); actors.delete(actorId);
    this.sync(actors);
  }

  setSelection(actorIds: readonly string[]): void {
    if (this.disposed) return;
    this.flush();
    this.sync(this.actors, [...actorIds]);
  }

  /** Scalar comparison only on unchanged frames; no membership scan/upload. */
  refreshSettings(): void {
    if (this.disposed) return;
    this.flush();
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

  /**
   * Whether the host is idle and stays idle with `actor` added: nothing is outlined before or after (CEL read live,
   * as `sync` does), so membership changes in place with no snapshot to validate first. Leaving idle always syncs.
   */
  private staysIdle(actor?: ActorOutline): boolean {
    if (!this.idle || this.selectedActors.length || (actor && outlinesActor(actor))) return false;
    const { mode, cel } = sceneRenderingSettings(this.scene);
    return !(mode === "cel" && cel.outlinesEnabled);
  }

  private sync(actors = this.actors, selectedActors = this.selectedActors): void {
    const revision = this.view.revision;
    const { mode, cel } = sceneRenderingSettings(this.scene);
    // With nothing to outline (no CEL outlines, enabled Outline component or selection) occluders matter to no view,
    // so a Play spawn or visual change only records membership; the first outline publishes it all again.
    if (!(mode === "cel" && cel.outlinesEnabled) && !selectedActors.length && !hasOutlineBinding(actors)) {
      if (!this.idle) this.view.replaceContributions(new Map(), []);
      this.actors = actors; this.selectedActors = selectedActors;
      if (!this.idle) {
        this.idle = true;
        this.gameplay = new Map();
        this.occluders = [];
        for (const [view, capture] of this.captureViews) this.publishCaptureView(view, capture);
        if (revision !== this.view.revision) this.invalidate();
      }
      return;
    }
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
      color: [SELECTION_COLOR.r, SELECTION_COLOR.g, SELECTION_COLOR.b], width: 1, throughMeshes: true });
    // Publish a complete validated snapshot before committing host state. A
    // rejected registration/capacity request preserves all previous consumers.
    const occluders = targets.flatMap((target) => target.meshes);
    this.view.replaceContributions(contributions, occluders);
    this.actors = actors; this.selectedActors = selectedActors;
    this.idle = false;
    contributions.delete("selection");
    this.gameplay = contributions;
    this.occluders = occluders;
    for (const [view, capture] of this.captureViews) this.publishCaptureView(view, capture);
    if (revision !== this.view.revision) this.invalidate();
  }

  /**
   * A High or Full Quality capture's view of the scene's gameplay outlines (Outline
   * components and CEL outlines); the editor selection never reaches it. Only
   * meshes `includes` accepts are outlined or occlude outlines: a capture of
   * chosen actors draws no other. `refresh` republishes after `includes`
   * changes; `detach` also disposes the view.
   */
  attachCaptureView(renderer: SceneRenderCoordinator, includes: (mesh: AbstractMesh) => boolean = () => true):
    { refresh(): void; detach(): void } {
    if (this.disposed) return { refresh() {}, detach() {} };
    this.flush();
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
      refresh: () => {
        if (this.captureViews.get(view) !== capture) return;
        this.flush();
        this.publishCaptureView(view, capture);
      },
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
    this.pending = null;
    for (const [view, { detach }] of this.captureViews) { detach(); view.dispose(); }
    this.captureViews.clear();
    this.detach(); this.view.dispose(); this.actors.clear();
  }
  whenReleased(): Promise<void> { return this.view.owner.whenReleased(); }
}
