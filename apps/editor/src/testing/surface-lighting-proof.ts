/**
 * Test-build-only check that a Sprite's lit Shading Modes draw on a real Engine: a quad on the unlit Material's 2D-lit
 * variant under a 2D Point light and a dim Global light, and a quad on its 3D-lit variant under a 3D point light. Each
 * quad is read back near its light and past the light's reach.
 */
import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { normalizeRenderEffectsSettings, parseLight2DProperties } from "@haptic/core";
import { createAppWebGpuEngine, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { add2DLight } from "../../../../packages/render/src/lights-2d";
import { setUnlitMaterial, type UnlitBinding, type UnlitMaterialKey } from "../../../../packages/render/src/unlit-material";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const WIDTH = 96;
const HEIGHT = 48;
const SPRITE: UnlitMaterialKey = { textured: true, backFaceCulling: true, fog: true, role: "world" };

/** The canvas column of world X on the orthographic view (-8 to 8). */
const column = (x: number) => Math.round((x + 8) / 16 * WIDTH);

export async function runSurfaceLightingProof(backend: "webgl2" | "webgpu" = "webgl2") {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  document.getElementById("root")!.append(canvas);
  const engine: AbstractEngine = backend === "webgpu"
    ? await createAppWebGpuEngine(canvas)
    : new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(WIDTH, HEIGHT);
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0, 0, 0, 1);
    setSceneRenderSettings(scene, { mode: "pbr", effects: normalizeRenderEffectsSettings(undefined) });
    const camera = new FreeCamera("camera", new Vector3(0, 0, -10), scene);
    camera.setTarget(Vector3.Zero());
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -8; camera.orthoRight = 8; camera.orthoTop = 4; camera.orthoBottom = -4;
    scene.activeCamera = camera;
    const white = RawTexture.CreateRGBATexture(new Uint8Array(16 * 4).fill(255), 4, 4, scene, false, false, Texture.NEAREST_SAMPLINGMODE);
    const binding: UnlitBinding = { texture: white, color: [1, 1, 1], alpha: 1, cutoff: 0.4, blend: false, textureAlpha: true, twoSided: false };

    // Left: 2D-lit, a Point light at its left edge reaching 4 units, and a 0.1 Global light everywhere.
    const twoD = MeshBuilder.CreatePlane("two-d", { width: 7, height: 6 }, scene);
    twoD.position.set(-4, 0, 0);
    setUnlitMaterial(twoD, { ...SPRITE, lighting: "2d" }, binding);
    add2DLight(scene, { properties: parseLight2DProperties({ radius: 4 }), x: -7, y: 0, directionX: 0, directionY: 1 });
    add2DLight(scene, { properties: parseLight2DProperties({ lightKind: "global", intensity: 0.1 }), x: 0, y: 0, directionX: 0, directionY: 1 });

    // Right: 3D-lit, a point light in front of its left edge reaching 4 units.
    const threeD = MeshBuilder.CreatePlane("three-d", { width: 7, height: 6 }, scene);
    threeD.position.set(4, 0, 0);
    setUnlitMaterial(threeD, { ...SPRITE, lighting: "3d" }, binding);
    const light = new PointLight("point", new Vector3(1.5, 0, -1), scene);
    light.range = 4;
    light.intensity = 4;

    const graph = new ForwardSceneFrameGraph(scene);
    const deadline = performance.now() + 30_000;
    await graph.prepare(camera);
    while (!graph.readiness(camera).ready) {
      if (performance.now() > deadline) throw new Error("Surface lighting readiness timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    for (let presented = 0; presented < 2;) {
      engine.beginFrame();
      let rendered: boolean;
      try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
      if (rendered) presented++;
      else {
        if (performance.now() > deadline) throw new Error("Surface lighting presentation timed out");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
        await graph.prepare(camera);
      }
    }
    const raw = await engine.readPixels(0, 0, WIDTH, HEIGHT);
    const pixels = toRgbaPixels(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), readbackChannelOrder(engine.isWebGPU));
    const red = (x: number) => pixels[((HEIGHT / 2) * WIDTH + column(x)) * 4]!;
    graph.dispose();
    await graph.whenReleased();
    return {
      twoDNear: red(-6.8), twoDFar: red(-1),
      threeDNear: red(1.6), threeDFar: red(7),
    };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
