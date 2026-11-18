/**
 * Test-build-only proof that the main colour pass's and the captures' GPU savings change no pixel: one fixed scene,
 * drawn through the production scene view with a Fast and a High Quality Render Target Capture and a Mirror, under a
 * shadowed sun, shadowed spot and point lights, two rect lights (one facing away from most of the view) and
 * Screen-Space Shadows. `reference` draws it as before the savings: the light block's rect loop visits every rect light
 * and fetches the LTC tables per light, a spot light's shadow is looked up outside its cone, and a capture's own sun
 * maps redraw every time. The spec compares the two runs' frames and
 * capture images byte for byte, after a still stretch and after a caster moves.
 */
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Engine } from "@babylonjs/core/Engines/engine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import type { Light } from "@babylonjs/core/Lights/light";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import type { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Material } from "@babylonjs/core/Materials/material";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import {
  createDefaultRenderTargetCaptureProperties, normalizeCelShadingSettings, normalizeRenderEffectsSettings, normalizeRenderingQuality,
  normalizeShadowSettings, parseMirrorProperties, type RenderTargetCaptureQuality,
} from "@haptic/core";
import { applyAuthoredLightProperties, compileMaterialPlan, configureEditorRenderingGroups, RenderTargetCaptures } from "@haptic/render";
import { SceneRenderCoordinator } from "@haptic/render/scene-render-coordinator";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import { retainAreaLightLookup } from "../../../../packages/render/src/area-light-resources";
import { OwnedRectAreaLight } from "../../../../packages/render/src/area-rect-light";
import { HapticLightingBlock } from "../../../../packages/render/src/haptic-lighting-block";
import { createMirrorSurfaceMesh, mirrorDiagnostics } from "../../../../packages/render/src/mirrors";
import { allowSceneScreenShadows } from "../../../../packages/render/src/render-settings";
import { setSceneRenderSettings } from "../../../../packages/render/src/scene-render-mode";
import { shadowAtlasDrawCounts } from "../../../../packages/render/src/shadow-atlas";
import { SceneShadowController } from "../../../../packages/render/src/shadow-controller";

/**
 * The light block's functions as before the savings, from the current ones (`HAPTIC_LIGHTING_FUNCTIONS_GLSL`): each
 * pair's current text and what stood there. A pair that no longer matches fails the proof rather than proving nothing.
 */
const REFERENCE_GLSL: readonly (readonly [string, string])[] = [
  // A spot light's cone, applied after its shadow lookup.
  [
    "      lightDistance = sqrt(distanceSquared);\n      L = offset / max(lightDistance, HAPTIC_EPSILON);\n" +
      "      // A spot light outside its cone adds exactly zero: its shadow is not looked up.\n      if (spot) {\n" +
      "        cone = hapticConeFalloff(hapticSpot[i * 4 + 1].xyz, L, hapticSpot[i * 4 + 1].w, hapticSpot[i * 4 + 3].y);\n" +
      "        if (cone == 0.0) continue;\n      }\n",
    "",
  ],
  [
    "    float NdotL = hapticSaturateEps(dot(N, L));\n    vec3 radiance = color.rgb * hapticRangeFalloff(distanceSquared, color.w);\n" +
      "    if (spot) radiance = radiance * cone;\n",
    "    lightDistance = sqrt(distanceSquared);\n    L = offset / max(lightDistance, HAPTIC_EPSILON);\n" +
      "    float NdotL = hapticSaturateEps(dot(N, L));\n    vec3 radiance = color.rgb * hapticRangeFalloff(distanceSquared, color.w);\n" +
      "    if (spot) radiance = radiance * hapticConeFalloff(hapticSpot[i * 4 + 1].xyz, L, hapticSpot[i * 4 + 1].w, hapticSpot[i * 4 + 3].y);\n",
  ],
  // Every rect light, in record order, the LTC tables fetched for each.
  ["  uint rects = hapticClusterLights(clusterMask.y >> 16, int(hapticCounts.w));\n", "  uint rects = hapticClusterLights(0xffffu, int(hapticCounts.w));\n"],
  ["  if (rects == 0u) return;\n  hapticLtc ltc = hapticLtcTerms(N, V, surface.roughness);\n", ""],
  [
    "    hapticArea area = hapticAreaLight(P, N, V, i, ltc.mInv);\n",
    "    hapticLtc ltc = hapticLtcTerms(N, V, surface.roughness);\n    hapticArea area = hapticAreaLight(P, N, V, i, ltc.mInv);\n",
  ],
];

