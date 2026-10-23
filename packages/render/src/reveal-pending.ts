import type { AbstractMesh, Node, Scene } from "@babylonjs/core";

/**
 * Meshes a world view does not draw yet: each had no ready variant to draw (a spawned mesh, or one whose Material
 * changed) when a tolerant probe found its first variant still compiling (`isMeshFrameReady`). Every pass leaves it
 * out (the camera cull's output, shadow caster lists, outline masks, picking), so it never shows as a depth, shadow
 * or pick ghost and the frame never waits for it. Gameplay, physics and its own visibility flags are untouched. A
 * leaf module: probes, passes and the shadow controller read it without importing each other.
 *
 * A hidden mesh is revealed only once every variant it draws with is ready (colour, its transparent depth pre-pass,
 * its caster depth variant for every drawn shadow map: `markRevealReady`), and together with the other hidden meshes
 * of its actor, so an actor appears whole on one frame. Revealed, it draws something, so a later variant change
 * hot-swaps instead of hiding it again.
 */
const pending = new WeakSet<AbstractMesh>();
/** Hidden meshes whose own variants are all ready: each waits for the rest of its actor. */
const ready = new WeakSet<AbstractMesh>();
/** Each hidden mesh's actor root, and each root's hidden meshes. */
const groupOf = new WeakMap<AbstractMesh, Node>();
const groups = new WeakMap<Node, Set<AbstractMesh>>();
const revealListeners = new WeakMap<Scene, Set<(mesh: AbstractMesh) => void>>();

/** Play's actor roots (`actor-{slot}`) and the editor's (`EDITOR_ACTOR_MESH_PREFIX` in scene-loader.ts). */
const PLAY_ACTOR = /^actor-\d+$/;
const EDITOR_ACTOR_PREFIX = "editorActor:";

/** The nearest actor root above or at `mesh`; a mesh outside any actor is its own group. */
function actorRoot(mesh: AbstractMesh): Node {
  for (let node: Node | null = mesh; node; node = node.parent)
    if (PLAY_ACTOR.test(node.name) || node.name.startsWith(EDITOR_ACTOR_PREFIX)) return node;
  return mesh;
}

export function isRevealPending(mesh: AbstractMesh): boolean {
  return pending.has(mesh);
}

export function hideUntilReady(mesh: AbstractMesh): void {
  if (pending.has(mesh)) return;
  pending.add(mesh);
  const root = actorRoot(mesh);
  groupOf.set(mesh, root);
  let members = groups.get(root);
  if (!members) groups.set(root, (members = new Set()));
  members.add(mesh);
}

/**
 * Records whether every variant a hidden mesh draws with is ready now. Once each hidden mesh of its actor is (one no
 * probe asks, disabled or invisible, does not hold the rest back), they are all revealed: from this frame on every
 * pass draws them, and the Scene's listeners hear of each (its shadow maps redraw with it).
 */
export function markRevealReady(mesh: AbstractMesh, isReady: boolean): void {
  if (!pending.has(mesh)) return;
  if (!isReady) {
    ready.delete(mesh);
    return;
  }
  ready.add(mesh);
  const root = groupOf.get(mesh)!;
  const members = groups.get(root)!;
  for (const member of members) {
    if (member.isDisposed()) members.delete(member);
    else if (!ready.has(member) && member.isEnabled() && member.isVisible) return;
  }
  groups.delete(root);
  for (const member of members) {
    pending.delete(member);
    ready.delete(member);
    groupOf.delete(member);
    for (const listener of revealListeners.get(member.getScene()) ?? []) listener(member);
  }
}

export function onMeshRevealed(scene: Scene, listener: (mesh: AbstractMesh) => void): () => void {
  let listeners = revealListeners.get(scene);
  if (!listeners) revealListeners.set(scene, (listeners = new Set()));
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
