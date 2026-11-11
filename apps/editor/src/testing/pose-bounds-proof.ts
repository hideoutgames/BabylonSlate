/**
 * Test-build-only oracle for pose bounds (`pose-bounds.ts`): two actors of one skinned model, loaded and instantiated
 * as Play loads a Model (the glTF loader, a skeleton each, their geometry shared), posed far from where their vertices
 * were authored, under a shadowed sun. The Scene is drawn through the Forward FrameGraph twice: once with the actors
 * culled by bounds that follow their skeletons, and once with them drawn whatever the view, as before bounds followed.
 * The two images must be the same pixel for pixel at every stage (an actor in view, across the screen's edge, out of
 * view, and bent back into it), and the culled run must draw less where no actor shows.
 *
 * The file's joints are bound upright at the origin and posed by their nodes: under an armature that is moved,
 * turned and scaled, with the root joint carried further and the arm bent. So the pose is nowhere near the bounds of
 * the vertices as authored, which is what a cull that trusted those would get wrong.
 */
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { normalizeRenderingQuality, normalizeShadowSettings } from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, createAppWebGpuEngine, createPrimitiveMesh, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { encodeGlbJsonBin } from "../../../../packages/assets/src/importers/glb-parse";
import { cullSceneByWhatShows } from "../../../../packages/render/src/cull-accuracy";
import { readEngineDrawCalls } from "../../../../packages/render/src/draw-calls";
import { loadModelContainer } from "../../../../packages/render/src/model-container";
import { followsPose, setScenePoseBounds } from "../../../../packages/render/src/pose-bounds";
import { setSceneBindsPreviousEffects } from "../../../../packages/render/src/variant-swaps";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const WIDTH = 240;
const HEIGHT = 160;
/** Where the scene stands: the floating origin's offset is in every matrix the bounds are placed by. */
const PLACE = new Vector3(4_000, 0, -2_500);

const FLOAT = 5126, UNSIGNED_BYTE = 5121, UNSIGNED_SHORT = 5123;

/**
 * A skinned column three units tall, bound upright at the origin: a square tube of four rings, its lower half moved by
 * the root joint and its upper half by the arm joint (the ring between them by both). The joints' nodes pose it away:
 * the armature stands six units along x, turned and enlarged, the root joint is carried four units along z, and the
 * arm is bent at its joint.
 */
function skinnedColumn(): Uint8Array {
  const positions: number[] = [], normals: number[] = [], joints: number[] = [], weights: number[] = [], indices: number[] = [];
  const corners = [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]] as const;
  for (let ring = 0; ring < 4; ring += 1) {
    for (const [x, z] of corners) {
      positions.push(x, ring, z);
      const length = Math.hypot(x, z);
      normals.push(x / length, 0, z / length);
      joints.push(0, 1, 0, 0);
      weights.push(...(ring < 2 ? [1, 0] : ring === 2 ? [0.5, 0.5] : [0, 1]), 0, 0);
    }
  }
  for (let ring = 0; ring < 3; ring += 1) {
    for (let side = 0; side < 4; side += 1) {
      const a = ring * 4 + side, b = ring * 4 + (side + 1) % 4, c = a + 4, d = b + 4;
      indices.push(a, c, b, b, c, d);
    }
  }
  // The arm joint is bound a unit and a half up the column.
  const inverseBinds = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1.5, 0, 1];
  const arrays: Array<Float32Array | Uint8Array | Uint16Array> = [
    Float32Array.from(positions), Float32Array.from(normals), Uint8Array.from(joints), Float32Array.from(weights),
    Uint16Array.from(indices), Float32Array.from(inverseBinds),
  ];
  let length = 0;
  const bufferViews = arrays.map((array) => {
    const view = { buffer: 0, byteOffset: length, byteLength: array.byteLength };
    length += array.byteLength + (4 - array.byteLength % 4) % 4;
    return view;
  });
  const bin = new Uint8Array(length);
  arrays.forEach((array, index) => bin.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), bufferViews[index]!.byteOffset));
  const turn = Quaternion.FromEulerAngles(0, 0.5, 0), bend = Quaternion.FromEulerAngles(0, 0, -0.9);
  return encodeGlbJsonBin(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [
        { name: "column", mesh: 0, skin: 0 },
        { name: "armature", children: [2], translation: [6, 0, 0], rotation: turn.asArray(), scale: [1.5, 1.5, 1.5] },
        { name: "root", children: [3], translation: [0, 0, 4] },
        { name: "arm", translation: [0, 1.5, 0], rotation: bend.asArray() },
      ],
      skins: [{ joints: [2, 3], inverseBindMatrices: 5, skeleton: 2 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 4 }] }],
      accessors: [
        { bufferView: 0, componentType: FLOAT, count: 16, type: "VEC3", min: [-0.3, 0, -0.3], max: [0.3, 3, 0.3] },
        { bufferView: 1, componentType: FLOAT, count: 16, type: "VEC3" },
        { bufferView: 2, componentType: UNSIGNED_BYTE, count: 16, type: "VEC4" },
        { bufferView: 3, componentType: FLOAT, count: 16, type: "VEC4" },
        { bufferView: 4, componentType: UNSIGNED_SHORT, count: indices.length, type: "SCALAR" },
        { bufferView: 5, componentType: FLOAT, count: 2, type: "MAT4" },
      ],
      bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
    },
    bin,
  );
}

