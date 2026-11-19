import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
// Registers the instancing members on Mesh (`registerInstancedBuffer`, `_processInstancedBuffers`).
import "@babylonjs/core/Meshes/instancedMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Material } from "@babylonjs/core/Materials/material";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { installInstanceUploads, instanceUploads } from "./instance-uploads";

const disposers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

type Storage = { instancesData: Float32Array; instancesBuffer: object };
type Uploads = { rows: number; tints: number };

/** A box drawn with two instances, each with a per-instance value, through Babylon's hardware instancing. */
function host(install = true) {
  const engine = new NullEngine();
  engine.getCaps().instancedArrays = true;
  const scene = new Scene(engine);
  new FreeCamera("camera", new Vector3(0, 0, -10), scene);
  if (install) installInstanceUploads(scene);
  const box = MeshBuilder.CreateBox("box", {}, scene);
  box.registerInstancedBuffer("tint", 1);
  box.instancedBuffers.tint = 0;
  const instances = [1, 2].map((value) => {
    const instance = box.createInstance(`copy ${value}`);
    instance.position.x = value * 2;
    instance.instancedBuffers.tint = value;
    return instance;
  });
  disposers.push(() => { scene.dispose(); engine.dispose(); });
  const storage = () => (box as unknown as { _instanceDataStorage: { dataStorageRenderPass: Storage } })._instanceDataStorage.dataStorageRenderPass;
  const tints = () => (box as unknown as { _userInstancedBuffersStorage: { data: Record<string, Float32Array> } })._userInstancedBuffersStorage.data.tint;
  // Uploads into the instance rows' buffer and the tint attribute's, by the data each is filled from.
  const uploads: Uploads = { rows: 0, tints: 0 };
  vi.spyOn(engine, "updateDynamicVertexBuffer").mockImplementation((_buffer, data) => {
    if (data === storage().instancesData) uploads.rows += 1;
    else if (data === tints()) uploads.tints += 1;
  });
  type Internals = {
    _registerInstanceForRenderId(instance: InstancedMesh, renderId: number): void;
    _getInstancesRenderList(subMeshId: number): unknown;
    _renderWithInstances(subMesh: SubMesh, fillMode: number, batch: unknown, effect: undefined, engine: NullEngine): void;
  };
  /**
   * One pass drawing the batch as a frame graph pass does: a render id of its own, its visible instances registered for
   * it, then Babylon's instanced draw of the box's sub-mesh (no Effect: the buffers are filled and uploaded, nothing drawn).
   */
  const draw = () => {
    scene.incrementRenderId();
    const internals = box as unknown as Internals;
    for (const instance of instances) if (instance.isVisible) internals._registerInstanceForRenderId(instance, scene.getRenderId());
    const subMesh = box.subMeshes[0]!;
    internals._renderWithInstances(subMesh, Material.TriangleFillMode, internals._getInstancesRenderList(subMesh._id), undefined, engine);
  };
  const nextFrame = () => { engine.endFrame(); engine.beginFrame(); };
  return { engine, scene, box, instances, uploads, draw, nextFrame, storage };
}

describe("instance uploads", () => {
  it("uploads a batch's rows and per-instance values once per frame while nothing changes, and every draw without the record", () => {
    for (const install of [true, false]) {
      const { uploads, draw, nextFrame } = host(install);
      draw();
      nextFrame();
      uploads.rows = uploads.tints = 0;
      draw();
      draw();
      draw();
      expect(uploads, `installed ${install}`).toEqual(install ? { rows: 1, tints: 1 } : { rows: 3, tints: 3 });
      // A new frame uploads again: the record holds within one Engine frame.
      nextFrame();
      draw();
      expect(uploads, `installed ${install}`).toEqual(install ? { rows: 2, tints: 2 } : { rows: 4, tints: 4 });
    }
  });

  it("uploads the rows again when an instance moves between two draws of a frame, and only the rows", () => {
    const { uploads, draw, nextFrame, instances } = host();
    draw();
    nextFrame();
    draw();
    uploads.rows = uploads.tints = 0;
    instances[1]!.position.y += 1;
    draw();
    expect(uploads).toEqual({ rows: 1, tints: 0 });
  });

  it("uploads the values again when one changes between two draws of a frame, and only the values", () => {
    const { uploads, draw, nextFrame, instances } = host();
    draw();
    nextFrame();
    draw();
    uploads.rows = uploads.tints = 0;
    instances[0]!.instancedBuffers.tint = 7;
    draw();
    expect(uploads).toEqual({ rows: 0, tints: 1 });
    // Negative zero is another value: its bits differ.
    instances[0]!.instancedBuffers.tint = 0;
    draw();
    instances[0]!.instancedBuffers.tint = -0;
    draw();
    expect(uploads.tints).toBe(3);
  });

  it("uploads the rows again when the source moves, an instance hides, or the instances come in another order", () => {
    const { uploads, draw, nextFrame, box, instances, storage } = host();
    draw();
    nextFrame();
    draw();
    uploads.rows = 0;
    box.position.z += 1;
    draw();
    expect(uploads.rows).toBe(1);
    instances[0]!.isVisible = false;
    draw();
    expect(uploads.rows).toBe(2);
    // The same instances listed in another order (another pass's cull) hold other rows.
    const reversed = [...instances].reverse();
    expect(instanceUploads.kept(box, storage(), instances, true)).toBe(-1);
    instanceUploads.uploaded(box, storage(), instances, true, true);
    expect(instanceUploads.kept(box, storage(), instances, true)).toBe(3);
    expect(instanceUploads.kept(box, storage(), reversed, true)).toBe(-1);
    expect(instanceUploads.kept(box, storage(), instances, false)).toBe(-1);
  });

  it("keeps no rows across another camera's floating origin, previous-world rows, a view-dependent order or a fill from elsewhere", () => {
    const { box, instances, storage, scene, draw } = host();
    draw();
    const record = () => instanceUploads.uploaded(box, storage(), instances, true, true);
    record();
    expect(instanceUploads.kept(box, storage(), instances, true)).toBe(3);
    // Large World Rendering subtracts each pass's camera position from the rows.
    const offset = new Vector3(5, 0, 0);
    vi.spyOn(scene, "floatingOriginOffset", "get").mockReturnValue(offset);
    expect(instanceUploads.kept(box, storage(), instances, true)).toBe(-1);
    record();
    expect(instanceUploads.kept(box, storage(), instances, true)).toBe(3);
    scene.needsPreviousWorldMatrices = true;
    expect(instanceUploads.kept(box, storage(), instances, true)).toBe(-1);
    scene.needsPreviousWorldMatrices = false;
    Mesh.INSTANCEDMESH_SORT_TRANSPARENT = true;
    try { expect(instanceUploads.kept(box, storage(), instances, true)).toBe(-1); }
    finally { Mesh.INSTANCEDMESH_SORT_TRANSPARENT = false; }
    expect(instanceUploads.kept(box, storage(), instances, true)).toBe(3);
    // A manual or frozen batch's upload, which this record did not fill, leaves it saying nothing.
    instanceUploads.uploaded(box, storage(), instances, true, false);
    expect(instanceUploads.kept(box, storage(), instances, true)).toBe(-1);
  });
});
