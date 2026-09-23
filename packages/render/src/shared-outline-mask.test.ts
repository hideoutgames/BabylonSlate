import { afterEach, expect, it, vi } from "vitest";
import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { ObjectRenderer } from "@babylonjs/core/Rendering/objectRenderer";
import { SharedOutlineOwner } from "./shared-outline";
import { SharedOutlineMaskRenderer } from "./shared-outline-mask";
import { registerSharedOutlineShaders } from "./shared-outline-shaders";

afterEach(() => vi.restoreAllMocks());

it("retains a live instance mask program across pruning and releases it with its owner", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  scene.activeCamera = camera;
  const source = MeshBuilder.CreateBox("source", {}, scene);
  const instance = source.createInstance("actor");
  const owner = SharedOutlineOwner.forScene(scene), view = owner.createView("test");
  view.setContribution("actor", { kind: "component", targets: [{ key: "actor", meshes: [instance] }],
    color: [1, 0, 0], width: 1 });
  registerSharedOutlineShaders();
  const objects = new ObjectRenderer("mask", scene);
  objects.activeCamera = camera;
  objects.renderList = [instance];
  const mask = new SharedOutlineMaskRenderer(objects, view, "strict");
  try {
    objects.isReadyForRendering(80, 64);
    const subMesh = instance.subMeshes![0]!;
    const wrapper = subMesh._getDrawWrapper(objects.renderPassId)!;
    const effect = wrapper.effect!;
    expect(effect).toBeTruthy();
    // The GPU compiler is the external boundary: keep this program pending
    // across repeated preparation/cleanup, as native parallel WebGL does.
    const readiness = vi.spyOn(effect, "isReady").mockReturnValue(false);
    for (let attempt = 0; attempt < 3; attempt++) {
      mask.prune();
      expect(subMesh._getDrawWrapper(objects.renderPassId)).toBe(wrapper);
      expect(effect.isDisposed).toBe(false);
      expect(objects.isReadyForRendering(80, 64)).toBe(false);
    }
    readiness.mockRestore();
    expect(objects.isReadyForRendering(80, 64)).toBe(true);
    instance.dispose();
    mask.prune();
    await mask.whenReleased();
    expect(subMesh._getDrawWrapper(objects.renderPassId)).toBeUndefined();
  } finally {
    mask.dispose(); objects.dispose(); view.dispose();
    await owner.whenReleased();
    scene.dispose(); engine.dispose();
  }
});
