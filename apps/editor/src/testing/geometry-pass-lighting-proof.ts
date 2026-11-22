/**
 * Test-build-only proof that the spatial geometry pass compiles no lighting and changes no pixel for it
 * (`GEOMETRY_PASS_WITHOUT_COLOR`): one fixed frame through the Forward FrameGraph with ambient occlusion, Real-Time
 * Reflections, volumetric lighting and Screen-Space Shadows on, in PBR and CEL, over a rough lit graph Material, a
 * mirror, an alpha-clipped one, a translucent pane and the unlit Material lit in 3D, under a shadowed sun and a point
 * light. `keepGeometryLighting` builds the light block with its lighting in every pass, as before the guard: the spec
 * compares the two runs' geometry attachments and frames byte for byte.
 */
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import "@babylonjs/core/Engines/Extensions/engine.readTexture";
import type { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import type { Material } from "@babylonjs/core/Materials/material";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import {
  normalizeCelShadingSettings,
  normalizeRenderEffectsSettings,
  normalizeRenderingQuality,
  normalizeShadowSettings,
  type RenderMode,
} from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, setSceneRenderSettings, largeWorldEngineOptions } from "@haptic/render";
import { ForwardSceneFrameGraph } from "@haptic/render/framegraph-forward-scene";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey, type MaterialBlendMode } from "@haptic/shader-graph";
import { GEOMETRY_PASS_WITHOUT_COLOR } from "@haptic/render/editor-proofs";
import { HapticLightingBlock } from "@haptic/render/editor-proofs";
import { allowSceneScreenShadows } from "@haptic/render/render-settings";
import type { SpatialEffectsGraph } from "@haptic/render/editor-proofs";
import { setUnlitMaterial } from "@haptic/render/editor-proofs";

