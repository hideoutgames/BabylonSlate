import { afterEach, expect, it, vi } from "vitest";
import { FreeCamera, MeshBuilder, NullEngine, RawTexture, Scene, StandardMaterial, Vector3, type SubMesh } from "@babylonjs/core";
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

it("revalidates coverage edited after a drawn mask pass for readiness and the next pass", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  scene.activeCamera = camera;
  const source = MeshBuilder.CreateBox("source", {}, scene);
  const material = new StandardMaterial("coverage", scene);
  source.material = material;
  const instance = source.createInstance("actor");
  const owner = SharedOutlineOwner.forScene(scene), view = owner.createView("test");
  view.setContribution("actor", { kind: "component", targets: [{ key: "actor", meshes: [instance] }],
    color: [1, 0, 0], width: 1 });
  registerSharedOutlineShaders();
  const objects = new ObjectRenderer("mask", scene);
  objects.activeCamera = camera;
  objects.renderList = [instance];
  owner.registerRenderPass(objects.renderPassId);
  const mask = new SharedOutlineMaskRenderer(objects, view, "strict");
  // As FrameGraph object passes: a fresh render id and intermediate rendering.
  const render = () => {
    scene.incrementRenderId(); scene._intermediateRendering = true;
    objects.prepareRenderList(); objects.initRender(80, 64); objects.render(); objects.finishRender();
    scene._intermediateRendering = false;
  };
  const defines = (subMesh: SubMesh) => subMesh._getDrawWrapper(objects.renderPassId)?.defines;
  try {
    expect(objects.isReadyForRendering(80, 64)).toBe(true);
    render();
    // The instance is probed; its source submesh is what the pass submits.
    const probed = instance.subMeshes![0]!, drawn = source.subMeshes[0]!;
    expect(defines(drawn)).toBeTypeOf("string");
    expect(defines(drawn)).not.toContain("ALPHATEST");
    const texture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
    texture.hasAlpha = true;
    texture.getInternalTexture()!.isReady = true; // NullEngine never completes raw uploads.
    material.diffuseTexture = texture;
    // A between-frame probe follows the last mask pass without a new render id.
    objects.isReadyForRendering(80, 64);
    expect(defines(probed)).toContain("#define ALPHATEST");
    render();
    expect(defines(drawn)).toContain("#define ALPHATEST");
  } finally {
    mask.dispose(); objects.dispose(); view.dispose();
    await owner.whenReleased();
    scene.dispose(); engine.dispose();
  }
});