/**
 * The light block's main code as before the savings, from the current: the screen shadows read for every pixel before
 * the direct lights, where the sun now reads them only where its cascades leave it lighter than their darkness.
 */
function referenceMain(code: string): string {
  const pattern = /hapticScreenEye = (.+);\nhapticScreenSlope = (vec2\(.+\));/g;
  if ((code.match(pattern) ?? []).length !== 1) throw new Error("The reference main code no longer matches once.");
  return code.replace(pattern, (_, eye: string, slope: string) => `hapticScreenLit = hapticScreenShadowLit(hapticP, ${eye}, ${slope});`);
}

/** The light block's functions' screen shadow read as before: a global set once per pixel, read by the sun. */
const REFERENCE_SCREEN_GLSL: readonly (readonly [string, string])[] = [
  ["vec3 hapticScreenEye = vec3(0.0);\nvec2 hapticScreenSlope = vec2(0.0);\n", "float hapticScreenLit = 1.0;\n"],
  [
    "float hapticSunScreenShadow(vec3 P, float sunShadow) {",
    "float hapticSunScreenShadow() {",
  ],
  [
    "  if (sunShadow <= darkness) return sunShadow;\n  return mix(darkness, 1.0, hapticScreenShadowLit(P, hapticScreenEye, hapticScreenSlope));\n",
    "  return mix(darkness, 1.0, hapticScreenLit);\n",
  ],
  ["min(sunShadow, hapticSunScreenShadow(P, sunShadow))", "min(sunShadow, hapticSunScreenShadow())"],
];

function referenceFunctions(code: string): string {
  for (const [current, before] of [...REFERENCE_GLSL, ...REFERENCE_SCREEN_GLSL]) {
    if (code.split(current).length !== 2) throw new Error(`The reference pair no longer matches once: ${JSON.stringify(current.slice(0, 80))}`);
    code = code.replace(current, () => before);
  }
  return code;
}

type Shown = Extract<RenderTargetCaptureQuality, "fast" | "highQuality">;
const QUALITIES: readonly Shown[] = ["fast", "highQuality"];
const SIZE = 128;
const CAPTURE_SIZE = 96;

async function readView(engine: AbstractEngine): Promise<number[]> {
  const pixels = await engine.readPixels(0, 0, SIZE, SIZE);
  return Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
}

async function readCapture(texture: BaseTexture): Promise<number[]> {
  const pixels = await texture.readPixels(0, 0, null, true, false, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE);
  if (!pixels) throw new Error("A capture returned no pixels.");
  return Array.from(pixels as Uint8Array);
}

export type MainPassExactnessImages = { view: number[]; captures: Record<Shown, number[]> };

