import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

/**
 * What each instanced batch's buffers hold, so a batch drawn again in the same Engine frame with the same data uploads
 * nothing (the patch hook `Scene._instanceUploads`, called from Babylon's `Mesh._updateInstancedBuffers` and
 * `Mesh._processInstancedBuffers`). On WebGL every pass of a frame draws a source's instances from one buffer (the mono
 * instance storage), and Babylon fills and uploads it at each draw: the geometry pass and the objects pass wrote the same
 * bytes twice, the second time into a buffer the frame had already drawn from, which on ANGLE over Metal costs a fresh
 * buffer or a wait.
 *
 * The world rows are decided from what produced them, without reading them back: the same frame, the same buffer, the
 * source drawing itself or not, the same instances in the same order, each world matrix (the source's too) unchanged
 * since the upload (its `updateFlag`), and the same floating-origin offset, which Large World Rendering takes from each
 * pass's camera. A view-dependent order (`Mesh.INSTANCEDMESH_SORT_TRANSPARENT`) or previous-world rows always upload.
 * The record is replaced at every upload, and dropped by one it did not fill (a manual or frozen batch's), so it always
 * says what the buffer holds.
 *
 * Per-instance attributes (`registerInstancedBuffer`) have no producer to ask: their values are compared, bit for bit,
 * with the copy of what the buffer received this frame, over the floats this draw wrote.
 */

/** The instance storage Babylon fills (a batch's `parent`): its world rows and their buffer. */
interface InstanceStorage { instancesBuffer: unknown }

interface Rows {
  frameId: number;
  buffer: unknown;
  renderSelf: boolean;
  /** The world matrix flags of the source (when it draws itself) and of each instance, in order. */
  selfFlag: number;
  instances: AbstractMesh[];
  flags: number[];
  x: number;
  y: number;
  z: number;
}

interface Attributes {
  frameId: number;
  /** The data array the buffer was last filled from, and its bits. */
  data: Float32Array;
  bits: Uint32Array;
  /** The bits it held at that upload. */
  copy: Uint32Array;
}

const rows = new WeakMap<object, Rows>();
const attributes = new WeakMap<object, Attributes>();

function frameOf(mesh: AbstractMesh): number {
  return mesh.getScene().getEngine().frameId;
}

/** The hook Babylon's patched instancing calls; one per process, installed on each drawn Scene. */
export const instanceUploads = {
  /**
   * The instance count the buffer already holds rows for, when this draw's rows are exactly those (nothing to fill or
   * upload), else -1. Reads each world matrix as Babylon's fill does, in the same order.
   */
  kept(mesh: AbstractMesh, storage: object, instances: readonly AbstractMesh[] | null | undefined, renderSelf: boolean): number {
    const record = rows.get(storage);
    const scene = mesh.getScene();
    if (!record || record.frameId !== frameOf(mesh) || record.buffer !== (storage as InstanceStorage).instancesBuffer ||
      record.renderSelf !== renderSelf || scene.needsPreviousWorldMatrices || Mesh.INSTANCEDMESH_SORT_TRANSPARENT) return -1;
    const count = instances?.length ?? 0;
    if (count !== record.instances.length) return -1;
    const offset = scene.floatingOriginOffset;
    if (offset.x !== record.x || offset.y !== record.y || offset.z !== record.z) return -1;
    const world = mesh.getWorldMatrix();
    if (renderSelf && world.updateFlag !== record.selfFlag) return -1;
    for (let index = 0; index < count; index++) {
      const instance = instances![index]!;
      if (instance !== record.instances[index] || instance.getWorldMatrix().updateFlag !== record.flags[index]) return -1;
    }
    return count + (renderSelf ? 1 : 0);
  },

  /**
   * After an upload of `storage`'s rows: `filled` when this draw filled them (then they are recorded), false when they
   * came from elsewhere (a manual or frozen batch), which leaves nothing recorded.
   */
  uploaded(mesh: AbstractMesh, storage: object, instances: readonly AbstractMesh[] | null | undefined, renderSelf: boolean, filled: boolean): void {
    if (!filled) {
      rows.delete(storage);
      return;
    }
    let record = rows.get(storage);
    if (!record) {
      record = { frameId: 0, buffer: null, renderSelf: false, selfFlag: 0, instances: [], flags: [], x: 0, y: 0, z: 0 };
      rows.set(storage, record);
    }
    const count = instances?.length ?? 0;
    record.frameId = frameOf(mesh);
    record.buffer = (storage as InstanceStorage).instancesBuffer;
    record.renderSelf = renderSelf;
    record.selfFlag = mesh.getWorldMatrix().updateFlag;
    record.instances.length = record.flags.length = count;
    for (let index = 0; index < count; index++) {
      const instance = instances![index]!;
      record.instances[index] = instance;
      record.flags[index] = instance.getWorldMatrix().updateFlag;
    }
    const offset = mesh.getScene().floatingOriginOffset;
    record.x = offset.x;
    record.y = offset.y;
    record.z = offset.z;
  },

  /**
   * Whether `buffer` (a per-instance attribute's) already holds `data`'s first `used` floats from an upload this frame;
   * otherwise records them as what the upload about to follow writes. Floats past `used` were not written by this
   * draw, so they still hold what the buffer received.
   */
  attributesKept(mesh: AbstractMesh, buffer: object, data: Float32Array, used: number): boolean {
    const frameId = frameOf(mesh);
    let record = attributes.get(buffer);
    if (record && record.frameId === frameId && record.data === data) {
      const bits = record.bits, copy = record.copy;
      let same = true;
      for (let index = 0; index < used; index++) if (bits[index] !== copy[index]) { same = false; break; }
      if (same) return true;
    }
    if (!record || record.data !== data) {
      record = { frameId, data, bits: new Uint32Array(data.buffer, data.byteOffset, data.length), copy: new Uint32Array(data.length) };
      attributes.set(buffer, record);
    }
    record.frameId = frameId;
    // The whole array is uploaded.
    record.copy.set(record.bits);
    return false;
  },
};

export type InstanceUploads = typeof instanceUploads;

/** Lets `scene`'s instanced batches skip the uploads whose data their buffers already hold this frame. */
export function installInstanceUploads(scene: Scene): void {
  scene._instanceUploads = instanceUploads;
}
