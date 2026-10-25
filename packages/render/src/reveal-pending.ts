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
 * that has drawn) and, on WebGPU, whether its first draws' pipelines are known to exist; a world view's readiness round
 * (`revealRound`) reveals at its end, before the frame draws, only what no pass found unready and whose pipelines some
 * probe, or a lookup in the round (`noteRevealPipelines`), found. A mesh that has drawn with its Material is never
 * hidden again (`hasDrawn`): a later variant change hot-swaps it like any drawn mesh. A Play visual rebuilt in place of
 * one that had shown is marked (`noteReplacesDrawnVisual`) until it draws, so its reveal skips the wait for drawn
 * shadow maps to list it (`shadow-caster-warm.ts`).
 */
const pending = new WeakSet<AbstractMesh>();
/** Hidden meshes drawn only to create pipelines ahead (`hideForPipelineWarmup`): never revealed. */
const warmOnly = new WeakSet<AbstractMesh>();
/** Hidden meshes whose own variants are all ready: each waits for the rest of its actor. */
const ready = new WeakSet<AbstractMesh>();
/** Each hidden mesh's actor root, and each root's hidden meshes. */
const groupOf = new WeakMap<AbstractMesh, Node>();
const groups = new WeakMap<Node, Set<AbstractMesh>>();
/** The Material each mesh last drew with (a probe found it ready, or it was revealed). */
const drawnWith = new WeakMap<AbstractMesh, Material | null>();
/**
 * Meshes of a visual that took the place of a slot's visual that had drawn (`noteReplacesDrawnVisual`), until they draw
 * themselves (their reveal included). A disposed mesh's mark goes with it.
 */
const replacing = new WeakSet<AbstractMesh>();
const revealListeners = new WeakMap<Scene, Set<(mesh: AbstractMesh) => void>>();

/**
 * The readiness round in progress: hidden meshes some pass found ready, and those one found unready; of the first,
 * those a probe knew no pipelines for (WebGPU) and those whose pipelines a probe or a lookup found.
 */
let roundDepth = 0;
const seen = new Set<AbstractMesh>();
const blocked = new Set<AbstractMesh>();
const coldPipelines = new Set<AbstractMesh>();
const warmPipelines = new Set<AbstractMesh>();

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

/** Whether `mesh` exists only for warm draws ahead of a spawn (`hideForPipelineWarmup`): it is never revealed. */
export function isPipelineWarmupMesh(mesh: AbstractMesh): boolean {
  return warmOnly.has(mesh);
}

/** Whether `mesh` has drawn with its current Material: such a mesh is never hidden. */
export function hasDrawn(mesh: AbstractMesh): boolean {
  return drawnWith.has(mesh) && drawnWith.get(mesh) === (mesh.material ?? null);
}

/** A probe found `mesh` ready to draw with its current Material. */
export function noteDrawn(mesh: AbstractMesh): void {
  drawnWith.set(mesh, mesh.material ?? null);
  // A hidden mesh draws once revealed: a strict probe that finds it ready leaves it waiting for its round.
  if (!pending.has(mesh)) replacing.delete(mesh);
}

/**
 * Whether the visual at `root` has shown: some mesh of it drew, or is a replacement of a visual that had (a visual
 * rebuilt twice before a frame drew either). Asked before the visual is disposed.
 */
export function visualHasShown(root: AbstractMesh | undefined): boolean {
  if (!root) return false;
  for (const mesh of [root, ...root.getChildMeshes(false)]) if (drawnWith.has(mesh) || replacing.has(mesh)) return true;
  return false;
}

/**
 * The visual at `root` takes the place of a slot's visual that had shown (`visualHasShown`): a script's write rebuilt
 * it (a Text3D whose text changes every tick). Until each of its meshes draws, its reveal does not wait for the drawn
 * shadow maps it casts into to create its depth pipelines (`replacesDrawnVisual`): the slot held a caster already, and
 * a map's redraw with a caster new to it leaves out, holding nothing, a draw whose pipeline is missing.
 */
export function noteReplacesDrawnVisual(root: AbstractMesh): void {
  for (const mesh of [root, ...root.getChildMeshes(false)]) replacing.add(mesh);
}

/** Whether `mesh` belongs to a visual that replaced one that had shown, and has not drawn itself yet. */
export function replacesDrawnVisual(mesh: AbstractMesh): boolean {
  return replacing.has(mesh);
}

/**
 * Hides a mesh that exists only so warm draws create its pipelines ahead of a spawn (`spawnable-warm.ts` where
 * pipelines are deferred): every pass leaves it out like a hidden mesh, probes still ask it to warm, and it is never
 * revealed.
 */
export function hideForPipelineWarmup(mesh: AbstractMesh): void {
  warmOnly.add(mesh);
  pending.add(mesh);
}

export function hideUntilReady(mesh: AbstractMesh): void {
  if (warmOnly.has(mesh) || (pending.has(mesh) && groupOf.has(mesh))) return;
  pending.add(mesh);
  const root = actorRoot(mesh);
  groupOf.set(mesh, root);
  let members = groups.get(root);
  if (!members) groups.set(root, (members = new Set()));
  members.add(mesh);
}

/**
 * A pass probed a hidden mesh's variant for it, and whether its first draws' pipelines are known to exist
 * (`pipelinesWarm`; always where pipelines are not deferred). Inside a round the mesh is revealed at the round's end if
 * no pass found its variant unready and its pipelines were found by then: a probe that knew none does not hold it back
 * once a later probe, or a lookup ahead of its draws (`noteRevealPipelines`), found them. Outside a round this probe
 * decides alone.
 */
export function noteRevealProbe(mesh: AbstractMesh, isReady: boolean, pipelinesWarm = true): void {
  if (!pending.has(mesh) || warmOnly.has(mesh)) return;
  if (roundDepth > 0) {
    if (!isReady) blocked.add(mesh);
    else {
      seen.add(mesh);
      (pipelinesWarm ? warmPipelines : coldPipelines).add(mesh);
    }
    return;
  }
  if (!isReady || !pipelinesWarm) {
    ready.delete(mesh);
    return;
  }
  ready.add(mesh);
  const root = groupOf.get(mesh);
  if (root) revealIfReady(root);
}

/** Inside a readiness round, the pipelines a hidden mesh's first draws need were found to exist (`lookUpPipelines`). */
export function noteRevealPipelines(mesh: AbstractMesh): void {
  if (roundDepth > 0 && pending.has(mesh)) warmPipelines.add(mesh);
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
      for (const mesh of coldPipelines) if (!warmPipelines.has(mesh)) blocked.add(mesh);
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
      coldPipelines.clear();
      warmPipelines.clear();
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
