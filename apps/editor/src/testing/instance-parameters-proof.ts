/**
 * Test-build-only oracle for per-instance Material parameters: three pooled crates and a plain box drawn with one
 * Material whose Tint is marked Per Instance, through a world view's Forward FrameGraph. Each crate's leaf carries its
 * own Tint in its instance buffer; the plain box draws the Material's. The crates draw in one group.
 */
import { Color4, DirectionalLight, Engine, FreeCamera, Matrix, Scene, Vector3, InstancedMesh, type AbstractEngine, type AbstractMesh } from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { compileMaterialPlan, createAppWebGpuEngine, createPrimitiveMesh, RENDERING_GROUP, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { instanceParameterOf, prepareInstanceParameters } from "../../../../packages/render/src/instance-parameters";
import { sceneInstancePool, setSceneInstancing } from "../../../../packages/render/src/instance-pool";
import { createPooledPrimitiveVisual } from "../../../../packages/render/src/pooled-primitive-visual";
import { pooledLeafOf, setActorMeshMaterial } from "../../../../packages/render/src/pooled-visuals";
import { applyWorldVisualGroup } from "../../../../packages/render/src/sorting";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const WIDTH = 160;
const HEIGHT = 90;

export async function runInstanceParametersProof(backend: "webgl2" | "webgpu") {
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
    const camera = new FreeCamera("camera", new Vector3(0, 1, -7), scene);
    camera.setTarget(new Vector3(0, 0.75, 0));
    scene.activeCamera = camera;
    setSceneRenderSettings(scene, { quality: normalizeRenderingQuality({}), shadows: normalizeShadowSettings({ enabled: false }) });
    const doc = createDefaultMaterialDocument("tinted");
    const tint = doc.nodes.find((node) => node.id === "baseColor")!;
    tint.type = "param.color";
    tint.properties = { name: "Tint", value: [0.8, 0.8, 0.8, 1], perInstance: true };
    doc.edges.find((edge) => edge.sourceNodeId === "baseColor")!.sourcePinId = "rgb";
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("the tinted Material did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "tinted" });
    if (!compiled.ok) throw new Error(`the tinted Material did not compile: ${JSON.stringify(compiled.diagnostics)}`);
    await compiled.ready;
    const material = compiled.material;
    const attribute = instanceParameterOf(material, "Tint")!.attribute;
    const tints: Array<[number, number, number]> = [[0.9, 0.1, 0.1], [0.1, 0.9, 0.1], [0.1, 0.1, 0.9]];
    const leaves: AbstractMesh[] = [];
    for (const [index, x] of [-3, -1, 1].entries()) {
      // WebGPU does not pool yet: a crate there is a mesh of its own.
      const root = createPooledPrimitiveVisual(scene, `crate-${index}`, "box") ?? createPrimitiveMesh(scene, `crate-${index}`, "box");
      root.position.set(x, 0.75, 0);
      applyWorldVisualGroup(root, { components: [] });
      setActorMeshMaterial(root, material);
      const drawn = pooledLeafOf(root) ?? root;
      // As a per-actor write of a per-instance parameter will: prepared, then its own value (linear in the buffer).
      prepareInstanceParameters(drawn, material);
      drawn.instancedBuffers[attribute] = new Color4(...tints[index]!, 1).toLinearSpace();
      leaves.push(drawn);
    }
    const plain = createPrimitiveMesh(scene, "plain", "box");
    plain.position.set(3, 0.75, 0);
    plain.renderingGroupId = RENDERING_GROUP.world;
    plain.material = material;
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.6).normalize(), scene);
    sun.intensity = 2;

    const graph = new ForwardSceneFrameGraph(scene, {});
    const order = readbackChannelOrder(engine.isWebGPU);
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
    const pixels = toRgbaPixels(new Uint8Array(read.buffer, read.byteOffset, read.byteLength), order);
    /** The colour at `position`'s pixel. */
    const at = (position: Vector3) => {
      const screen = Vector3.Project(position, Matrix.Identity(), scene.getTransformMatrix(), camera.viewport.toGlobal(WIDTH, HEIGHT));
      const offset = ((HEIGHT - 1 - Math.round(screen.y)) * WIDTH + Math.round(screen.x)) * 4;
      return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
    };
    graph.dispose();
    await graph.whenReleased();
    return {
      crates: leaves.map((leaf) => at(leaf.getAbsolutePosition())),
      plain: at(plain.getAbsolutePosition()),
      sources: new Set(leaves.map((leaf) => leaf instanceof InstancedMesh ? leaf.sourceMesh : leaf)).size,
      pool: sceneInstancePool(scene).diagnostics().pooled,
    };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
