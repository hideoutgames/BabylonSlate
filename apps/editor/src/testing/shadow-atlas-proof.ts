/**
 * Test-build-only proof of the shadow atlas's sampling: one fixed frame through the Forward FrameGraph, a lit graph
 * Material under a shadowed sun (four cascades over the visible ground), a shadowed spot light and a shadowed point
 * light, with volumetric lighting marching all three, at the highest filter quality with PCF and then with Contact
 * Hardening. Each capture is the presented frame's bytes, so two builds' frames can be compared byte for byte, and each
 * map's tiles, so a capture shows that every map drew. Then the Scene is disposed and the scene built again, its casters
 * moved, in a new Scene of the same Engine, which takes the first Scene's atlas over (`shadow-atlas.ts`, `ParkedAtlas`)
 * with the depth the first Scene left in it; then that Scene is disposed, its parked atlas freed, and the moved scene built
 * a third time on a fresh atlas. The second and third PCF frames (`handOver`) must be the same, byte for byte: nothing
 * samples the depth an atlas brings from another Scene.
 */
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import {
  normalizeCelShadingSettings,
  normalizeRenderEffectsSettings,
  normalizeRenderingQuality,
  normalizeShadowSettings,
} from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, setSceneRenderSettings, largeWorldEngineOptions } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { discardParkedShadowAtlas } from "../../../../packages/render/src/shadow-atlas";
import { readShadowAtlasPages, type ShadowAtlasPageDigest } from "./shadow-atlas-readback";

export type ShadowAtlasCapture = {
  filter: "pcf" | "pcss";
  width: number;
  height: number;
  /** The presented frame, RGBA bytes from the bottom row up. */
  frame: number[];
  /** Per shadowed light, its map's tile sizes (one per cascade or face), and the sun's cascade ends as drawn. */
  maps: { light: string; tiles: number[] }[];
  cascadeEnds: number[];
  /** The atlas's pages as the frame was captured: every texel's depth bits, digested. */
  atlas: ShadowAtlasPageDigest[];
};

export async function runShadowAtlasProof(options: { largeWorld?: boolean } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, ...largeWorldEngineOptions(options.largeWorld === true) });
  engine.setSize(canvas.width, canvas.height);
  const sampling: Record<string, number> = {};
  const stopRecording = recordShadowSampling(engine, sampling);
  try {
    const first = await shadowedScene(engine, canvas);
    let captures: ShadowAtlasCapture[];
    let atlas: unknown;
    try {
      captures = [await first.capture("pcf"), await first.capture("pcss")];
      atlas = first.atlas();
    } finally {
      await first.dispose();
    }
    const moved = async () => {
      const scene = await shadowedScene(engine, canvas, 1.5);
      try {
        return { frame: (await scene.capture("pcf")).frame, atlas: scene.atlas() };
      } finally {
        await scene.dispose();
      }
    };
    const taken = await moved();
    const parked = discardParkedShadowAtlas(engine);
    const fresh = await moved();
    const handOver = {
      sameAtlas: atlas !== null && taken.atlas === atlas, freshAtlas: parked && fresh.atlas !== atlas,
      frame: taken.frame, freshFrame: fresh.frame,
    };
    return { captures, handOver, sampling, renderer: engine.getGlInfo().renderer };
  } finally {
    stopRecording();
    engine.dispose();
    canvas.remove();
  }
}

/**
 * The proof's scene in a new Scene of `engine`, its casters `shift` metres to the right: what captures its frame, its
 * atlas's render target, and its disposal.
 */
