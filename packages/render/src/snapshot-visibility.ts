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

type VisualNode = import("@babylonjs/core/node").Node;
/** Each component part's mesh in a Play visual, and the ones Set Visibility turned off. */
const componentPartRoots = new WeakSet<VisualNode>();
const hiddenComponentParts = new WeakSet<VisualNode>();

/**
 * Record a visual's component parts and which of them are hidden, then hide what those draw now. A
 * hidden part keeps its place, so attached components still follow it, and they keep their own visibility.
 */
export function rememberComponentPartVisibility(parts: ReadonlyMap<string, Mesh>, hidden: ReadonlySet<string>): void {
  for (const [componentId, mesh] of parts) {
    componentPartRoots.add(mesh);
    if (hidden.has(componentId)) hiddenComponentParts.add(mesh);
    else hiddenComponentParts.delete(mesh);
  }
  for (const componentId of hidden) {
    const part = parts.get(componentId);
    if (!part) continue;
    const pending: VisualNode[] = [part];
    for (let node = pending.pop(); node; node = pending.pop()) {
      if (node !== part && componentPartRoots.has(node)) continue;
      if (node instanceof AbstractMesh) node.isVisible = false;
      pending.push(...node.getChildren());
    }
  }
}

/** True when `node` draws for a component part Set Visibility turned off: its nearest part is hidden. */
function inHiddenComponentPart(node: VisualNode): boolean {
  for (let current: VisualNode | null = node; current; current = current.parent) {
    if (componentPartRoots.has(current)) return hiddenComponentParts.has(current);
  }
  return false;
}

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
  mesh.isVisible = isPlayHelperVisual(mesh) || inHiddenComponentPart(mesh) ? false : visible;
  const pending = mesh.getChildren();
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (node.name.startsWith("particleEmitter:") || isOtherSlotRoot(binding, mesh, node)) continue;
    if (node instanceof AbstractMesh) {
      node.isVisible = (isMesh(node) && isPlayHelperVisual(node)) || (visible && inHiddenComponentPart(node)) ? false : visible;
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
  // Runs when a layer binds the slot or an overlay assignment lands, and almost
  // always matches nothing. Collect first: dispose splices scene.meshes and children.
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

/**
 * Meshes added to each world Scene, counted by one observer per Scene from its first sweep on. Babylon notifies
 * additions on a timer, so the count only backs up the synchronous mesh count and newest mesh.
 */
const worldMeshAdditions = new WeakMap<Scene, { count: number }>();

function meshAdditions(scene: Scene): { count: number } {
  let additions = worldMeshAdditions.get(scene);
  if (!additions) {
    const counter = { count: 0 };
    scene.onNewMeshAddedObservable.add(() => { counter.count++; });
    worldMeshAdditions.set(scene, additions = counter);
  }
  return additions;
}

/** What each binding's last overlay leftover sweep saw: its world Scene and overlay slots, and the Scene's meshes. */
type OverlaySweep = { scene: Scene; slots: Set<number>; meshCount: number; newestMesh: AbstractMesh | undefined; added: number };
const overlaySweeps = new WeakMap<SnapshotSceneBinding, OverlaySweep>();

/**
 * {@link disposeWorldOverlayLeftoverSlots} for one applied snapshot, run only when it can find something. A leftover
 * is a world mesh named for an overlay slot; names are set at construction, so one can appear only when a slot joins
 * the overlay slots or the world Scene gains a mesh. The sweep therefore runs when the overlay slots differ from the
 * last sweep's; when the world Scene's mesh count or newest mesh changed since (a mesh added since is the newest
 * unless removed again, as meshes are appended) or it notified an addition; and when `force` (the pass moved or hid a
 * visual, or stopped part way).
 */
export function sweepWorldOverlayLeftovers(
  worldScene: Scene,
  binding: SnapshotSceneBinding,
  slotIds: ReadonlySet<number> | undefined,
  force: boolean,
): void {
  if (!slotIds) {
    // Without overlay slots there is nothing to sweep; the next overlay slot sweeps again.
    overlaySweeps.delete(binding);
    return;
  }
  const additions = meshAdditions(worldScene);
  const meshes = worldScene.meshes;
  const last = overlaySweeps.get(binding);
  let due = force || !last || last.scene !== worldScene || last.meshCount !== meshes.length ||
    last.newestMesh !== meshes.at(-1) || last.added !== additions.count || last.slots.size !== slotIds.size;
  if (!due) for (const slotId of slotIds) if (!last!.slots.has(slotId)) { due = true; break; }
  if (!due) return;
  overlaySweeps.delete(binding);
  const added = additions.count;
  disposeWorldOverlayLeftoverSlots(worldScene, slotIds);
  overlaySweeps.set(binding, { scene: worldScene, slots: new Set(slotIds), meshCount: meshes.length, newestMesh: meshes.at(-1), added });
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
