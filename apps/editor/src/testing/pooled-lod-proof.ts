/**
 * Test-build-only oracle for Auto LOD on pooled model leaves: two instances of a dense sphere model drawn through the
 * instance pool, one near and one far, through a world view's Forward FrameGraph. Both draw; the far one draws its
 * group source's coarser level, in that level's batch.
 */
import { Color4, DirectionalLight, Engine, FreeCamera, Matrix, Mesh, Scene, Vector3, type AbstractEngine, type InstancedMesh } from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { compileMaterialPlan, createAppWebGpuEngine, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { encodeUvSphereGlb } from "../../../../packages/render/src/glb-test-fixtures";
import { setSceneInstancing } from "../../../../packages/render/src/instance-pool";
import { loadModelContainer } from "../../../../packages/render/src/model-container";
import { attachModelLods, generateModelLods } from "../../../../packages/render/src/model-lod";
import { poolModelLeaves } from "../../../../packages/render/src/pooled-model-leaves";
import { setDrawnMaterial } from "../../../../packages/render/src/pooled-visuals";
import { RENDERING_GROUP } from "../../../../packages/render/src/sorting";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const WIDTH = 160;
const HEIGHT = 90;

export async function runPooledLodProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  engine.setSize(WIDTH, HEIGHT);
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0, 0, 0, 1);
    setSceneInstancing(scene, true);
    const camera = new FreeCamera("camera", new Vector3(0, 0, -4), scene);
    camera.setTarget(new Vector3(0, 0, 0));
    camera.maxZ = 500;
    scene.activeCamera = camera;
    setSceneRenderSettings(scene, {
      quality: normalizeRenderingQuality({ geometry: { autoLod: true, lodDistanceScale: 1 } }),
      shadows: normalizeShadowSettings({ enabled: false }),
    });
    const doc = createDefaultMaterialDocument("stone");
    doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.9, 0.9, 0.9];
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("the stone Material did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "stone" });
    if (!compiled.ok) throw new Error("the stone Material did not compile");
    await compiled.ready;
    const container = await loadModelContainer(scene, encodeUvSphereGlb(), "sphere.glb");
    const lods = await generateModelLods(container);
    /** An instance of the sphere at `position` and `scale`, its leaves pooled and its levels attached. */
    const sphere = (name: string, position: Vector3, scale: number) => {
      const root = new Mesh(name, scene);
      for (const node of container.instantiateModelsToScene((source) => source, false, { doNotInstantiate: true }).rootNodes) node.parent = root;
      root.position.copyFrom(position);
      root.scaling.setAll(scale);
      for (const mesh of root.getChildMeshes()) { mesh.renderingGroupId = RENDERING_GROUP.world; mesh.material = compiled.material; }
      const members = poolModelLeaves(root, container, { retain: () => () => {} });
      for (const member of members) setDrawnMaterial(member, compiled.material);
      attachModelLods(root, lods);
      return members[0];
    };
    const near = sphere("near", new Vector3(-0.8, 0, 0), 0.6);
    // Far away but scaled up, so it still covers pixels while its coverage selects a coarse level.
    const far = sphere("far", new Vector3(30, 0, 300), 20);
    const sun = new DirectionalLight("sun", new Vector3(0.2, -0.5, 1).normalize(), scene);
    sun.intensity = 2;

    const graph = new ForwardSceneFrameGraph(scene, {});
    for (let frame = 0, presented = 0; presented < 10; frame++) {
      if (frame > 600) throw new Error("The view did not present");
      await graph.prepare(camera);
      engine.beginFrame();
      let rendered: boolean;
      try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
      if (rendered) presented++;
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    const read = await engine.readPixels(0, 0, WIDTH, HEIGHT);
    const pixels = toRgbaPixels(new Uint8Array(read.buffer, read.byteOffset, read.byteLength), readbackChannelOrder(engine.isWebGPU));
    const brightness = (mesh: InstancedMesh | undefined) => {
      if (!mesh) return -1;
      const screen = Vector3.Project(mesh.getBoundingInfo().boundingSphere.centerWorld, Matrix.Identity(), scene.getTransformMatrix(),
        camera.viewport.toGlobal(WIDTH, HEIGHT));
      const offset = ((HEIGHT - 1 - Math.round(screen.y)) * WIDTH + Math.round(screen.x)) * 4;
      return Math.max(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!);
    };
    const levelOf = (mesh: InstancedMesh | undefined) => {
      const drawn = (mesh as unknown as { _currentLOD?: unknown } | undefined)?._currentLOD;
      if (!mesh || !drawn) return -1;
      return drawn === mesh.sourceMesh ? 0 : mesh.sourceMesh.getLODLevels().findIndex((level) => level.mesh === drawn) + 1;
    };
    const result = {
      pooled: !!near && !!far && near.sourceMesh === far.sourceMesh,
      levels: near?.sourceMesh.getLODLevels().length ?? 0,
      nearLevel: levelOf(near), farLevel: levelOf(far),
      nearBrightness: brightness(near), farBrightness: brightness(far),
    };
    graph.dispose();
    await graph.whenReleased();
    return result;
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
