/**
 * Test-build-only check that the engine's unlit Material (`unlit-material.ts`) draws what the Standard materials it
 * replaces drew. Each quad is drawn twice in the same view: once with a frozen copy of the Standard setup the engine
 * used before the migration, once with the unlit binding, in Legacy Display (PBR and CEL) and Scene Linear (no tone
 * mapping and ACES), without fog and with linear and exponential fog. The two images are compared channel by channel.
 */
import {
  Camera, Color3, Color4, DynamicTexture, Engine, FreeCamera, MeshBuilder, Scene, StandardMaterial, Texture,
  Vector3, VertexBuffer, type AbstractEngine, type Mesh,
} from "@babylonjs/core";
import { normalizeRenderEffectsSettings, type RenderMode } from "@haptic/core";
import { createAppWebGpuEngine, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { applyOverlayVisualStyle, enableOverlayVisualMaterial } from "../../../../packages/render/src/overlay-visual-style";
import { atlasImageProcessing, setUnlitMaterial, type UnlitBinding, type UnlitMaterialKey } from "../../../../packages/render/src/unlit-material";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";

const WIDTH = 96;
const HEIGHT = 48;

type Case = {
  name: string;
  /** The Standard setup the engine used (`texture` is the flipped one for `flipped` cases). */
  standard: (material: StandardMaterial, texture: Texture) => void;
  /** Samples the gradient through a non-identity texture matrix (vertically flipped), as a KTX2 sprite does. */
  flipped?: boolean;
  key: UnlitMaterialKey;
  binding: (texture: Texture) => UnlitBinding;
  prepare?: (mesh: Mesh) => void;
};

const base = (material: StandardMaterial) => {
  material.disableLighting = true;
  material.emissiveColor = Color3.White();
  material.diffuseColor = Color3.White();
};
const unbound: UnlitBinding = { texture: null, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: false, textureAlpha: true, twoSided: false };

const CASES: Case[] = [
  {
    // Painter 2D's material (`painter2d-mesh.ts` before the migration).
    name: "painter",
    standard: (material, texture) => {
      base(material);
      material.backFaceCulling = false;
      material.useAlphaFromDiffuseTexture = true;
      material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
      material.diffuseTexture = texture;
    },
    key: { textured: true, backFaceCulling: false, fog: true, role: "world" },
    binding: (texture) => ({ ...unbound, texture, blend: true }),
  },
  {
    name: "cutout",
    standard: (material, texture) => {
      base(material);
      material.useAlphaFromDiffuseTexture = true;
      material.transparencyMode = StandardMaterial.MATERIAL_ALPHATEST;
      material.alphaCutOff = 0.4;
      material.diffuseTexture = texture;
    },
    key: { textured: true, backFaceCulling: true, fog: true, role: "world" },
    binding: (texture) => ({ ...unbound, texture, cutoff: 0.4 }),
  },
  {
    // A sprite (`mesh-assets.ts` before the migration), its texture flipped as a KTX2's is.
    name: "sprite",
    flipped: true,
    standard: (material, texture) => {
      material.disableLighting = true;
      material.emissiveColor = Color3.White();
      material.useAlphaFromDiffuseTexture = true;
      material.transparencyMode = StandardMaterial.MATERIAL_ALPHATEST;
      material.alphaCutOff = 0.4;
      material.diffuseTexture = texture;
      material.emissiveTexture = texture;
    },
    key: { textured: true, backFaceCulling: true, fog: true, role: "world" },
    binding: (texture) => ({ ...unbound, texture, cutoff: 0.4 }),
  },
  {
    // A tilemap chunk: both sides, no fog, the atlas's exact display colours.
    name: "tile",
    standard: (material, texture) => {
      material.disableLighting = true;
      material.emissiveColor = Color3.White();
      material.useAlphaFromDiffuseTexture = true;
      material.transparencyMode = StandardMaterial.MATERIAL_ALPHATEST;
      material.alphaCutOff = 0.4;
      material.diffuseTexture = texture;
      material.emissiveTexture = texture;
      material.backFaceCulling = false;
      material.fogEnabled = false;
      material.imageProcessingConfiguration = atlasImageProcessing(material.getScene());
    },
    key: { textured: true, backFaceCulling: false, fog: false, role: "world", imageProcessing: "atlas" },
    binding: (texture) => ({ ...unbound, texture, cutoff: 0.4 }),
  },
  {
    name: "opaque",
    standard: (material) => {
      material.disableLighting = true;
      material.emissiveColor = new Color3(0.3, 0.6, 0.9);
    },
    key: { textured: false, backFaceCulling: true, fog: true, role: "world" },
    binding: () => ({ ...unbound, color: [0.3, 0.6, 0.9] }),
  },
  {
    name: "translucent",
    standard: (material) => {
      material.disableLighting = true;
      material.emissiveColor = new Color3(0.9, 0.3, 0.2);
      material.alpha = 0.5;
    },
    key: { textured: false, backFaceCulling: true, fog: true, role: "world" },
    binding: () => ({ ...unbound, color: [0.9, 0.3, 0.2], alpha: 0.5 }),
  },
  {
    name: "vertexColor",
    standard: (material) => base(material),
    key: { textured: false, backFaceCulling: true, fog: true, role: "world" },
    binding: () => ({ ...unbound }),
    prepare: (mesh) => {
      const count = mesh.getTotalVertices();
      const colors = new Float32Array(count * 4);
      for (let index = 0; index < count; index++) colors.set([index / count, 1 - index / count, 0.5, 1], index * 4);
      mesh.setVerticesData(VertexBuffer.ColorKind, colors);
    },
  },
  {
    name: "tinted",
    standard: (material, texture) => {
      base(material);
      material.useAlphaFromDiffuseTexture = true;
      material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
      material.diffuseTexture = texture;
    },
    key: { textured: true, backFaceCulling: true, fog: true, role: "world" },
    binding: (texture) => ({ ...unbound, texture, blend: true }),
    prepare: (mesh) => applyOverlayVisualStyle(mesh, { opacity: 0.6, tint: [1, 0.5, 0.25, 1] }),
  },
  {
    name: "fading",
    standard: (material, texture) => {
      base(material);
      material.useAlphaFromDiffuseTexture = true;
      material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
      material.diffuseTexture = texture;
    },
    key: { textured: true, backFaceCulling: true, fog: true, role: "world" },
    binding: (texture) => ({ ...unbound, texture, blend: true }),
    prepare: (mesh) => { mesh.visibility = 0.5; },
  },
];

type Mode = {
  name: string; mode: RenderMode; pipeline: "legacyDisplay" | "sceneLinear"; toneMapping: "none" | "aces";
  /**
   * Ambient occlusion and reflections: they read the geometry pass's depth, normal and reflectivity. (Temporal
   * anti-aliasing would blend each draw with the one before.)
   */
  spatial?: boolean;
};
const MODES: Mode[] = [
  { name: "legacy", mode: "pbr", pipeline: "legacyDisplay", toneMapping: "none" },
  { name: "cel", mode: "cel", pipeline: "legacyDisplay", toneMapping: "none" },
  { name: "linear", mode: "pbr", pipeline: "sceneLinear", toneMapping: "none" },
  { name: "linearAces", mode: "pbr", pipeline: "sceneLinear", toneMapping: "aces" },
  { name: "spatial", mode: "pbr", pipeline: "sceneLinear", toneMapping: "none", spatial: true },
];
const FOGS = [
  { name: "none", mode: Scene.FOGMODE_NONE },
  { name: "linear", mode: Scene.FOGMODE_LINEAR },
  { name: "exp2", mode: Scene.FOGMODE_EXP2 },
];

/** A gradient with an alpha ramp: smooth colour, coverage on both sides of the cutoff. */
function gradientTexture(scene: Scene): DynamicTexture {
  const texture = new DynamicTexture("parity-gradient", { width: 32, height: 32 }, scene, false, Texture.BILINEAR_SAMPLINGMODE);
  const context = texture.getContext();
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    context.fillStyle = `rgba(${x * 8}, ${255 - y * 8}, ${(x + y) * 4}, ${(x + 1) / 32})`;
    context.fillRect(x, y, 1, 1);
  }
  texture.hasAlpha = true;
  texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.update();
  return texture;
}