async function shadowedScene(engine: Engine, canvas: HTMLCanvasElement, shift = 0) {
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 3.5, -8), scene);
    camera.setTarget(new Vector3(0, 0, 12));
    camera.minZ = 0.1;
    camera.maxZ = 120;
    scene.activeCamera = camera;
    const settings = (filter: "pcf" | "pcss") => setSceneRenderSettings(scene, {
      mode: "pbr",
      effects: normalizeRenderEffectsSettings({
        ambientOcclusion: { enabled: false },
        reflections: { enabled: false },
        volumetricLighting: { enabled: true, steps: 16, maxLights: 4, density: 0.04, maxDistance: 30, intensity: 1 },
      }),
      cel: normalizeCelShadingSettings({ outlinesEnabled: false }),
      quality: normalizeRenderingQuality({ postprocessing: { profile: "high", preset: "high" } }),
      shadows: normalizeShadowSettings({
        // First Cascade Detail at twice the map size: the pages hold a first cascade tile larger than the others.
        profile: "high", cascades: 4, mapSize: 1024, firstCascadeScale: 2, localMapSize: 1024, maxLocalLights: 4, distance: 40, filter,
        filterQuality: "high", softness: 0.05, screenShadows: "off", reflections: false,
      }),
    });
    settings("pcf");

    const doc = createDefaultMaterialDocument("lit");
    doc.nodes.find((node) => node.id === "baseColor")!.properties.value = [0.8, 0.8, 0.8];
    const output = doc.nodes.find((node) => node.id === "output")!.properties;
    output[materialPinDefaultPropertyKey("metallic")] = [0];
    output[materialPinDefaultPropertyKey("roughness")] = [0.7];
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("the Material did not lower");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "lit" });
    if (!compiled.ok) throw new Error("the Material did not compile");
    await compiled.ready;
    const lit = compiled.material;

    const ground = MeshBuilder.CreateGround("ground", { width: 40, height: 90 }, scene);
    ground.position.z = 35;
    ground.material = lit;
    // Casters along the view, one or more in each cascade's slice.
    [[-1.5, 0], [1.5, 3], [-2, 7], [2.5, 12], [-3, 20], [3, 30], [0, 38]].forEach(([x, z], index) => {
      const box = MeshBuilder.CreateBox(`box${index}`, { width: 1 + z! / 20, height: 1.5 + z! / 15, depth: 1 + z! / 20 }, scene);
      box.position.set(x! + shift, (1.5 + z! / 15) / 2, z!);
      box.rotation.y = 0.3 * index;
      box.material = lit;
    });
    const ball = MeshBuilder.CreateSphere("ball", { diameter: 0.9, segments: 16 }, scene);
    ball.position.set(-3, 1.2, 4);
    ball.material = lit;
    const post = MeshBuilder.CreateCylinder("post", { diameter: 0.4, height: 1.4, tessellation: 16 }, scene);
    post.position.set(3.5, 0.7, 7);
    post.material = lit;

    const sun = new DirectionalLight("sun", new Vector3(0.4, -0.7, 0.5).normalize(), scene);
    applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: true });
    const spot = new SpotLight("spot", new Vector3(-3, 4, 3.5), new Vector3(0, -1, 0.15), Math.PI / 2, 2, scene);
    applyAuthoredLightProperties(spot, { color: [1, 0.6, 0.4], intensity: 30, castShadows: true, range: 12, outerAngle: 70, innerAngle: 40 });
    const lamp = new PointLight("lamp", new Vector3(3.5, 2.4, 6), scene);
    applyAuthoredLightProperties(lamp, { color: [0.5, 0.7, 1], intensity: 20, castShadows: true, range: 9 });

    const graph = new ForwardSceneFrameGraph(scene);
    const capture = async (filter: "pcf" | "pcss"): Promise<ShadowAtlasCapture> => {
      settings(filter);
      const deadline = performance.now() + 30_000;
      await graph.prepare(camera);
      while (!graph.readiness(camera).ready) {
        if (performance.now() > deadline) throw new Error(`${filter}: readiness timed out`);
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
        await graph.prepare(camera);
      }
      // The maps draw on the first frames; the last one is the capture.
      for (let presented = 0; presented < 8;) {
        engine.beginFrame();
        let rendered: boolean;
        try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
        if (rendered) presented++;
        else {
          if (performance.now() > deadline) throw new Error(`${filter}: presentation timed out`);
          await new Promise<void>((resolve) => setTimeout(resolve, 16));
          await graph.prepare(camera);
        }
      }
      const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
      const tiles = (generator: unknown) =>
        ((generator as unknown as { tiles?: { size: number }[] } | null)?.tiles ?? []).map((tile) => tile.size);
      return {
        filter,
        width: canvas.width,
        height: canvas.height,
        frame: Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)),
        maps: [sun, spot, lamp].map((light) => ({ light: light.name, tiles: tiles(light.getShadowGenerator()) })),
        cascadeEnds: [...((sun.getShadowGenerator() as unknown as { cascadeEnds?: number[] } | null)?.cascadeEnds ?? [])],
        atlas: await readShadowAtlasPages(scene),
      };
    };
    return {
      capture,
      atlas: () => sun.getShadowGenerator()?.getShadowMap()?.renderTarget ?? null,
      dispose: async () => {
        graph.dispose();
        await graph.whenReleased();
        scene.dispose();
      },
    };
  } catch (error) {
    scene.dispose();
    throw error;
  }
}

/**
 * Records how the driver's translation samples the atlas: in every shader compiled from now on that declares it, the
 * distinct translated lines comparing against a texture (ANGLE's `WEBGL_debug_shaders`; on D3D11 `SampleCmp` or
 * `SampleCmpLevelZero`), with how many shaders hold each. Read at compile time, as Babylon deletes its shaders once a
 * program links. Empty where the extension is missing. The returned function stops recording.
 */
function recordShadowSampling(engine: Engine, lines: Record<string, number>): () => void {
  const gl = engine._gl as WebGL2RenderingContext;
  const debug = gl.getExtension("WEBGL_debug_shaders");
  if (!debug) return () => {};
  const own = gl as unknown as { compileShader: WebGL2RenderingContext["compileShader"] };
  const compile = gl.compileShader;
  own.compileShader = (shader: WebGLShader) => {
    compile.call(gl, shader);
    if (!(gl.getShaderSource(shader) ?? "").includes("hapticShadowAtlas")) return;
    const found = new Set<string>();
    for (const line of debug.getTranslatedShaderSource(shader).split("\n"))
      if (/SampleCmp|sample_compare/.test(line)) found.add(line.trim());
    for (const line of found) lines[line] = (lines[line] ?? 0) + 1;
  };
  return () => { delete (gl as unknown as Record<string, unknown>).compileShader; };
}
