import type { AbstractMesh, Material, Node, Scene } from "@babylonjs/core";

/**
 * Meshes a world view does not draw yet: each had nothing to draw (a spawned mesh, or one whose Material changed)
 * when a tolerant probe found its first variant still compiling (`isMeshFrameReady`). Every pass leaves it out (the
 * camera cull's output, shadow caster lists, outline masks, picking), so it never shows as a depth, shadow or pick
 * ghost and the frame never waits for it. Gameplay, physics and its own visibility flags are untouched. A leaf
 * module: probes, passes and the shadow controller read it without importing each other.
 *
 * A hidden mesh is revealed once every variant it draws with is ready, together with the other hidden meshes of its
 * actor, so an actor appears whole on one frame. Each pass's probe notes its own variant (`noteRevealProbe`: colour,
 * transparent depth pre-pass, geometry buffers, and in the colour probe the caster depth variant for every shadow map
 * that has drawn); a world view's readiness round (`revealRound`) reveals at its end, before the frame draws, only
 * what no pass found unready. A mesh that has drawn with its Material is never hidden again (`hasDrawn`): a later
 * variant change hot-swaps it like any drawn mesh.
 */
const pending = new WeakSet<AbstractMesh>();
/** Hidden meshes whose own variants are all ready: each waits for the rest of its actor. */
const ready = new WeakSet<AbstractMesh>();
/** Each hidden mesh's actor root, and each root's hidden meshes. */
const groupOf = new WeakMap<AbstractMesh, Node>();
const groups = new WeakMap<Node, Set<AbstractMesh>>();
/** The Material each mesh last drew with (a probe found it ready, or it was revealed). */
const drawnWith = new WeakMap<AbstractMesh, Material | null>();
const revealListeners = new WeakMap<Scene, Set<(mesh: AbstractMesh) => void>>();

/** The readiness round in progress: hidden meshes some pass found ready, and those one found unready. */
let roundDepth = 0;
const seen = new Set<AbstractMesh>();
const blocked = new Set<AbstractMesh>();

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

/** Whether `mesh` has drawn with its current Material: such a mesh is never hidden. */
export function hasDrawn(mesh: AbstractMesh): boolean {
  return drawnWith.has(mesh) && drawnWith.get(mesh) === (mesh.material ?? null);
}

/** A probe found `mesh` ready to draw with its current Material. */
export function noteDrawn(mesh: AbstractMesh): void {
  drawnWith.set(mesh, mesh.material ?? null);
}

export function hideUntilReady(mesh: AbstractMesh): void {
  if (pending.has(mesh) && groupOf.has(mesh)) return;
  pending.add(mesh);
  const root = actorRoot(mesh);
  groupOf.set(mesh, root);
  let members = groups.get(root);
  if (!members) groups.set(root, (members = new Set()));
  members.add(mesh);
}

/**
 * A pass probed a hidden mesh's variant for it. Inside a round the mesh is revealed at the round's end if no pass
 * found its variant unready; outside one this probe decides alone.
 */
export function noteRevealProbe(mesh: AbstractMesh, isReady: boolean): void {
  if (!pending.has(mesh)) return;
  if (roundDepth > 0) {
    (isReady ? seen : blocked).add(mesh);
    return;
  }
  if (!isReady) {
    ready.delete(mesh);
    return;
  }
  ready.add(mesh);
  const root = groupOf.get(mesh);
  if (root) revealIfReady(root);
}

/** A hidden mesh whose variant failed to compile stays hidden, and no longer holds back the rest of its actor. */
export function noteRevealFailed(mesh: AbstractMesh): void {
  const root = groupOf.get(mesh);
  if (!root) return;
  groupOf.delete(mesh);
  ready.delete(mesh);
  const members = groups.get(root);
  members?.delete(mesh);
  // Inside a round its end reveals the rest.
  if (members && roundDepth === 0) revealIfReady(root);
}

/**
 * A world view's readiness round: `probe` asks each pass; when it passes, each hidden mesh some pass found ready and
 * none found unready is ready, and every actor whose hidden meshes are all ready is revealed before the frame draws.
 */
export function revealRound(probe: () => boolean): boolean {
  roundDepth += 1;
  let passed = false;
  try {
    passed = probe();
    return passed;
  } finally {
    roundDepth -= 1;
    if (roundDepth === 0) {
      for (const mesh of blocked) ready.delete(mesh);
      if (passed) {
        const roots = new Set<Node>();
        for (const mesh of seen) {
          if (blocked.has(mesh) || !pending.has(mesh)) continue;
          ready.add(mesh);
          const root = groupOf.get(mesh);
          if (root) roots.add(root);
        }
        for (const root of roots) revealIfReady(root);
      }
      seen.clear();
      blocked.clear();
    }
  }
}

/**
 * Reveals the hidden meshes of the actor at `root` once each one a probe can draw (enabled and visible) is ready: from
 * this frame on every pass draws them, and the Scene's listeners hear of each (its shadow maps redraw with it). A
 * disabled or invisible one that is not ready stays hidden until it is.
 */
function revealIfReady(root: Node): void {
  const members = groups.get(root);
  if (!members) return;
  for (const member of members) {
    if (member.isDisposed()) members.delete(member);
    else if (!ready.has(member) && member.isEnabled() && member.isVisible) return;
  }
  for (const member of [...members]) {
    if (!ready.has(member)) continue;
    members.delete(member);
    pending.delete(member);
    ready.delete(member);
    groupOf.delete(member);
    noteDrawn(member);
    for (const listener of revealListeners.get(member.getScene()) ?? []) listener(member);
  }
  if (!members.size) groups.delete(root);
}

export function onMeshRevealed(scene: Scene, listener: (mesh: AbstractMesh) => void): () => void {
  let listeners = revealListeners.get(scene);
  if (!listeners) revealListeners.set(scene, (listeners = new Set()));
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