export async function runUnlitParityProof(backend: "webgl2" | "webgpu" = "webgl2") {
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
    scene.clearColor = new Color4(0.5, 0.5, 0.5, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 0, -10), scene);
    camera.setTarget(Vector3.Zero());
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -8; camera.orthoRight = 8; camera.orthoTop = 4; camera.orthoBottom = -4;
    scene.activeCamera = camera;
    scene.fogColor = new Color3(0.2, 0.4, 0.8);
    scene.fogStart = 4; scene.fogEnd = 20; scene.fogDensity = 0.08;
    const texture = gradientTexture(scene);
    const flipped = gradientTexture(scene);
    flipped.vScale = -1;
    // Behind every quad, in both draws: the geometry effects read the quads' depth and normals against it.
    const backdrop = MeshBuilder.CreatePlane("backdrop", { width: 20, height: 10 }, scene);
    backdrop.position.z = 1;
    const backdropMaterial = new StandardMaterial("backdrop", scene);
    backdropMaterial.disableLighting = true;
    backdropMaterial.emissiveColor = new Color3(0.35, 0.35, 0.35);
    backdrop.material = backdropMaterial;
    const quads = CASES.map((entry, index) => {
      const mesh = MeshBuilder.CreatePlane(entry.name, { width: 3.2, height: 3.6 }, scene);
      mesh.position.set(-7 + (index % 5) * 3.5, index < 5 ? 1.9 : -1.9, 0);
      const standard = new StandardMaterial(`${entry.name}-standard`, scene);
      entry.standard(standard, entry.flipped ? flipped : texture);
      entry.prepare?.(mesh);
      return { entry, mesh, standard };
    });
    const graph = new ForwardSceneFrameGraph(scene);
    const order = readbackChannelOrder(engine.isWebGPU);
    const draw = async (): Promise<number[]> => {
      const deadline = performance.now() + 20_000;
      await graph.prepare(camera);
      while (!graph.readiness(camera).ready) {
        if (performance.now() > deadline) throw new Error("Unlit parity readiness timed out");
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
      for (let presented = 0; presented < 2;) {
        engine.beginFrame();
        let rendered: boolean;
        try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
        if (rendered) presented++;
        else {
          if (performance.now() > deadline) throw new Error("Unlit parity presentation timed out");
          await new Promise<void>((resolve) => setTimeout(resolve, 16));
          await graph.prepare(camera);
        }
      }
      const pixels = await engine.readPixels(0, 0, WIDTH, HEIGHT);
      return Array.from(toRgbaPixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), order));
    };
    const results: { mode: string; fog: string; standard: number[]; unlit: number[] }[] = [];
    for (const mode of MODES) {
      const effects = normalizeRenderEffectsSettings(undefined);
      effects.colorPipeline.mode = mode.pipeline;
      effects.toneMapping = mode.toneMapping;
      if (mode.spatial) {
        effects.ambientOcclusion.enabled = true;
        effects.ambientOcclusion.strength = 4;
        effects.reflections.enabled = true;
      }
      setSceneRenderSettings(scene, { mode: mode.mode, effects });
      for (const fog of FOGS) {
        scene.fogMode = fog.mode;
        for (const quad of quads) {
          quad.mesh.material = quad.standard;
          enableOverlayVisualMaterial(quad.mesh);
        }
        const standard = await draw();
        for (const quad of quads) setUnlitMaterial(quad.mesh, quad.entry.key, quad.entry.binding(quad.entry.flipped ? flipped : texture));
        const unlit = await draw();
        results.push({ mode: mode.name, fog: fog.name, standard, unlit });
      }
    }
    graph.dispose();
    await graph.whenReleased();
    return { width: WIDTH, height: HEIGHT, cases: CASES.map((entry) => entry.name), results };
  } finally {
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