export async function runMainPassExactnessProof(options: { reference: boolean }) {
  const block = HapticLightingBlock.prototype as unknown as { _buildBlock(state: NodeMaterialBuildState): unknown };
  const build = block._buildBlock;
  const controller = SceneShadowController.prototype as unknown as { applyViewRefresh(generator: ShadowGenerator): void };
  const applyViewRefresh = controller.applyViewRefresh;
  if (options.reference) {
    block._buildBlock = function (this: HapticLightingBlock, state: NodeMaterialBuildState) {
      const emit = state._emitFunction;
      state._emitFunction = function (this: NodeMaterialBuildState, name: string, code: string, comments: string) {
        return emit.call(this, name, name === "hapticLightingFunctions" ? referenceFunctions(code) : code, comments);
      };
      const start = state.compilationString.length;
      try {
        const built = build.call(this, state);
        state.compilationString = state.compilationString.slice(0, start) + referenceMain(state.compilationString.slice(start));
        return built;
      } finally { state._emitFunction = emit; }
    };
    // A capture's own sun maps keep the refresh rate they were made with: every frame.
    controller.applyViewRefresh = () => {};
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true });
  engine.setSize(SIZE, SIZE);
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.05, 0.06, 0.09, 1);
    configureEditorRenderingGroups(scene);
    allowSceneScreenShadows(scene, () => true);
    setSceneRenderSettings(scene, {
      mode: "pbr",
      effects: normalizeRenderEffectsSettings({}),
      cel: normalizeCelShadingSettings({ outlinesEnabled: false }),
      quality: normalizeRenderingQuality({ postprocessing: { profile: "high", preset: "high" } }),
      shadows: normalizeShadowSettings({ cascades: 2, mapSize: 512, distance: 30, screenShadows: "high" }),
    });
    const camera = new FreeCamera("Main Camera", new Vector3(0, 3.2, -7), scene);
    camera.setTarget(new Vector3(0, 0.6, 1.5));
    camera.minZ = 0.1;
    camera.maxZ = 80;
    scene.activeCamera = camera;

    const material = async (name: string, color: number[], metallic: number, roughness: number): Promise<Material> => {
      const doc = createDefaultMaterialDocument(name);
      doc.nodes.find((node) => node.id === "baseColor")!.properties.value = color;
      const output = doc.nodes.find((node) => node.id === "output")!.properties;
      output[materialPinDefaultPropertyKey("metallic")] = [metallic];
      output[materialPinDefaultPropertyKey("roughness")] = [roughness];
      const lowered = lowerMaterialDocument(doc);
      if (!lowered.ok) throw new Error(`${name} did not lower`);
      const compiled = compileMaterialPlan(lowered.plan, { scene, name });
      if (!compiled.ok) throw new Error(`${name} did not compile`);
      await compiled.ready;
      return compiled.material;
    };
    const rough = await material("rough", [0.8, 0.78, 0.75], 0, 0.75);
    const glossy = await material("glossy", [0.9, 0.85, 0.7], 1, 0.25);
    const floor = MeshBuilder.CreateGround("floor", { width: 16, height: 16 }, scene);
    floor.position.z = 3;
    floor.material = rough;
    const wall = MeshBuilder.CreateBox("wall", { width: 10, height: 3, depth: 0.3 }, scene);
    wall.position.set(0, 1.5, 6);
    wall.material = rough;
    const box = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    box.position.set(-1.6, 0.5, 1);
    box.rotation.y = 0.5;
    box.material = glossy;
    const ball = MeshBuilder.CreateSphere("ball", { diameter: 1.2, segments: 20 }, scene);
    ball.position.set(1.5, 0.6, 2);
    ball.material = glossy;

    const lights: Light[] = [];
    const authored = (light: Light, color: number[], intensity: number, castShadows: boolean, outerAngle = 70, innerAngle = 40) => {
      applyAuthoredLightProperties(light, { color, intensity, castShadows, range: 12, outerAngle, innerAngle, groundColor: [0.2, 0.18, 0.15] });
      lights.push(light);
    };
    authored(new HemisphericLight("fill", Vector3.Up(), scene), [0.5, 0.6, 0.8], 0.25, false);
    authored(new DirectionalLight("sun", new Vector3(0.4, -0.8, 0.5).normalize(), scene), [1, 0.95, 0.85], 2, true);
    // A narrow spot over the floor: most of its range lies outside its cone.
    authored(new SpotLight("narrow spot", new Vector3(-2, 4, 0), new Vector3(0.2, -1, 0.3).normalize(), 1, 2, scene), [1, 0.4, 0.2], 30, true, 30, 20);
    authored(new SpotLight("wide spot", new Vector3(2.5, 3.5, -1), new Vector3(-0.3, -1, 0.5).normalize(), 1, 2, scene), [0.3, 0.9, 0.4], 20, true, 90, 60);
    authored(new PointLight("bulb", new Vector3(0.4, 1.8, 2.8), scene), [1, 0.85, 0.7], 12, true);
    authored(new PointLight("lamp", new Vector3(-3, 1.2, 3.5), scene), [0.4, 0.5, 1], 8, false);
    // Two rect lights: one over the scene facing down, one on the wall facing it, away from the camera's side of the floor.
    retainAreaLightLookup(scene);
    const rect = (name: string, position: Vector3, rotationX: number, rotationY: number, color: number[]) => {
      const mount = new TransformNode(`${name} mount`, scene);
      mount.position.copyFrom(position);
      mount.rotation.set(rotationX, rotationY, 0);
      const light = new OwnedRectAreaLight(name, Vector3.Zero(), 2, 1.2, scene);
      light.parent = mount;
      authored(light, color, 3, false);
    };
    rect("ceiling panel", new Vector3(0.5, 3, 2), -Math.PI / 2, 0, [1, 1, 0.95]);
    rect("wall panel", new Vector3(-2.5, 1.5, 5.8), 0, Math.PI, [0.6, 0.8, 1]);

    const mirror = createMirrorSurfaceMesh(scene, "mirror", parseMirrorProperties({ width: 3, height: 2 }));
    mirror.position.set(3.2, 1.2, 4);
    mirror.rotation.y = Math.PI / 4;

    const view = new SceneRenderCoordinator(scene);
    const captures = new RenderTargetCaptures(scene);
    captures.setAssets(
      new Map(QUALITIES.map((quality) => [quality, { mode: "SceneColor" as const, width: CAPTURE_SIZE, height: CAPTURE_SIZE }])),
      new Map(QUALITIES.map((quality) => [`${quality}Texture`, { renderTargetGuid: quality }])),
    );
    const lens = new Mesh("Lens", scene);
    lens.position.set(-4, 2.5, -2);
    lens.rotationQuaternion = Quaternion.FromEulerAngles(0.3, 0.6, 0);
    for (const quality of QUALITIES) captures.configure(quality, {
      ...createDefaultRenderTargetCaptureProperties(), renderTargetGuid: quality, quality, enabled: true, fieldOfView: 60, nearClip: 0.1, farClip: 60,
    }, () => lens);
    const outputs = {} as Record<Shown, BaseTexture>;
    for (const quality of QUALITIES) outputs[quality] = captures.acquireTexture(`${quality}Texture`)!.resource;

    const frame = () => {
      engine.beginFrame();
      try { return view.render(); } finally { engine.endFrame(); }
    };
    const deadline = performance.now() + 90_000;
    for (;;) {
      const result = frame();
      const shadowsDrawn = lights.every((light) => !light.shadowEnabled || (light.getShadowGenerator() as ShadowGenerator | null)?.getDarkness() !== 1);
      if (result.rendered && result.readyForPresentation && shadowsDrawn && captures.diagnostics().every((entry) => entry.published) &&
        (mirrorDiagnostics(scene)?.draws ?? 0) > 0) break;
      if (performance.now() > deadline)
        throw new Error(`The scene did not settle: ${JSON.stringify({ captures: captures.diagnostics(), mirrors: mirrorDiagnostics(scene) })}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    // A still stretch: the frames' shadow texels drawn, then the images.
    for (let index = 0; index < 4; index++) frame();
    const counts = shadowAtlasDrawCounts(scene);
    const before = counts.texels;
    for (let index = 0; index < 4; index++) frame();
    const stillTexelsPerFrame = (counts.texels - before) / 4;
    const read = async (): Promise<MainPassExactnessImages> => ({
      view: await readView(engine),
      captures: Object.fromEntries(await Promise.all(QUALITIES.map(async (quality) => [quality, await readCapture(outputs[quality])] as const))) as
        Record<Shown, number[]>,
    });
    const still = await read();
    // A caster moves: every map that reaches it draws again, and the images follow.
    box.position.x += 0.4;
    box.rotation.y += 0.3;
    for (let index = 0; index < 4; index++) frame();
    const moved = await read();
    captures.dispose();
    view.dispose();
    let settled = false;
    const released = Promise.all([view.whenReleased(), captures.whenReleased()]).finally(() => { settled = true; });
    while (!settled) {
      engine.beginFrame();
      engine.endFrame();
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
    await released;
    return { still, moved, stillTexelsPerFrame, renderer: engine.getGlInfo().renderer };
  } finally {
    block._buildBlock = build;
    controller.applyViewRefresh = applyViewRefresh;
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
