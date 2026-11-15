import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { CommandMessage } from "@haptic/bridge";
import { viewOfBox, type BoxView } from "./active-view";

type AnimStateCommand = Extract<CommandMessage, { type: "animState" }>;

/** What the gate reads of the Play binding: each slot's root mesh, its latest state and whether it casts shadows. */
export interface AnimVisibilityBinding {
  meshes: ReadonlyMap<number, AbstractMesh>;
  pendingAnimState?: ReadonlyMap<number, AnimStateCommand>;
  meshSorting: ReadonlyMap<number, { castShadows?: boolean }>;
}

/** Room for limbs a pose reaches past the bind-pose bounds. */
const POSE_MARGIN = 1.25;
/** A shadow caster counts as seen this many of its radii away, so a shadow falling into view is posed. */
const SHADOW_REACH = 3;

/** An actor's bounds as a sphere around its root, in the root's own units: rotation-proof, scaled at test time. */
interface ActorSphere {
  radius: number;
}

const spheres = new WeakMap<AbstractMesh, ActorSphere>();
const view: BoxView = { visible: false, distance: 0 };

/**
 * The root's visual bounds as a sphere about its origin, measured once its meshes have bounds; null before (a model
 * still loading), which counts as seen.
 */
function actorSphere(root: AbstractMesh): ActorSphere | null {
  const known = spheres.get(root);
  if (known) return known;
  const { min, max } = root.getHierarchyBoundingVectors(true);
  if (!(max.x >= min.x) || !Number.isFinite(max.x - min.x)) return null;
  const origin = root.getAbsolutePosition();
  const cx = (min.x + max.x) / 2 - origin.x;
  const cy = (min.y + max.y) / 2 - origin.y;
  const cz = (min.z + max.z) / 2 - origin.z;
  const half = Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2;
  const scale = root.absoluteScaling;
  const unit = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)) || 1;
  if (!(half > 0)) return null;
  const sphere = { radius: (Math.hypot(cx, cy, cz) + half) / unit };
  spheres.set(root, sphere);
  return sphere;
}

/**
 * Animation Tick Mode When Visible on the render side: a state whose actor no active camera can see is held, not
 * posed, and the latest held state is posed as soon as the actor comes into view (checked before each render) or
 * something reads its pose (a ragdoll capture). The worker still evaluates the graph every tick, so state, events
 * and replay never depend on the view. Seen means the actor's bounds sphere (grown for poses, and for a shadow
 * caster by its shadow's reach) meets an active camera's frustum.
 */
export class AnimVisibilityGate {
  private readonly held = new Set<number>();
  private readonly scene: Scene;
  private readonly binding: AnimVisibilityBinding;
  private readonly apply: (command: AnimStateCommand) => void;

  constructor(scene: Scene, binding: AnimVisibilityBinding, apply: (command: AnimStateCommand) => void) {
    this.scene = scene;
    this.binding = binding;
    this.apply = apply;
  }

  /** Poses the state now, or holds it while its When Visible actor is out of view. */
  offer(command: AnimStateCommand): void {
    if (command.whenVisible && !this.seen(command.slotId)) {
      this.held.add(command.slotId);
      return;
    }
    this.held.delete(command.slotId);
    this.apply(command);
  }

  /** Before each render: poses the held actors that came into view. */
  flush(): void {
    if (this.held.size === 0) return;
    for (const slotId of this.held) {
      if (!this.binding.pendingAnimState?.get(slotId)) this.held.delete(slotId);
      else if (this.seen(slotId)) this.flushSlot(slotId);
    }
  }

  /** Poses the slot's held state now, seen or not: something is about to read its pose. */
  flushSlot(slotId: number): void {
    if (!this.held.delete(slotId)) return;
    const pending = this.binding.pendingAnimState?.get(slotId);
    if (pending) this.apply(pending);
  }

  /** Whether the slot's latest state waits for its actor to be seen. */
  isHeld(slotId: number): boolean {
    return this.held.has(slotId);
  }

  private seen(slotId: number): boolean {
    const root = this.binding.meshes.get(slotId);
    if (!root || root.isDisposed()) return true;
    const sphere = actorSphere(root);
    if (!sphere) return true;
    const scale = root.absoluteScaling;
    const unit = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)) || 1;
    const reach = this.binding.meshSorting.get(slotId)?.castShadows === false ? 1 : SHADOW_REACH;
    const r = sphere.radius * unit * POSE_MARGIN * reach;
    const at = root.getAbsolutePosition();
    return viewOfBox(this.scene, at.x - r, at.y - r, at.z - r, at.x + r, at.y + r, at.z + r, view).visible;
  }
}
