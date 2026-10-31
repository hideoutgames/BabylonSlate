/**
 * Test-build-only oracle for occlusion culling: a street of crates behind a wall, others in front of it and beside it,
 * and one hidden crate whose shadow falls on floor seen past the wall's end, drawn through a world view's Forward
 * FrameGraph with occlusion culling off and on, and with that crate gone.
 */
import { Color4, DirectionalLight, Engine, FreeCamera, MeshBuilder, Scene, Vector3, type AbstractEngine, type AbstractMesh } from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import {
  applyAuthoredLightProperties, compileMaterialPlan, createAppWebGpuEngine, createPrimitiveMesh, RENDERING_GROUP, setSceneRenderSettings,
} from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { readEngineDrawCalls } from "../../../../packages/render/src/draw-calls";
import { setSceneBindsPreviousEffects } from "../../../../packages/render/src/variant-swaps";
import { setSceneOcclusionCulling } from "../../../../packages/render/src/view-occlusion";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

export async function runOcclusionCullingProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 108;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  engine.setSize(canvas.width, canvas.height);
  const order = readbackChannelOrder(engine.isWebGPU);
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
    return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
  };
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 1.7, -8), scene);
    camera.setTarget(new Vector3(0, 1.2, 10));
    camera.minZ = 0.1;
    camera.maxZ = 300;
    scene.activeCamera = camera;
    setSceneBindsPreviousEffects(scene);
    setSceneRenderSettings(scene, { quality: normalizeRenderingQuality({}), shadows: normalizeShadowSettings({}) });

    const doc = createDefaultMaterialDocument("rough dielectric");
    doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.7, 0.7, 0.7];
    const output = doc.nodes.find((node) => node.id === "output")!.properties;
    output[materialPinDefaultPropertyKey("metallic")] = [0];
    output[materialPinDefaultPropertyKey("roughness")] = [0.7];
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("The surface did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "rough dielectric" });
    if (!compiled.ok) throw new Error("The surface did not compile");
    await compiled.ready;

    const meshes: AbstractMesh[] = [];
    const add = <T extends AbstractMesh>(mesh: T) => {
      mesh.material = compiled.material;
      mesh.renderingGroupId = RENDERING_GROUP.world;
      meshes.push(mesh);
      return mesh;
    };
    add(MeshBuilder.CreateGround("floor", { width: 40, height: 60 }, scene)).position.z = 20;
    // A 9 m wall, 4.5 m high, 6 m ahead of the camera (a box primitive: an occluder).
    const wall = add(createPrimitiveMesh(scene, "wall", "box"));
    wall.position.set(0, 2.25, 6);
    wall.scaling.set(6, 3, 0.2);
    const crate = (name: string, x: number, z: number) => {
      const mesh = add(createPrimitiveMesh(scene, name, "box"));
      mesh.position.set(x, 0.75, z);
      return mesh;
    };
    const hidden: AbstractMesh[] = [];
    for (let row = 0; row < 5; row++) for (let column = 0; column < 6; column++) hidden.push(crate(`street-${row}-${column}`, -3 + column * 1.2, 10 + row * 2.5));
    // A 3 m post, hidden too; with the sun from the left its shadow reaches floor seen past the wall's end.
    const caster = crate("caster", 2.5, 12);
    caster.scaling.y = 2;
    caster.position.y = 1.5;
    hidden.push(caster);
    for (const [index, x] of [-2, 0, 2].entries()) crate(`front-${index}`, x, 2);
    crate("beside", 8, 12);

    const sun = new DirectionalLight("sun", new Vector3(1, -0.5, 0.2).normalize(), scene);
    applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: true, range: 40, outerAngle: 70, innerAngle: 40 });

    const graph = new ForwardSceneFrameGraph(scene, { occlusion: true });
    const drawCalls = () => readEngineDrawCalls(engine as unknown as Parameters<typeof readEngineDrawCalls>[0]);
    /** The next presented frame's pixels and draw calls (the counter runs on across frames the graph draws). */
    const draw = async () => {
      const deadline = performance.now() + 15_000;
      for (;;) {
        await graph.prepare(camera);
        const before = drawCalls();
        engine.beginFrame();
        let rendered: boolean;
        try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
        const draws = drawCalls() - before;
        if (rendered) return { pixels: await read(), draws };
        if (performance.now() > deadline) throw new Error("The view did not present");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    };
    const settle = async () => {
      let last = await draw();
      for (let frame = 0; frame < 30; frame++) last = await draw();
      return last;
    };
    const off = await settle();
    setSceneOcclusionCulling(scene, true);
    const on = await settle();
    const diagnostics = { ...graph.occlusionDiagnostics()! };
    const occluded = graph.occludedMeshes();
    const culled = { hidden: hidden.filter((mesh) => occluded.has(mesh)).length, caster: occluded.has(caster), others: [...occluded].filter((mesh) => !hidden.includes(mesh)).map((mesh) => mesh.name) };
    caster.setEnabled(false);
    const noCaster = await settle();
    graph.dispose();
    return {
      width: canvas.width, height: canvas.height, off: off.pixels, on: on.pixels, noCaster: noCaster.pixels,
      draws: { off: off.draws, on: on.draws }, diagnostics, culled, hidden: hidden.length, meshes: meshes.length,
    };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
