import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { isMesh, type SnapshotSceneBinding } from "./snapshot-binding";

function playMeshMetadata(mesh: Mesh): {
  playActorOrigin?: boolean;
  playHelperVisual?: boolean;
  playDebugOverlay?: boolean;
  playWireframeRestore?: boolean;
} | null {
  return mesh.metadata as {
    playActorOrigin?: boolean;
    playHelperVisual?: boolean;
    playDebugOverlay?: boolean;
    playWireframeRestore?: boolean;
  } | null;
}

function isPlayHelperVisual(mesh: Mesh): boolean {
  const meta = playMeshMetadata(mesh);
  return Boolean(meta?.playHelperVisual || meta?.playActorOrigin);
}

export function isPlayConsoleVizSkipMesh(mesh: Mesh): boolean {
  const meta = playMeshMetadata(mesh);
  return Boolean(
    meta?.playHelperVisual || meta?.playActorOrigin || meta?.playDebugOverlay,
  );
}

export function markPlayHelperVisual(mesh: Mesh): void {
  mesh.isVisible = false;
  mesh.isPickable = false;
  mesh.metadata = { ...(mesh.metadata ?? {}), playHelperVisual: true };
}

/** Last snapshot visibility applied to each slot root's visual tree. */
const appliedPlayVisibility = new WeakMap<Mesh, boolean>();

/** Last snapshot visibility applied to `mesh`, if it is a slot root that has had one. */
export function appliedPlayVisibilityOf(mesh: Mesh): boolean | undefined {
  return appliedPlayVisibility.get(mesh);
}

/** Slot roots are named `actor-<slot>`; part, glyph and chunk names never resolve to one. */
function isOtherSlotRoot(
  binding: SnapshotSceneBinding,
  root: Mesh,
  node: import("@babylonjs/core/node").Node,
): boolean {
  if (node === root || !node.name.startsWith("actor-")) return false;
  return binding.meshes.get(Number(node.name.slice("actor-".length))) === node;
}

/**
 * Babylon does not inherit `isVisible`, so a hidden actor hides every drawn
 * descendant: parts, glyphs, glTF meshes, tilemap chunks and sprite overlays.
 * Helpers and origins stay hidden. Particle emitters and other actors' roots
 * keep their own visibility. Unchanged values return without a tree walk.
 */
export function setPlayVisualVisibility(
  binding: SnapshotSceneBinding,
  mesh: Mesh,
  visible: boolean,
  force = false,
): void {
  if (!force && appliedPlayVisibility.get(mesh) === visible) return;
  appliedPlayVisibility.set(mesh, visible);
  mesh.isVisible = isPlayHelperVisual(mesh) ? false : visible;
  const pending = mesh.getChildren();
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (node.name.startsWith("particleEmitter:") || isOtherSlotRoot(binding, mesh, node)) continue;
    if (node instanceof AbstractMesh) {
      node.isVisible = isMesh(node) && isPlayHelperVisual(node) ? false : visible;
    }
    pending.push(...node.getChildren());
  }
}

/** `actor-N`, `actor-N-…` or `actor-N|…`, but never `actor-NM…`. */
function endsAtOverlayNameBoundary(name: string, end: number): boolean {
  if (name.length === end) return true;
  const next = name.charCodeAt(end);
  return next === 45 || next === 124;
}

function isWorldOverlayLeftoverName(name: string, prefix: string): boolean {
  return name.startsWith(prefix) && endsAtOverlayNameBoundary(name, prefix.length);
}

/** Drop world-Scene copies of an overlay slot so the perspective camera cannot draw them. */
export function disposeWorldOverlayLeftovers(
  worldScene: Scene,
  slotId: number,
): void {
  // Runs for every overlay actor on every applied snapshot, and almost always
  // matches nothing. Collect first: dispose splices scene.meshes and children.
  const prefix = `actor-${slotId}`;
  let leftovers: AbstractMesh[] | undefined;
  for (const mesh of worldScene.meshes) {
    if (isWorldOverlayLeftoverName(mesh.name, prefix)) (leftovers ??= []).push(mesh);
  }
  if (!leftovers) return;
  for (const mesh of leftovers) {
    if (!mesh.isDisposed()) mesh.dispose();
  }
}

