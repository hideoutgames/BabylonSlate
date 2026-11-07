import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Light2DBinding } from "@haptic/core";
import { add2DLight, type Light2DRecord } from "./lights-2d";

const part = Matrix.Identity();
const world = Matrix.Identity();
const up = Vector3.Zero();

/** One 2D light: its authored values, its local chain, and its record in the Scene's block. */
class Light2DOwner {
  readonly record: Light2DRecord;
  private readonly local = Matrix.Identity();
  private readonly remove: () => void;
  private bindingError: string | undefined;

  constructor(scene: Scene, binding: Light2DBinding) {
    this.record = { properties: binding.properties, x: 0, y: 0, directionX: 0, directionY: 1 };
    this.remove = add2DLight(scene, this.record);
    this.update(binding);
  }

  update(binding: Light2DBinding): void {
    this.record.properties = binding.properties;
    this.bindingError = binding.error;
    Matrix.IdentityToRef(this.local);
    for (const transform of binding.transforms) {
      Matrix.ComposeToRef(Vector3.FromArray(transform.scale), Quaternion.FromArray(transform.rotation), Vector3.FromArray(transform.position), part);
      this.local.multiplyToRef(part, this.local);
    }
  }

  /** Poses the light from its actor's world: position, and its +Y projected onto the XY plane. */
  setWorld(actorWorld: Matrix): void {
    this.local.multiplyToRef(actorWorld, world);
    const m = world.m;
    Vector3.TransformNormalFromFloatsToRef(0, 1, 0, world, up);
    const length = Math.hypot(up.x, up.y);
    const record = this.record;
    record.error = this.bindingError ?? (!m.every(Number.isFinite) ? "2D Light requires a finite transform." : undefined);
    record.x = m[12]!;
    record.y = m[13]!;
    // A light whose +Y points along Z (turned out of the plane) keeps the plane's up.
    record.directionX = length > 0.000001 ? up.x / length : 0;
    record.directionY = length > 0.000001 ? up.y / length : 1;
  }

  dispose(): void { this.remove(); }
}

/** One actor's 2D lights, posed from its world matrix whether or not its render meshes have arrived. */
export class Light2DGroup {
  readonly owners = new Map<string, Light2DOwner>();
  private readonly world = Matrix.Identity();
  private signature = "";
  private readonly scene: Scene;

  constructor(scene: Scene) { this.scene = scene; }

  /** Applies `bindings`; returns whether anything changed. */
  update(bindings: readonly Light2DBinding[]): boolean {
    const signature = JSON.stringify(bindings);
    if (signature === this.signature) return false;
    const live = new Set(bindings.map((binding) => binding.id));
    for (const [id, owner] of this.owners) if (!live.has(id)) { owner.dispose(); this.owners.delete(id); }
    for (const binding of bindings) {
      let owner = this.owners.get(binding.id);
      if (!owner) { owner = new Light2DOwner(this.scene, binding); this.owners.set(binding.id, owner); }
      else owner.update(binding);
      owner.setWorld(this.world);
    }
    this.signature = signature;
    return true;
  }

  setWorld(actorWorld: Matrix): void {
    this.world.copyFrom(actorWorld);
    for (const owner of this.owners.values()) owner.setWorld(actorWorld);
  }

  /** The record of the light with component `id`, if the group holds it. */
  record(id: string): Light2DRecord | undefined {
    return this.owners.get(id)?.record;
  }

  dispose(): void {
    for (const owner of this.owners.values()) owner.dispose();
    this.owners.clear();
    this.signature = "";
  }
}
