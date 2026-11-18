import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { ISmartArrayLike } from "@babylonjs/core/Misc/smartArray";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Node } from "@babylonjs/core/node";
import type { Scene } from "@babylonjs/core/scene";
import { rewriteRenderList } from "./observed-render-list";
import { journalFollows, openRenderChangeReader, RenderChange, type RenderChangeReader } from "./render-change-journal";

/**
 * A Scene Layer's meshes that can draw, kept between frames: `scene.meshes` in its order, less the meshes that are
 * disabled or invisible (most of a HUD's meshes are actor roots, which draw nothing and are hidden, and disabled form
 * control parts). It is the input of Babylon's per-frame mesh loop (`getActiveMeshCandidates`) and of the camera's
 * cull (`ForwardSceneFrameGraph`'s scene objects), which both pass over a disabled or invisible mesh: the cull keeps
 * the same meshes in the same order. Babylon's loop also computes an enabled mesh's world matrix; one left out (an
 * invisible actor root) has it computed when a drawn descendant computes its own (`isSynchronized` reads the parent's
 * state and `getWorldMatrix` recomputes a parent not computed this render), and on any other read (`getWorldMatrix`,
 * `getAbsolutePosition`, `computeWorldMatrix`).
 *
 * What changes membership is heard, not compared each frame:
 * - Enabled and visibility writes, a re-parent included: the Scene's render change journal (`RenderChange.Enabled`,
 *   `RenderChange.Visibility`), which names every descendant an ancestor's write reaches. A mesh whose class or own
 *   object redefines those writes (`journalFollows` false) stays in the list whatever its state.
 * - Meshes added or removed: the Scene's add and remove observers, and the mesh count and newest mesh compared at each
 *   read, because Babylon announces an added mesh on a later task. `Scene.addMesh` appends and `removeMesh` splices, so
 *   these two numbers change with any membership change; nothing else reorders `scene.meshes`.
 *
 * Any change rebuilds the list from `scene.meshes` by index (`rewriteRenderList`, so a renderer observing it hears no
 * push). It is read where it is used: before each readiness admission, by the mesh loop after the before-render
 * observers, and by the cull. Every `FULL_CHECK_INTERVAL`th frame, and every frame while `verifyLayerDrawableMeshes`
 * is on, it is compared with the list a full filter builds: a difference in members or order is healed and counted.
 */

/** Every this many frames the list is compared with a full filter and healed. */
const FULL_CHECK_INTERVAL = 32;

/** How a layer's list was kept: rebuilds, full checks, and the differences they found and healed. */
export interface LayerDrawableMeshWork {
  /** The meshes in the list and in the Scene, as last read. */
  listed: number;
  meshes: number;
  rebuilds: number;
  checks: number;
  /** Checks that found another membership or order (healed). */
  mismatches: number;
  /** Members either list lacked, and members out of order, summed over those checks. */
  missingMembers: number;
  extraMembers: number;
  misordered: number;
}

let verifies = false;

/** Debugging aid: every frame the list is compared with a full filter of `scene.meshes`, and healed. */
export function verifyLayerDrawableMeshes(enabled: boolean): void {
  verifies = enabled;
}

class DrawableMeshes {
  readonly list: AbstractMesh[] = [];
  readonly candidates: ISmartArrayLike<AbstractMesh> = { data: this.list, length: 0 };
  readonly work: LayerDrawableMeshWork = {
    listed: 0, meshes: 0, rebuilds: 0, checks: 0, mismatches: 0, missingMembers: 0, extraMembers: 0, misordered: 0,
  };
  private readonly scene: Scene;
  private readonly members = new Set<AbstractMesh>();
  private readonly reader: RenderChangeReader;
  private readonly added: Observer<AbstractMesh>;
  private readonly removed: Observer<AbstractMesh>;
  private readonly restore: () => void;
  private dirty = true;
  private meshCount = -1;
  private newest: AbstractMesh | undefined;
  private checkFrame = -1;
  private sinceCheck = 0;
  private readonly scratch: AbstractMesh[] = [];

  constructor(scene: Scene) {
    this.scene = scene;
    this.reader = openRenderChangeReader(scene, RenderChange.Enabled | RenderChange.Visibility);
    this.added = scene.onNewMeshAddedObservable.add(() => { this.dirty = true; });
    this.removed = scene.onMeshRemovedObservable.add(() => { this.dirty = true; });
    const candidates = scene.getActiveMeshCandidates;
    scene.getActiveMeshCandidates = () => this.read();
    this.restore = () => { scene.getActiveMeshCandidates = candidates; };
  }

