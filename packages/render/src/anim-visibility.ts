import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import type { CommandMessage } from "@haptic/bridge";
import { viewOfBox, type BoxView } from "./active-view";
import { posesEveryCommand } from "./anim-pose";
import { worldSpriteBounds } from "./sprite-batch-handle";

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
 * When a slot's animation state is posed.
 *
 * A state is absolute: posing the latest one gives the pose that posing every one in turn gives. So a state is not
 * posed as it arrives but before the next snapshot is applied and before each render (`flush`), and a slot that got
 * several since (the worker ran catch-up ticks in one advance) is posed once, from its latest. The exception is a
 * state with a change that steps or traces on every pose (`posesEveryCommand`: Spring Bones advance by each
 * command's time step): it is posed as it arrives, as before.
 *
 * Animation Tick Mode When Visible on the render side: a state whose actor no active camera can see is held, not
 * posed, and the latest held state is posed as soon as the actor comes into view (checked at each flush) or
 * something reads its pose (a ragdoll capture). The worker still evaluates the graph every tick, so state, events
 * and replay never depend on the view. Seen means the actor's bounds sphere (grown for poses, and for a shadow
 * caster by its shadow's reach) meets an active camera's frustum.
 *
 * Whatever reads a slot's pose outside a frame must call `flushSlot` first.
 */
export class AnimVisibilityGate {
  /** Slots whose latest state (the binding's pending one) is not posed yet: arrived since the last flush, or unseen. */
  private readonly waiting = new Set<number>();
  private readonly scene: Scene;
  private readonly binding: AnimVisibilityBinding;
  private readonly apply: (command: AnimStateCommand) => void;

  constructor(scene: Scene, binding: AnimVisibilityBinding, apply: (command: AnimStateCommand) => void) {
    this.scene = scene;
    this.binding = binding;
    this.apply = apply;
  }

  /** Takes the slot's latest state: posed at the next flush, or now when every command of it must be posed. */
  offer(command: AnimStateCommand): void {
    if (!posesEveryCommand(command.boneModifiers)) {
      this.waiting.add(command.slotId);
      return;
    }
    if (command.whenVisible && !this.seen(command.slotId)) {
      this.waiting.add(command.slotId);
      return;
    }
    this.waiting.delete(command.slotId);
    this.apply(command);
  }

  /** Before a snapshot is applied and before each render: poses the waiting slots that are Always or in view. */
  flush(): void {
    if (this.waiting.size === 0) return;
    for (const slotId of this.waiting) {
      const pending = this.binding.pendingAnimState?.get(slotId);
      if (!pending) this.waiting.delete(slotId);
      else if (!pending.whenVisible || this.seen(slotId)) {
        this.waiting.delete(slotId);
        this.apply(pending);
      }
    }
  }

  /** Poses the slot's waiting state now, seen or not: something is about to read its pose. */
  flushSlot(slotId: number): void {
    if (!this.waiting.delete(slotId)) return;
    const pending = this.binding.pendingAnimState?.get(slotId);
    if (pending) this.apply(pending);
  }

  /** Whether the slot's latest state is not posed yet; after a flush, that it waits for its actor to be seen. */
  isHeld(slotId: number): boolean {
    return this.waiting.has(slotId);
  }

  private seen(slotId: number): boolean {
    const root = this.binding.meshes.get(slotId);
    if (!root || root.isDisposed()) return true;
    const spriteBounds = worldSpriteBounds(root);
    if (spriteBounds) {
      const dx = spriteBounds.maxX - spriteBounds.minX;
      const dy = spriteBounds.maxY - spriteBounds.minY;
      const dz = spriteBounds.maxZ - spriteBounds.minZ;
      const reach = this.binding.meshSorting.get(slotId)?.castShadows === false ? 1 : SHADOW_REACH;
      const half = Math.hypot(dx, dy, dz) * 0.5 * POSE_MARGIN * reach;
      const cx = (spriteBounds.minX + spriteBounds.maxX) * 0.5;
      const cy = (spriteBounds.minY + spriteBounds.maxY) * 0.5;
      const cz = (spriteBounds.minZ + spriteBounds.maxZ) * 0.5;
      return viewOfBox(this.scene, cx - half, cy - half, cz - half, cx + half, cy + half, cz + half, view).visible;
    }
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