/** Removals from a world Scene's mesh list, counted as Babylon's `removeMesh` reports them (synchronously). */
const meshRemovals = new WeakMap<Scene, { count: number }>();

function meshRemovalCounter(scene: Scene): { count: number } {
  let counter = meshRemovals.get(scene);
  if (!counter) {
    const created = { count: 0 };
    scene.onMeshRemovedObservable.add(() => { created.count++; });
    meshRemovals.set(scene, counter = created);
  }
  return counter;
}

/** What one owner's last world-leftover sweep saw: its overlay slots and the world Scene's mesh list. */
interface LeftoverSweep { scene: Scene; slots: Set<number>; meshCount: number; removals: number }
const leftoverSweeps = new WeakMap<object, LeftoverSweep>();

/**
 * {@link disposeWorldOverlayLeftoverSlots} for one applied snapshot of `owner` (its Play binding), run only when a
 * leftover can exist that the owner's last sweep did not already dispose. A leftover is a world mesh named for an
 * overlay slot, so one can appear only when a slot joins the overlay set, a visual moved between Scenes (`moved`),
 * or the world Scene gained a mesh. Babylon adds every mesh through `addMesh` and reports every removal at once, so
 * meshes gained since the last sweep are the change in length plus the removals since; a mesh is renamed only
 * right after it is added, so its addition already forces the sweep. A sweep that throws records nothing, so the next snapshot sweeps again.
 */
export function sweepWorldOverlayLeftoverSlots(
  owner: object,
  worldScene: Scene,
  slotIds: ReadonlySet<number>,
  moved: boolean,
): void {
  const removals = meshRemovalCounter(worldScene);
  const last = leftoverSweeps.get(owner);
  if (last?.scene === worldScene && !moved &&
    worldScene.meshes.length - last.meshCount + removals.count - last.removals <= 0) {
    let joined = false;
    for (const slotId of slotIds) {
      if (!last.slots.has(slotId)) { joined = true; break; }
    }
    if (!joined) return;
  }
  disposeWorldOverlayLeftoverSlots(worldScene, slotIds);
  const record = last?.scene === worldScene ? last : { scene: worldScene, slots: new Set<number>(), meshCount: 0, removals: 0 };
  record.slots.clear();
  for (const slotId of slotIds) record.slots.add(slotId);
  record.meshCount = worldScene.meshes.length;
  record.removals = removals.count;
  leftoverSweeps.set(owner, record);
}

/**
 * {@link disposeWorldOverlayLeftovers} for every overlay slot of one snapshot,
 * with a single pass over the world Scene's meshes instead of one per slot.
 */
function disposeWorldOverlayLeftoverSlots(
  worldScene: Scene,
  slotIds: ReadonlySet<number>,
): void {
  // Map order is slot order, so disposal order matches one call per slot.
  const leftovers = new Map<string, AbstractMesh[] | null>();
  let shortest = Infinity;
  let longest = 0;
  for (const slotId of slotIds) {
    const prefix = `actor-${slotId}`;
    leftovers.set(prefix, null);
    shortest = Math.min(shortest, prefix.length);
    longest = Math.max(longest, prefix.length);
  }
  for (const mesh of worldScene.meshes) {
    const name = mesh.name;
    if (name.length < shortest || !name.startsWith("actor-")) continue;
    // Only a prefix that ends at a name boundary can match, so look up those.
    for (let end = shortest, limit = Math.min(name.length, longest); end <= limit; end++) {
      if (!endsAtOverlayNameBoundary(name, end)) continue;
      const prefix = name.slice(0, end);
      const matched = leftovers.get(prefix);
      if (matched === undefined) continue;
      if (matched) matched.push(mesh);
      else leftovers.set(prefix, [mesh]);
      break;
    }
  }
  for (const matched of leftovers.values()) {
    if (!matched) continue;
    for (const mesh of matched) {
      if (!mesh.isDisposed()) mesh.dispose();
    }
  }
}