  /** The list as the Scene stands now. */
  read(): ISmartArrayLike<AbstractMesh> {
    const meshes = this.scene.meshes;
    if (meshes.length !== this.meshCount || meshes[meshes.length - 1] !== this.newest) this.dirty = true;
    if (!this.reader.drain(this.visit)) this.dirty = true;
    if (this.dirty) this.rebuild();
    const frame = this.scene.getEngine().frameId;
    if (frame !== this.checkFrame) {
      this.checkFrame = frame;
      if (verifies || ++this.sinceCheck >= FULL_CHECK_INTERVAL) {
        this.sinceCheck = 0;
        this.check();
      }
    }
    this.candidates.length = this.list.length;
    return this.candidates;
  }

  dispose(): void {
    this.reader.dispose();
    this.scene.onNewMeshAddedObservable.remove(this.added);
    this.scene.onMeshRemovedObservable.remove(this.removed);
    this.restore();
  }

  private readonly visit = (node: Node): void => {
    // A transform node is in no list: its writes reach the journal for each descendant they change.
    if (this.dirty || !(node instanceof AbstractMesh)) return;
    if (listed(node) !== this.members.has(node)) this.dirty = true;
  };

  private rebuild(): void {
    const meshes = this.scene.meshes;
    rewriteRenderList(this.list, meshes, listed);
    this.members.clear();
    for (const mesh of this.list) this.members.add(mesh);
    this.meshCount = meshes.length;
    this.newest = meshes[meshes.length - 1];
    this.dirty = false;
    this.work.rebuilds += 1;
    this.work.listed = this.list.length;
    this.work.meshes = meshes.length;
  }

  /** Compares the list with a full filter of the Scene's meshes; heals and counts a difference. */
  private check(): void {
    const full = this.scratch;
    full.length = 0;
    for (const mesh of this.scene.meshes) if (listed(mesh)) full.push(mesh);
    this.work.checks += 1;
    const list = this.list;
    let same = full.length === list.length;
    for (let index = 0; same && index < full.length; index += 1) if (full[index] !== list[index]) same = false;
    if (!same) {
      const fullSet = new Set(full);
      let missing = 0, extra = 0, misordered = 0;
      for (const mesh of full) if (!this.members.has(mesh)) missing += 1;
      for (const mesh of list) if (!fullSet.has(mesh)) extra += 1;
      // Members both hold, compared in the order each holds them.
      const sharedFull = full.filter((mesh) => this.members.has(mesh));
      const sharedList = list.filter((mesh) => fullSet.has(mesh));
      for (let index = 0; index < sharedFull.length; index += 1) if (sharedFull[index] !== sharedList[index]) misordered += 1;
      this.work.mismatches += 1;
      this.work.missingMembers += missing;
      this.work.extraMembers += extra;
      this.work.misordered += misordered;
      this.rebuild();
    }
    full.length = 0;
  }
}

/** Whether `mesh` can draw: enabled and visible, or its writes are not heard (it is kept whatever its state). */
function listed(mesh: AbstractMesh): boolean {
  return (mesh.isEnabled() && mesh.isVisible) || !journalFollows(mesh);
}

const lists = new WeakMap<Scene, DrawableMeshes>();

/**
 * Keeps `scene`'s drawable meshes from now on as its mesh loop's candidates and its renderer's cull input
 * (`layerDrawableMeshes`) until the Scene is disposed. For Scene Layers.
 */
export function keepLayerDrawableMeshes(scene: Scene): void {
  if (lists.has(scene)) return;
  const kept = new DrawableMeshes(scene);
  lists.set(scene, kept);
  scene.onDisposeObservable.addOnce(() => {
    kept.dispose();
    lists.delete(scene);
  });
}

/** `scene`'s drawable meshes as it stands now, in `scene.meshes` order; undefined for a Scene that keeps none. */
export function layerDrawableMeshes(scene: Scene): AbstractMesh[] | undefined {
  const kept = lists.get(scene);
  if (!kept) return undefined;
  kept.read();
  return kept.list;
}

/** A number that moves whenever `scene`'s list is rebuilt or healed (its members or order may differ); -1 without one. */
export function layerDrawableMeshRevision(scene: Scene): number {
  return lists.get(scene)?.work.rebuilds ?? -1;
}

/** How `scene`'s list was kept (`LayerDrawableMeshWork`), as a copy; null for a Scene that keeps none. */
export function layerDrawableMeshWork(scene: Scene): LayerDrawableMeshWork | null {
  const kept = lists.get(scene);
  return kept ? { ...kept.work } : null;
}