type Run = {
  /** The image at each stage, the draw calls of the frame that drew it, and whether each actor's bounds follow its pose. */
  images: number[][];
  draws: number[];
  followed: boolean[];
};

async function matte(scene: Scene, name: string, color: [number, number, number]) {
  const doc = createDefaultMaterialDocument("matte");
  doc.nodes.find((node) => node.id === "baseColor")!.properties.value = color;
  const lowered = lowerMaterialDocument(doc);
  if (!lowered.ok) throw new Error(`${name} did not lower`);
  const compiled = compileMaterialPlan(lowered.plan, { scene, name });
  if (!compiled.ok) throw new Error(`${name} did not compile`);
  await compiled.ready;
  return compiled.material;
}

async function drawRun(engine: AbstractEngine, follow: boolean): Promise<Run> {
  const order = readbackChannelOrder(engine.isWebGPU);
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    // Before the Scene has a mesh: the reference run follows none, so each is drawn whatever the view.
    setScenePoseBounds(scene, follow);
    cullSceneByWhatShows(scene);
    const camera = new FreeCamera("camera", PLACE.clone(), scene);
    camera.minZ = 0.1;
    camera.maxZ = 200;
    scene.activeCamera = camera;
    setSceneBindsPreviousEffects(scene);
    setSceneRenderSettings(scene, {
      quality: normalizeRenderingQuality({}),
      shadows: normalizeShadowSettings({ screenShadows: "off", cascades: 3, distance: 60 }),
    });
    const grey = await matte(scene, "ground", [0.6, 0.6, 0.6]), red = await matte(scene, "actor", [0.9, 0.15, 0.1]);
    const ground: Mesh = createPrimitiveMesh(scene, "ground", "box");
    ground.material = grey;
    ground.position.copyFrom(PLACE).addInPlaceFromFloats(0, -0.1, 0);
    ground.scaling.set(80, 0.2, 80);
    const sun = new DirectionalLight("sun", new Vector3(0.4, -0.7, 0.58).normalize(), scene);
    applyAuthoredLightProperties(sun, { color: [1, 1, 1], intensity: 2, castShadows: true, range: 40, outerAngle: 70, innerAngle: 40 });

    // Two actors of the model, as Play instantiates one: clones that share the container's geometry, a skeleton each.
    const container = await loadModelContainer(scene, skinnedColumn(), "column");
    const actors = [0, 1].map((index) => {
      const entries = container.instantiateModelsToScene((name) => `${name}:${index}`, false, { doNotInstantiate: true });
      const root = new TransformNode(`actor:${index}`, scene);
      for (const node of entries.rootNodes) node.parent = root;
      root.position.copyFrom(PLACE).addInPlaceFromFloats(0, 0, index * 14);
      const mesh = root.getChildMeshes().find((child) => child.skeleton)! as Mesh;
      mesh.material = red;
      const joint = (name: string) => root.getChildTransformNodes().find((node) => node.name === `${name}:${index}`)!;
      return { root, mesh, armature: joint("armature"), arm: joint("arm") };
    });
    // The second actor is posed another way: its armature elsewhere, its arm bent back.
    actors[1]!.armature.position.set(-7, 0, 1);
    actors[1]!.arm.rotationQuaternion = Quaternion.FromEulerAngles(0.7, 0, 0.6);
    // Where the poses put the columns' feet, from where each actor stands (the loader mirrors the file's x): the
    // armature's place, and the root joint's four units, enlarged by half and turned half a radian, from it.
    const reach = [6 * Math.sin(0.5), 6 * Math.cos(0.5)] as const;
    const first = [-(6 + reach[0]), reach[1]] as const, second = [-(-7 + reach[0]), 14 + 1 + reach[1]] as const;

    const graph = new ForwardSceneFrameGraph(scene);
    const stage = async (from: [number, number, number], at: [number, number, number]) => {
      camera.position.copyFrom(PLACE).addInPlaceFromFloats(...from);
      camera.setTarget(PLACE.add(new Vector3(...at)));
      const deadline = performance.now() + 20_000;
      let image: number[] = [], draws = 0;
      for (let frame = 0; frame < 10;) {
        await graph.prepare(camera);
        engine.beginFrame();
        const before = readEngineDrawCalls(engine as unknown as Parameters<typeof readEngineDrawCalls>[0]);
        let rendered: boolean;
        try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
        draws = readEngineDrawCalls(engine as unknown as Parameters<typeof readEngineDrawCalls>[0]) - before;
        if (rendered) {
          frame += 1;
          const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
          image = toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
        } else if (performance.now() > deadline) throw new Error("The view did not present");
        else await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
      return { image, draws };
    };
    const stages = [
      // The first actor, whole, in the middle of the view.
      await stage([first[0], 3.5, first[1] - 11], [first[0], 2.3, first[1]]),
      // The view turned until the actor crosses its edge.
      await stage([first[0], 3.5, first[1] - 11], [first[0] + 7, 2.3, first[1]]),
      // Where the actors stand, with their vertices as authored, seen from between the poses: neither is posed there.
      await stage([0, 3, 7], [0, 1.5, 0]),
    ];
    // From that view, the first actor's armature carries its column to two units before where it stands.
    actors[0]!.armature.position.set(-reach[0], 0, 2 - reach[1]);
    stages.push(await stage([0, 3, 7], [0, 1.5, 0]));
    // And its arm swings over to the other side.
    actors[0]!.arm.rotationQuaternion = Quaternion.FromEulerAngles(0.4, 0, 1.2);
    stages.push(await stage([0, 3, 7], [0, 1.5, 0]));
    // The second actor, of the same geometry under its own skeleton.
    stages.push(await stage([second[0], 3.5, second[1] - 11], [second[0], 2.3, second[1]]));
    const followed = actors.map((actor) => followsPose(actor.mesh));
    graph.dispose();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    engine.beginFrame();
    engine.endFrame();
    await graph.whenReleased();
    container.dispose();
    return { images: stages.map((entry) => entry.image), draws: stages.map((entry) => entry.draws), followed };
  } finally {
    scene.dispose();
  }
}

export async function runPoseBoundsProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  engine.setSize(WIDTH, HEIGHT);
  try {
    const culled = await drawRun(engine, true);
    const always = await drawRun(engine, false);
    const stages = culled.images.map((image, index) => {
      const other = always.images[index]!;
      let differing = 0, actor = 0;
      for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
        let same = true;
        for (let channel = 0; channel < 4; channel += 1) if (image[pixel * 4 + channel] !== other[pixel * 4 + channel]) same = false;
        if (!same) differing += 1;
        // The actors' red, lit or in shade: no other surface is red.
        const red = other[pixel * 4]!, green = other[pixel * 4 + 1]!, blue = other[pixel * 4 + 2]!;
        if (red > 40 && red > green * 2 && red > blue * 2) actor += 1;
      }
      return { differing, actor, draws: { culled: culled.draws[index]!, always: always.draws[index]! } };
    });
    return { width: WIDTH, height: HEIGHT, stages, followed: { culled: culled.followed, always: always.followed }, images: { culled: culled.images, always: always.images } };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
