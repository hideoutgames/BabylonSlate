import { Vector3, type Matrix } from "@babylonjs/core/Maths/math.vector";
import { FOLIAGE_FLOATS_PER_INSTANCE, parseFoliageProperties, type FoliageBatch, type FoliageProperties } from "@haptic/core";

type Batch = { source: FoliageBatch; positions: Float64Array; alive: Uint8Array; count: number };

/**
 * One Foliage component's instances under an erase stroke. The component is
 * parsed and every instance moved to world space once; each dab then only marks
 * the instances within reach. After every dab the result equals re-parsing the
 * previous result and keeping the instances farther than the radius from the
 * point, which is what the brush did per dab: parsing is idempotent on its own
 * output and the world matrix is constant for a stroke (the scene is fixed and
 * a foliage stroke never applies it), so the world positions never change.
 */
export class FoliageEraseSession {
  private readonly groupId: string;
  private readonly batches: Batch[];
  private remaining = 0;
  private readonly probe = new Vector3();

  constructor(properties: unknown, world: Matrix) {
    const data = parseFoliageProperties(properties);
    this.groupId = data.groupId;
    this.batches = data.batches.map((source) => {
      const transforms = source.transforms;
      const count = transforms.length / FOLIAGE_FLOATS_PER_INSTANCE;
      const positions = new Float64Array(count * 3);
      const local = new Vector3(), position = new Vector3();
      for (let i = 0; i < count; i++) {
        const at = i * FOLIAGE_FLOATS_PER_INSTANCE;
        local.copyFromFloats(transforms[at]!, transforms[at + 1]!, transforms[at + 2]!);
        Vector3.TransformCoordinatesToRef(local, world, position);
        positions[i * 3] = position.x; positions[i * 3 + 1] = position.y; positions[i * 3 + 2] = position.z;
      }
      this.remaining += count;
      return { source, positions, alive: new Uint8Array(count).fill(1), count };
    });
  }

  /** No instance is left, so the component is removed from the scene. */
  get empty(): boolean { return this.remaining === 0; }

  /** Removes the instances no farther than `radius` from the world-space `point`. */
  erase(point: Vector3, radius: number): void {
    for (const batch of this.batches) {
      const { positions, alive } = batch;
      for (let i = 0; i < alive.length; i++) {
        if (!alive[i]) continue;
        this.probe.copyFromFloats(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
        // Negated so a distance that is not greater than the radius (including NaN) erases, as the filter that kept `> radius` did.
        if (!(Vector3.Distance(this.probe, point) > radius)) { alive[i] = 0; batch.count--; this.remaining--; }
      }
    }
  }

  /** The surviving instances, in their original order; batches that lost every instance are dropped. */
  snapshot(): FoliageProperties {
    return { groupId: this.groupId, batches: this.batches.filter((batch) => batch.count > 0).map((batch) => {
      const source = batch.source.transforms;
      const transforms = new Float32Array(batch.count * FOLIAGE_FLOATS_PER_INSTANCE);
      let to = 0;
      for (let i = 0; i < batch.alive.length; i++) {
        if (!batch.alive[i]) continue;
        transforms.set(source.subarray(i * FOLIAGE_FLOATS_PER_INSTANCE, (i + 1) * FOLIAGE_FLOATS_PER_INSTANCE), to);
        to += FOLIAGE_FLOATS_PER_INSTANCE;
      }
      return { ...batch.source, transforms };
    }) };
  }
}
