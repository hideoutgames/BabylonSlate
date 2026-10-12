import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Constants,
  DirectionalLight,
  FreeCamera,
  Light,
  MeshBuilder,
  NullEngine,
  PointLight,
  Scene,
  SpotLight,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphObjectRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/objectRendererTask";
import { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { LogicalGeometryTask } from "./framegraph-logical-buffers";
import { SharedOutlineOwner } from "./shared-outline";
import { FrameGraphSharedOutlineTask } from "./shared-outline-task";

/**
 * Babylon toggles `light.shadowEnabled` around every object-renderer pass and
 * readiness probe, and each toggle marks every material's light defines dirty.
 * Passes whose output cannot depend on lighting must leave the lights alone.
 */
const disposers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

function fixture() {
  const engine = adaptNullEngineFrameGraph(new NullEngine());
  Object.assign(engine.getCaps(), { maxDrawBuffers: 4, drawBuffersExtension: true, textureFloatRender: true, textureHalfFloatRender: true, blendFloat: true });
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  // The three lights Babylon toggles; the point light has no shadow generator at all.
  const lights = [
    new DirectionalLight("sun", new Vector3(0.3, -1, 0.5), scene),
    new SpotLight("spot", new Vector3(0, 3, -2), new Vector3(0, -1, 0.5), Math.PI / 2, 1, scene),
    new PointLight("point", new Vector3(2, 2, -2), scene),
  ];
  const mesh = MeshBuilder.CreateBox("box", {}, scene);
  mesh.material = new StandardMaterial("lit", scene);
  const graph = new FrameGraph(scene);
  disposers.push(() => { graph.dispose(); scene.dispose(); engine.dispose(); });
  const lightDirty = vi.spyOn(Light.prototype, "_markMeshesAsLightDirty");
  const flags = () => lights.map((light) => light.shadowEnabled);
  const render = async () => {
    await graph.buildAsync(false);
    // Readiness is polled every frame, then the pass executes.
    for (let pass = 0; pass < 3; pass += 1) { graph.isReady(); graph.execute(); }
  };
  return { engine, scene, camera, lights, mesh, graph, lightDirty, flags, render };
}
type Fixture = ReturnType<typeof fixture>;

function colorTarget({ graph }: Fixture, name: string) {
  return graph.textureManager.createRenderTargetTexture(name, {
    size: { width: 16, height: 8 }, sizeIsPercentage: false,
    options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_UNSIGNED_BYTE], formats: [Constants.TEXTUREFORMAT_RGBA], useSRGBBuffers: [false] },
  });
}
function depthTarget({ graph }: Fixture, name: string) {
  return graph.textureManager.createRenderTargetTexture(name, {
    size: { width: 16, height: 8 }, sizeIsPercentage: false,
    options: { createMipMaps: false, samples: 1, types: [Constants.TEXTURETYPE_FLOAT], formats: [Constants.TEXTUREFORMAT_DEPTH32_FLOAT], useSRGBBuffers: [false] },
  });
}
function clearedDepth(f: Fixture, name: string) {
  const clear = new FrameGraphClearTextureTask(`${name} Clear`, f.graph);
  clear.depthTexture = depthTarget(f, name);
  clear.clearColor = false; clear.clearDepth = true; clear.clearStencil = false;
  f.graph.addTask(clear);
  return clear;
}

describe("light-neutral passes", () => {
  it("lets a native object pass toggle every shadow-capable light, so the probe can see a regression", async () => {
    const f = fixture();
    const target = colorTarget(f, "native color");
    const clear = clearedDepth(f, "native depth");
    const objects = new FrameGraphObjectRendererTask("Native objects", f.graph, f.scene);
    objects.camera = f.camera; objects.objectList = { meshes: [f.mesh], particleSystems: [] };
    objects.targetTexture = target; objects.depthTexture = clear.outputDepthTexture;
    f.graph.addTask(objects);
    await f.render();
    expect(f.lightDirty).toHaveBeenCalled();
    expect(f.flags()).toEqual([true, true, true]);
  });

  it("reads and renders outline masks without toggling light flags", async () => {
    const f = fixture();
    const owner = SharedOutlineOwner.forScene(f.scene);
    const view = owner.createView("test");
    view.setContribution("selection", { kind: "selection", color: [1, 0, 0], width: 2, targets: [{ key: "box", meshes: [f.mesh] }] });
    expect(view.groupActive("selection")).toBe(true);
    const task = new FrameGraphSharedOutlineTask("Outlines", f.graph, view);
    task.camera = f.camera;
    task.targetTexture = colorTarget(f, "scene color");
    f.graph.addTask(task);
    f.lights[1]!.shadowEnabled = false; // an authored flag must survive as well
    f.lightDirty.mockClear();
    await f.render();
    expect(f.lightDirty).not.toHaveBeenCalled();
    expect(f.flags()).toEqual([true, false, true]);
    f.graph.dispose();
    view.dispose();
  });

  it("probes and renders a logical geometry pass without toggling light flags", async () => {
    const f = fixture();
    const clear = clearedDepth(f, "geometry depth");
    const geometry = new LogicalGeometryTask("Geometry", f.graph, f.scene, { doNotChangeAspectRatio: false });
    geometry.camera = f.camera; geometry.objectList = { meshes: [f.mesh], particleSystems: [] };
    geometry.depthTexture = clear.outputDepthTexture;
    geometry.size = { width: 16, height: 8 }; geometry.sizeIsPercentage = false; geometry.samples = 1;
    geometry.textureDescriptions.push({
      type: Constants.PREPASS_WORLD_NORMAL_TEXTURE_TYPE, textureType: Constants.TEXTURETYPE_UNSIGNED_BYTE, textureFormat: Constants.TEXTUREFORMAT_RGBA,
    });
    f.graph.addTask(geometry);
    f.lights[0]!.shadowEnabled = false;
    f.lightDirty.mockClear();
    await f.render();
    expect(f.lightDirty).not.toHaveBeenCalled();
    expect(f.flags()).toEqual([false, true, true]);
  });
});
