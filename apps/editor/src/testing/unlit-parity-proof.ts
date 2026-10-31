/**
 * Test-build-only check that the engine's unlit Material (`unlit-material.ts`) draws what the Standard materials (and
 * Text2D's MSDF shader) it replaces drew. Each quad is drawn twice in the same view: once with a frozen copy of the Standard setup the engine
 * used before the migration, once with the unlit binding, in Legacy Display (PBR and CEL) and Scene Linear (no tone
 * mapping and ACES), without fog and with linear and exponential fog. The two images are compared channel by channel.
 */
import {
  Camera, Color3, Color4, DynamicTexture, Engine, FreeCamera, MeshBuilder, RawTexture, Scene, StandardMaterial, Texture,
  Vector3, VertexBuffer, type AbstractEngine, type Material, type Mesh,
} from "@babylonjs/core";
import { normalizeRenderEffectsSettings, type RenderMode } from "@haptic/core";
import { createAppWebGpuEngine, setSceneRenderSettings } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { applyOverlayVisualStyle, enableOverlayVisualMaterial } from "../../../../packages/render/src/overlay-visual-style";
import { atlasImageProcessing, setUnlitMaterial, type UnlitBinding, type UnlitMaterialKey } from "../../../../packages/render/src/unlit-material";
import { msdfReferenceMaterial } from "./msdf-reference";
import { readbackChannelOrder, toRgbaPixels } from "./readback-channels";
import { StandardFogPlugin } from "./standard-reference";

const WIDTH = 96;
const HEIGHT = 48;

type Case = {
  name: string;
  /** The Standard setup the engine used (`texture` is the flipped one for `flipped` cases). */
  standard?: (material: StandardMaterial, texture: Texture) => void;
  /** A reference that is no Standard setup: Text2D's MSDF shader, over the distance-field atlas. */
  reference?: (scene: Scene, atlas: Texture) => Material;
  /**
   * Samples the distance-field atlas instead of the gradient. Not drawn with ambient occlusion and reflections: the
   * MSDF shader drew nothing into the geometry pass, and the unlit glyph writes it as every blended surface does.
   */
  msdf?: boolean;
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
    // 3D Text (`text3d-mesh.ts` before the migration): both sides, its back faces' normal flipped.
    name: "text3d",
    standard: (material) => {
      material.disableLighting = true;
      material.backFaceCulling = false;
      material.twoSidedLighting = true;
      material.emissiveColor = new Color3(0.9, 0.7, 0.1);
      material.diffuseColor = Color3.Black();
      material.specularColor = Color3.Black();
    },
    key: { textured: false, backFaceCulling: false, fog: true, role: "world" },
    binding: () => ({ ...unbound, color: [0.9, 0.7, 0.1], twoSided: true }),
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
  {
    // A Text2D MSDF glyph (`text2d-mesh.ts` before the migration): its fill alone, antialiased at its edge.
    name: "msdf",
    msdf: true,
    reference: (scene, atlas) => msdfReferenceMaterial(scene, [0.95, 0.85, 0.2], 0, [0, 0, 0], atlas),
    key: { textured: true, msdf: true, backFaceCulling: false, fog: false, role: "world", imageProcessing: "atlas" },
    binding: (atlas) => ({
      ...unbound, texture: atlas, color: [0.95, 0.85, 0.2], cutoff: 0.01, blend: true, textureAlpha: false,
      msdf: { strokeColor: [0, 0, 0], strokeWidth: 0 },
    }),
  },
  {
    // An outlined MSDF glyph (outline 4), fading, under an overlay tint.
    name: "msdfOutline",
    msdf: true,
    reference: (scene, atlas) => msdfReferenceMaterial(scene, [0.2, 0.9, 0.6], 4, [0.8, 0.1, 0.3], atlas),
    key: { textured: true, msdf: true, backFaceCulling: false, fog: false, role: "world", imageProcessing: "atlas" },
    binding: (atlas) => ({
      ...unbound, texture: atlas, color: [0.2, 0.9, 0.6], cutoff: 0.01, blend: true, textureAlpha: false,
      msdf: { strokeColor: [0.8, 0.1, 0.3], strokeWidth: 4 * 0.08 },
    }),
    prepare: (mesh) => {
      mesh.visibility = 0.8;
      applyOverlayVisualStyle(mesh, { opacity: 0.9, tint: [1, 0.8, 0.6, 1] });
    },
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

/**
 * A disc's signed distance field, 0.5 on its edge, with each channel offset differently so only their median is the
 * distance, as in a multi-channel atlas.
 */
function msdfTexture(scene: Scene): RawTexture {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const distance = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5);
    const field = 0.5 + (0.3 - distance) * 2.5;
    const channel = (offset: number) => Math.round(Math.min(1, Math.max(0, field + offset)) * 255);
    pixels.set([channel(0.12), channel(0), channel(-0.12), 255], (y * size + x) * 4);
  }
  // As the engine loads an MSDF atlas: no mipmaps, bilinear, not flipped.
  const texture = RawTexture.CreateRGBATexture(pixels, size, size, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
  texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
}

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
    const atlas = msdfTexture(scene);
    const textureOf = (entry: Case) => entry.msdf ? atlas : entry.flipped ? flipped : texture;
    // Behind every quad, in both draws: the geometry effects read the quads' depth and normals against it.
    const backdrop = MeshBuilder.CreatePlane("backdrop", { width: 20, height: 10 }, scene);
    backdrop.position.z = 1;
    const backdropMaterial = new StandardMaterial("backdrop", scene);
    backdropMaterial.disableLighting = true;
    backdropMaterial.emissiveColor = new Color3(0.35, 0.35, 0.35);
    backdrop.material = backdropMaterial;
    const quads = CASES.map((entry, index) => {
      const mesh = MeshBuilder.CreatePlane(entry.name, { width: 2.5, height: 3.6 }, scene);
      mesh.position.set(-6.875 + (index % 6) * 2.75, index < 6 ? 1.9 : -1.9, 0);
      let standard: Material;
      if (entry.reference) standard = entry.reference(scene, textureOf(entry));
      else {
        const material = new StandardMaterial(`${entry.name}-standard`, scene);
        // The engine's Standard fog rule, as every Standard surface drew with it.
        new StandardFogPlugin(material);
        entry.standard!(material, textureOf(entry));
        standard = material;
      }
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
      for (const quad of quads) quad.mesh.setEnabled(!(mode.spatial && quad.entry.msdf));
      for (const fog of FOGS) {
        scene.fogMode = fog.mode;
        for (const quad of quads) {
          quad.mesh.material = quad.standard;
          enableOverlayVisualMaterial(quad.mesh);
        }
        const standard = await draw();
        for (const quad of quads) setUnlitMaterial(quad.mesh, quad.entry.key, quad.entry.binding(textureOf(quad.entry)));
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