/** A light block statement of the lighting itself, in main() (`hapticLightingGlsl`). */
const LIGHTING_STATEMENT = /hapticSurface hapticS;|vec3 hapticN = normalize\(/;

type Readback = { width: number; height: number; values: number[] };
export type GeometryPassLightingCapture = {
  mode: RenderMode;
  /** The spatial geometry pass's attachments as that pass left them, and the presented frame. */
  depth: Readback;
  normal: Readback;
  reflectivity: Readback;
  frame: number[];
  /** Per Material: whether its program in the geometry pass and in the colour pass holds the lighting. */
  programs: { name: string; geometryLit: boolean; colourLit: boolean }[];
  tasks: string[];
};

export async function runGeometryPassLightingProof(options: { keepGeometryLighting: boolean; largeWorld?: boolean }) {
  const block = HapticLightingBlock.prototype as unknown as { _buildBlock(state: NodeMaterialBuildState): unknown };
  const build = block._buildBlock;
  const readsBindings = HapticLightingBlock.prototype.readsBindings;
  if (options.keepGeometryLighting) {
    block._buildBlock = function (this: HapticLightingBlock, state: NodeMaterialBuildState) {
      const result = build.call(this, state);
      const guard = `#elif ${GEOMETRY_PASS_WITHOUT_COLOR}\n`;
      if (state.compilationString.includes(guard)) state.compilationString = state.compilationString.replace(guard, "");
      return result;
    };
    // A geometry pass program with the lighting reads its inputs: its draws bind them, as before the guard.
    HapticLightingBlock.prototype.readsBindings = () => true;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 100;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, ...largeWorldEngineOptions(options.largeWorld === true) });
  engine.setSize(canvas.width, canvas.height);
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
    const camera = new FreeCamera("camera", new Vector3(0, 2.4, -5), scene);
    camera.setTarget(new Vector3(0, 0.4, 1.5));
    camera.minZ = 0.1;
    camera.maxZ = 60;
    scene.activeCamera = camera;
    allowSceneScreenShadows(scene, () => true);
    const effects = normalizeRenderEffectsSettings({
      ambientOcclusion: { enabled: true, resolutionScale: 0.5, radius: 0.6, strength: 2 },
      reflections: { enabled: true, maxSteps: 64, thickness: 0.3 },
      volumetricLighting: { enabled: true, steps: 16, density: 0.04, maxDistance: 20, intensity: 1 },
    });
    const settings = (mode: RenderMode) => setSceneRenderSettings(scene, {
      mode,
      effects,
      cel: normalizeCelShadingSettings({ outlinesEnabled: false }),
      quality: normalizeRenderingQuality({ postprocessing: { profile: "high", preset: "high" } }),
      shadows: normalizeShadowSettings({ cascades: 2, mapSize: 512, distance: 30, screenShadows: "high" }),
    });
    settings("pbr");

    const material = async (name: string, color: number[], metallic: number, roughness: number, blendMode: MaterialBlendMode = "opaque", opacity = 1) => {
      const doc = createDefaultMaterialDocument(name);
      doc.blendMode = blendMode;
      doc.nodes.find((node) => node.id === "baseColor")!.properties.value = color;
      const output = doc.nodes.find((node) => node.id === "output")!.properties;
      output[materialPinDefaultPropertyKey("metallic")] = [metallic];
      output[materialPinDefaultPropertyKey("roughness")] = [roughness];
      if (blendMode !== "opaque") output[materialPinDefaultPropertyKey("opacity")] = [opacity];
      const lowered = lowerMaterialDocument(doc);
      if (!lowered.ok) throw new Error(`${name} did not lower`);
      const compiled = compileMaterialPlan(lowered.plan, { scene, name });
      if (!compiled.ok) throw new Error(`${name} did not compile`);
      await compiled.ready;
      return compiled.material;
    };
    const rough = await material("rough", [0.8, 0.8, 0.8], 0, 0.7);
    const mirror = await material("mirror", [0.9, 0.9, 0.9], 1, 0.05);
    const clipped = await material("clipped", [0.3, 0.7, 0.3], 0, 0.4, "masked", 0.8);
    const glass = await material("glass", [0.6, 0.8, 1], 0, 0.1, "translucent", 0.3);

    const floor = MeshBuilder.CreateGround("floor", { width: 12, height: 30 }, scene);
    floor.position.z = 10;
    floor.material = mirror;
    const box = MeshBuilder.CreateBox("box", { size: 0.8 }, scene);
    box.position.set(-1.4, 0.4, 0.8);
    box.rotation.y = 0.4;
    box.material = rough;
    const leaf = MeshBuilder.CreateBox("leaf", { width: 1, height: 1.2, depth: 0.1 }, scene);
    leaf.position.set(1.4, 0.6, 1.2);
    leaf.material = clipped;
    const pane = MeshBuilder.CreatePlane("pane", { width: 1, height: 0.7 }, scene);
    pane.position.set(-0.2, 0.5, -0.4);
    pane.material = glass;
    const pillar = MeshBuilder.CreateCylinder("pillar", { diameter: 0.5, height: 1.6, tessellation: 16 }, scene);
    pillar.position.set(0.2, 0.8, 2.4);
    const unlit = setUnlitMaterial(pillar, { textured: false, backFaceCulling: true, fog: true, role: "world", lighting: "3d" }, {
      texture: null, color: [0.9, 0.4, 0.2], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: false,
    });

    const sun = new DirectionalLight("sun", new Vector3(0.45, -0.5, 0.6).normalize(), scene);
    applyAuthoredLightProperties(sun, { color: [1, 0.95, 0.85], intensity: 3, castShadows: true, range: 40, outerAngle: 70, innerAngle: 40 });
    const lamp = new PointLight("lamp", new Vector3(1, 2, 0), scene);
    applyAuthoredLightProperties(lamp, { color: [0.6, 0.7, 1], intensity: 8, castShadows: false, range: 10, outerAngle: 70, innerAngle: 40 });

    const graph = new ForwardSceneFrameGraph(scene);
    const internals = graph as unknown as {
      graph?: FrameGraph;
      effectsGraph?: { spatial?: SpatialEffectsGraph };
      objects?: { objectRenderer: { renderPassId: number } };
    };
    const meshes: [string, AbstractMesh, Material][] = [
      ["rough", box, rough], ["mirror", floor, mirror], ["clipped", leaf, clipped], ["unlit lit in 3D", pillar, unlit],
    ];
    const capture = async (mode: RenderMode): Promise<GeometryPassLightingCapture> => {
      settings(mode);
      const deadline = performance.now() + 30_000;
      await graph.prepare(camera);
      while (!graph.readiness(camera).ready) {
        if (performance.now() > deadline) throw new Error(`${mode}: readiness timed out`);
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
        await graph.prepare(camera);
      }
      const spatial = internals.effectsGraph?.spatial;
      const frameGraph = internals.graph;
      if (!spatial || !frameGraph) throw new Error(`${mode}: the view has no spatial geometry pass`);
      let attachments: Pick<GeometryPassLightingCapture, "depth" | "normal" | "reflectivity"> | undefined;
      const read = (handle: number): Readback => {
        const texture = frameGraph.textureManager.getTextureFromHandle(handle)!;
        const values = engine._readTexturePixelsSync(texture, texture.width, texture.height);
        return { width: texture.width, height: texture.height, values: Array.from(values as Float32Array | Uint8Array) };
      };
      // Read as the pass leaves them: later passes may reuse the targets within the frame.
      const observer = spatial.geometry.onAfterTaskExecute.add(() => {
        attachments = {
          depth: read(spatial.geometry.geometryViewDepthTexture),
          normal: read(spatial.geometry.geometryWorldNormalTexture),
          reflectivity: read(spatial.geometry.geometryReflectivityTexture),
        };
      });
      try {
        // Shadow maps and the screen shadows settle over the first frames; the last one is the capture.
        for (let presented = 0; presented < 6;) {
          attachments = undefined;
          engine.beginFrame();
          let rendered: boolean;
          try { rendered = graph.render(camera, false).rendered !== false; } finally { engine.endFrame(); }
          if (rendered) presented++;
          else {
            if (performance.now() > deadline) throw new Error(`${mode}: presentation timed out`);
            await new Promise<void>((resolve) => setTimeout(resolve, 16));
            await graph.prepare(camera);
          }
        }
      } finally { spatial.geometry.onAfterTaskExecute.remove(observer); }
      if (!attachments) throw new Error(`${mode}: the geometry pass did not run`);
      const pixels = await engine.readPixels(0, 0, canvas.width, canvas.height);
      const geometryPass = spatial.geometry.objectRenderer.renderPassId;
      const colourPass = internals.objects!.objectRenderer.renderPassId;
      const lit = (mesh: AbstractMesh, pass: number) =>
        LIGHTING_STATEMENT.test(mesh.subMeshes[0]!._getDrawWrapper(pass)?.effect?.fragmentSourceCode ?? "");
      return {
        mode,
        ...attachments,
        frame: Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)),
        programs: meshes.map(([name, mesh]) => ({ name, geometryLit: lit(mesh, geometryPass), colourLit: lit(mesh, colourPass) })),
        tasks: graph.taskNames(),
      };
    };
    const captures = [await capture("pbr"), await capture("cel")];
    graph.dispose();
    await graph.whenReleased();
    return { captures, renderer: engine.getGlInfo().renderer };
  } finally {
    block._buildBlock = build;
    HapticLightingBlock.prototype.readsBindings = readsBindings;
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
