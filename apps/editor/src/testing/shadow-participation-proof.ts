/**
 * Test-build-only oracle for a MeshComponent's Cast Shadows and Receive Shadows: a cube held over a plane (both primitive
 * visuals sharing one Material) under a shadowed sun, drawn through the Forward FrameGraph with each Cast/Receive
 * combination on the cube and on the plane, as each host draws (`ShadowParticipationHost`), with Screen-Space Shadows
 * off and at High. Each capture is compared with the same view under an unshadowed sun, against a ray-cast mask of the
 * plane pixels the cube hides from the sun.
 */
import { Color4, DirectionalLight, Engine, FreeCamera, Matrix, Ray, Scene, Vector3, type AbstractEngine, type AbstractMesh, type Mesh } from "@babylonjs/core";
import { normalizeRenderingQuality, normalizeShadowSettings, type ScreenShadowsQuality } from "@haptic/core";
import {
  applyAuthoredLightProperties, compileMaterialPlan, createAppWebGpuEngine, createPrimitiveMesh, setSceneRenderSettings,
} from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument } from "@haptic/shader-graph";
import { setSceneInstancing } from "../../../../packages/render/src/instance-pool";
import { sceneShadowController } from "../../../../packages/render/src/shadow-controller";
import { createPooledPrimitiveVisual } from "../../../../packages/render/src/pooled-primitive-visual";
import { setActorMeshMaterial } from "../../../../packages/render/src/pooled-visuals";
import { allowSceneScreenShadows } from "../../../../packages/render/src/render-settings";
import { applyWorldVisualGroup } from "../../../../packages/render/src/sorting";
import { setSceneBindsPreviousEffects } from "../../../../packages/render/src/variant-swaps";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const WIDTH = 160;
const HEIGHT = 120;

type Flags = { cast: boolean; receive: boolean };
/** How a host draws: the editor (Materials frozen, primitives pooled), Play (pooled, not frozen), or unpooled and frozen. */
export type ShadowParticipationHost = "editor" | "play" | "unpooled";
export type ShadowParticipationCase = {
  host: ShadowParticipationHost;
  screenShadows: ScreenShadowsQuality;
  /** Whose toggles change: the cube's, the plane's at both on. */
  target: "cube" | "plane";
  flags: Flags;
  /** Plane pixels the cube hides from the sun that read shadowed, of all such pixels. */
  shadowed: number;
  umbra: number;
  /** Plane pixels the cube does not hide that read shadowed. */
  stray: number;
  open: number;
};

const COMBINATIONS: Flags[] = [
  { cast: true, receive: true }, { cast: true, receive: false }, { cast: false, receive: true }, { cast: false, receive: false },
];

