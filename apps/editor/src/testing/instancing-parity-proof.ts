/**
 * Test-build-only oracle for automatic instancing: a street of primitive crates under a shadowing sun, drawn through a
 * world view's Forward FrameGraph once with each crate a mesh of its own and once through the instance pool (Play's
 * primitive visuals), with occlusion culling off and on. The images must match; the pooled draws are fewer.
 */
import { Color4, DirectionalLight, Engine, FreeCamera, MeshBuilder, Scene, Vector3, type AbstractEngine, type Mesh } from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import {
  applyAuthoredLightProperties, compileMaterialPlan, createAppWebGpuEngine, createPrimitiveMesh, RENDERING_GROUP, setSceneRenderSettings,
} from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { readEngineDrawCalls } from "../../../../packages/render/src/draw-calls";
import { sceneInstancePool, setSceneInstancing } from "../../../../packages/render/src/instance-pool";
import { createPooledPrimitiveVisual } from "../../../../packages/render/src/pooled-primitive-visual";
import { setActorMeshMaterial } from "../../../../packages/render/src/pooled-visuals";
import { applyWorldVisualGroup } from "../../../../packages/render/src/sorting";
import { setSceneBindsPreviousEffects } from "../../../../packages/render/src/variant-swaps";
import { allowSceneOcclusionCulling } from "../../../../packages/render/src/view-occlusion";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const WIDTH = 192;
const HEIGHT = 108;

/** One run: the street drawn with pooling `pooled`, occlusion culling off then on. */
async function drawStreet(engine: AbstractEngine, pooled: boolean) {
  const order = readbackChannelOrder(engine.isWebGPU);
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
    return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
  };
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    setSceneInstancing(scene, pooled);
    const camera = new FreeCamera("camera", new Vector3(0, 2.2, -8), scene);
    camera.setTarget(new Vector3(0, 1, 10));
    camera.minZ = 0.1;
    camera.maxZ = 300;
    scene.activeCamera = camera;
    setSceneBindsPreviousEffects(scene);
    const occlusionSetting = (occlusionCulling: boolean) => setSceneRenderSettings(scene, {
      quality: normalizeRenderingQuality({ geometry: { occlusionCulling } }), shadows: normalizeShadowSettings({}),
    });
    occlusionSetting(false);
    allowSceneOcclusionCulling(scene, true);
    const compile = async (name: string, color: [number, number, number]) => {
      const doc = createDefaultMaterialDocument(name);
      doc.nodes.find((node) => node.id === "baseColor")!.properties.value = color;
      const lowered = lowerMaterialDocument(doc);
      if (!lowered.ok) throw new Error(`${name} did not lower`);
      const compiled = compileMaterialPlan(lowered.plan, { scene, name });
      if (!compiled.ok) throw new Error(`${name} did not compile`);
      await compiled.ready;
      return compiled.material;
    };
    const stone = await compile("stone", [0.7, 0.7, 0.7]);
    const brick = await compile("brick", [0.7, 0.35, 0.25]);
    const floor = MeshBuilder.CreateGround("floor", { width: 40, height: 60 }, scene);
    floor.position.z = 20;
    floor.material = stone;
    floor.renderingGroupId = RENDERING_GROUP.world;
    // A wall occluding most of the street behind it.
    const wall = createPrimitiveMesh(scene, "wall", "box");
    wall.position.set(0, 2.25, 6);
    wall.scaling.set(5, 3, 0.2);
    wall.material = stone;
    wall.renderingGroupId = RENDERING_GROUP.world;
    /** A crate as Play builds a primitive visual: pooled where the Scene pools, a mesh of its own otherwise. */
    const crate = (name: string, kind: string, x: number, z: number, material = brick, scale = 1) => {
      const root: Mesh = createPooledPrimitiveVisual(scene, name, kind) ?? createPrimitiveMesh(scene, name, kind);
      root.position.set(x, 0.75 * scale, z);
      root.scaling.setAll(scale);
      root.rotation.y = (x + z) * 0.3;
      applyWorldVisualGroup(root, { components: [] });
      setActorMeshMaterial(root, material);
      return root;
    };
    for (let row = 0; row < 5; row++)
      for (let column = 0; column < 6; column++)
        crate(`street-${row}-${column}`, row % 2 ? "sphere" : "box", -4.5 + column * 1.8, 10 + row * 2.5, column % 3 ? brick : stone);
    // In front of the wall, non-uniformly scaled ones included (their normals), and one beside it.
    for (const [index, x] of [-3, -1, 1, 3].entries()) crate(`front-${index}`, "box", x, 2, brick, index % 2 ? 0.6 : 1);
    crate("tall", "cylinder", 6, 4).scaling.set(0.7, 2.5, 0.7);
    crate("beside", "box", 8, 12);

    const sun = new DirectionalLight("sun", new Vector3(1, -0.6, 0.3).normalize(), scene);
    applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: true, range: 40, outerAngle: 70, innerAngle: 40 });

    const graph = new ForwardSceneFrameGraph(scene, { occlusion: true });
    const drawCalls = () => readEngineDrawCalls(engine as unknown as Parameters<typeof readEngineDrawCalls>[0]);
    const draw = async () => {
      const deadline = performance.now() + 20_000;
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
    const visible = await settle();
    occlusionSetting(true);
    const occluded = await settle();
    const pool = sceneInstancePool(scene).diagnostics();
    graph.dispose();
    await graph.whenReleased();
    return { visible, occluded, pool: { groups: pool.groups, pooled: pool.pooled } };
  } finally {
    scene.dispose();
  }
}

export async function runInstancingParityProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  engine.setSize(WIDTH, HEIGHT);
  try {
    const unpooled = await drawStreet(engine, false);
    const pooled = await drawStreet(engine, true);
    return {
      width: WIDTH, height: HEIGHT,
      unpooled: { visible: unpooled.visible.pixels, occluded: unpooled.occluded.pixels },
      pooled: { visible: pooled.visible.pixels, occluded: pooled.occluded.pixels },
      draws: {
        unpooled: { visible: unpooled.visible.draws, occluded: unpooled.occluded.draws },
        pooled: { visible: pooled.visible.draws, occluded: pooled.occluded.draws },
      },
      pool: pooled.pool,
    };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