async function drawCases(engine: AbstractEngine, host: ShadowParticipationHost, screenShadows: ScreenShadowsQuality): Promise<ShadowParticipationCase[]> {
  const pooled = host !== "unpooled";
  const order = readbackChannelOrder(engine.isWebGPU);
  const read = async () => {
    const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
    return toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order);
  };
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    setSceneInstancing(scene, pooled);
    const camera = new FreeCamera("camera", new Vector3(0, 2.6, -4.2), scene);
    camera.setTarget(new Vector3(0, 0.6, 0.3));
    camera.minZ = 0.1;
    camera.maxZ = 100;
    scene.activeCamera = camera;
    setSceneBindsPreviousEffects(scene);
    allowSceneScreenShadows(scene, () => true);
    setSceneRenderSettings(scene, { quality: normalizeRenderingQuality({}), shadows: normalizeShadowSettings({ screenShadows }) });
    const doc = createDefaultMaterialDocument("matte");
    doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.8, 0.8, 0.8];
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("matte did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "matte" });
    if (!compiled.ok) throw new Error("matte did not compile");
    await compiled.ready;
    const material = compiled.material;
    // The editor freezes the Materials it is not editing: a draw sharing the previous draw's Material and Effect then
    // skips its bindings.
    if (host !== "play") material.freeze();
    /** A visual as the editor (a mesh of its own) or Play (pooled where the Scene pools) builds it. */
    const visual = (name: string, kind: string) => {
      const root: Mesh = createPooledPrimitiveVisual(scene, name, kind) ?? createPrimitiveMesh(scene, name, kind);
      applyWorldVisualGroup(root, { components: [] });
      setActorMeshMaterial(root, material);
      return root;
    };
    // The cube first: the plane draws after it, so with a frozen Material the plane's draw is the one that may skip its
    // bindings, as in the editor.
    const cube = visual("cube", "box");
    cube.position.set(0, 1, 0);
    const plane = visual("plane", "box");
    plane.position.set(0, -0.05, 0);
    plane.scaling.set(8, 0.1, 8);
    const sun = new DirectionalLight("sun", new Vector3(0.40274806222011805, -0.7048091088852064, 0.583984690219171).normalize(), scene);
    const sunShadows = (castShadows: boolean) =>
      applyAuthoredLightProperties(sun, { color: [1, 1, 1], intensity: 3, castShadows, range: 40, outerAngle: 70, innerAngle: 40 });
    sunShadows(true);
    const controller = sceneShadowController(scene);

    const graph = new ForwardSceneFrameGraph(scene);
    const draw = async () => {
      const deadline = performance.now() + 20_000;
      for (;;) {
        await graph.prepare(camera);
        engine.beginFrame();
        let rendered: boolean;
        try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
        if (rendered) return read();
        if (performance.now() > deadline) throw new Error("The view did not present");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    };
    const settle = async () => {
      let last = await draw();
      for (let frame = 0; frame < 12; frame++) last = await draw();
      return last;
    };
    const partOf = (mesh: AbstractMesh, root: Mesh) => mesh === root || mesh.parent === root;
    // Per pixel: whether the plane is seen and whether the cube hides it from the sun.
    const toSun = sun.direction.normalizeToNew().scaleInPlace(-1);
    const onPlane: boolean[] = [];
    const umbra: boolean[] = [];
    for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
    for (let row = 0; row < HEIGHT; row++) {
      const y = engine.isWebGPU ? row + 0.5 : HEIGHT - row - 0.5;
      for (let column = 0; column < WIDTH; column++) {
        const ray = scene.createPickingRay(column + 0.5, y, Matrix.Identity(), camera);
        const hit = scene.pickWithRay(ray, (mesh) => partOf(mesh, plane) || partOf(mesh, cube));
        const point = hit?.pickedPoint;
        const seen = !!point && !!hit.pickedMesh && partOf(hit.pickedMesh, plane);
        onPlane.push(seen);
        umbra.push(seen && scene.pickWithRay(new Ray(point!.add(toSun.scale(0.002)), toSun, 100), (mesh) => partOf(mesh, cube))?.hit === true);
      }
    }
    // Away from the umbra's edge, where filtering blends: a pixel two or more pixels from any umbra pixel.
    const nearUmbra = (pixel: number) => {
      const row = Math.floor(pixel / WIDTH), column = pixel % WIDTH;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const r = row + dy, c = column + dx;
          if (r >= 0 && r < HEIGHT && c >= 0 && c < WIDTH && umbra[r * WIDTH + c] !== umbra[pixel]) return true;
        }
      return false;
    };
    const darker = (drawn: number[], open: number[], pixel: number) => {
      let full = 0, seen = 0;
      for (let channel = 0; channel < 3; channel++) {
        full += open[pixel * 4 + channel]!;
        seen += drawn[pixel * 4 + channel]!;
      }
      return full > 60 && seen < 0.75 * full;
    };

    sunShadows(false);
    const unshadowed = await settle();
    sunShadows(true);
    const cases: ShadowParticipationCase[] = [];
    for (const target of ["cube", "plane"] as const)
      for (const flags of COMBINATIONS) {
        controller.setParticipation(target === "cube" ? cube : plane, { castShadows: flags.cast, receiveShadows: flags.receive });
        controller.setParticipation(target === "cube" ? plane : cube, { castShadows: true, receiveShadows: true });
        const drawn = await settle();
        const count = { shadowed: 0, umbra: 0, stray: 0, open: 0 };
        for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
          if (!onPlane[pixel] || nearUmbra(pixel)) continue;
          if (umbra[pixel]) {
            count.umbra += 1;
            if (darker(drawn, unshadowed, pixel)) count.shadowed += 1;
          } else {
            count.open += 1;
            if (darker(drawn, unshadowed, pixel)) count.stray += 1;
          }
        }
        cases.push({ host, screenShadows, target, flags, ...count });
      }
    graph.dispose();
    // WebGPU destroys disposed targets (a world view's multisampled ones) at the end of its next frame, which the
    // release waits for from a microtask on.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    scene.getEngine().beginFrame();
    scene.getEngine().endFrame();
    await graph.whenReleased();
    return cases;
  } finally {
    scene.dispose();
  }
}

export async function runShadowParticipationProof(backend: "webgl2" | "webgpu") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, useLargeWorldRendering: true });
  engine.setSize(WIDTH, HEIGHT);
  try {
    const cases: ShadowParticipationCase[] = [];
    const runs: [ShadowParticipationHost, ScreenShadowsQuality][] = [["editor", "off"], ["editor", "high"], ["play", "high"], ["unpooled", "high"]];
    for (const [host, screenShadows] of runs) cases.push(...await drawCases(engine, host, screenShadows));
    return { width: WIDTH, height: HEIGHT, cases };
  } finally {
    engine.dispose();
    canvas.remove();
  }
}
