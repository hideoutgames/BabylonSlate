/**
 * Test-build-only proof that the main colour pass's and the captures' GPU savings change no pixel: one fixed scene,
 * drawn through the production scene view with a Fast and a High Quality Render Target Capture and a Mirror, under a
 * shadowed sun, shadowed spot and point lights, two rect lights (one facing away from most of the view), ambient
 * occlusion, Real-Time Reflections and Screen-Space Shadows. `reference` draws it as before the savings: the light
 * block's rect loop visits every rect light and fetches the LTC tables per light, a spot light's shadow is looked up
 * outside its cone, and a capture's own sun maps redraw every time, and the view's object and geometry passes take
 * Babylon's preparation instead of the lean one (`leanPreparation`); each view's clear is a render pass of its own
 * before its objects pass (`ManagedShadowObjectRendererTask.startClear`), the spatial geometry pass prepares through
 * Babylon's clears and then its own, binding its target three times, and keeps its depth, and the light block binds its
 * inputs for geometry pass programs that compile no lighting (`HapticLightingBlock.readsBindings`), every full-screen pass
 * loads its colour target instead of starting from a clear (`fullTargetClear`), and an instanced batch uploads its rows
 * and per-instance values at every draw (no `Scene._instanceUploads`). `chain` adds bloom, volumetric lighting, FXAA in
 * place of multisampling and an FSR upscale, and draws the world at half the backbuffer's size, so the chain ends at the view's size and an output copy
 * fills the backbuffer. Both draw instances of one box with a per-instance colour, a translucent caster (which draws no
 * shadow depth) and a lattice-caged box (whose cage the maps track). The spec compares
 * the two runs' frames, capture images and shadow atlas pages (every texel's depth bits) byte for byte, after a still
 * stretch and after casters move and the cage bends and turns, and each run's GL calls and pass structure in one still frame
 * (`GlSignatureRecorder`).
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
import {
  applyAuthoredLightProperties, compileMaterialPlan, configureEditorRenderingGroups, RenderTargetCaptures, largeWorldEngineOptions, setMeshLatticeDeformer,
} from "@haptic/render";
import { SceneRenderCoordinator } from "@haptic/render/scene-render-coordinator";
import { createDefaultMaterialDocument, lowerMaterialDocument, materialPinDefaultPropertyKey } from "@haptic/shader-graph";
import type { FrameGraphRenderContext } from "@babylonjs/core/FrameGraph/frameGraphRenderContext";
import type { FrameGraphRenderTarget } from "@babylonjs/core/FrameGraph/frameGraphRenderTarget";
import { FrameGraphGeometryRendererTask } from "@babylonjs/core/FrameGraph/Tasks/Rendering/geometryRendererTask";
import type { FrameGraphClearTextureTask } from "@babylonjs/core/FrameGraph/Tasks/Texture/clearTextureTask";
import { Constants } from "@babylonjs/core/Engines/constants";
import { retainAreaLightLookup } from "../../../../packages/render/src/area-light-resources";
import { OwnedRectAreaLight } from "../../../../packages/render/src/area-rect-light";
import { LogicalGeometryTask } from "../../../../packages/render/src/framegraph-logical-buffers";
import { ManagedShadowObjectRendererTask } from "../../../../packages/render/src/framegraph-managed-shadows";
import { pendingDriverEffects } from "../../../../packages/render/src/driver-compile";
import { fullTargetClear } from "../../../../packages/render/src/full-target-clear";
import { drawGeometryDepthSeed } from "../../../../packages/render/src/geometry-depth-seed";
import { setMeshInstanceParameters } from "../../../../packages/render/src/instance-parameters";
import { setSceneOutputScale } from "../../../../packages/render/src/scene-output-scale";
import { GlSignatureRecorder, installGlSignature } from "../../../../packages/render/src/gpu-frame-probe";
import { HapticLightingBlock } from "../../../../packages/render/src/haptic-lighting-block";
import { createMirrorSurfaceMesh, mirrorDiagnostics } from "../../../../packages/render/src/mirrors";
import { allowSceneScreenShadows } from "../../../../packages/render/src/render-settings";
import { setSceneRenderSettings } from "../../../../packages/render/src/scene-render-mode";
import { shadowAtlasDrawCounts } from "../../../../packages/render/src/shadow-atlas";
import { findSceneShadowController, SceneShadowController } from "../../../../packages/render/src/shadow-controller";
import { readShadowAtlasPages, type ShadowAtlasPageDigest } from "./shadow-atlas-readback";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { createDefaultTilemapPayload, normalizeTilesetPayload, setTile } from "@haptic/assets";
import { AtlasCascadedShadowGenerator } from "../../../../packages/render/src/shadow-atlas";
import { ShadowMapRefresh } from "../../../../packages/render/src/shadow-map-refresh";
import { hasOwnerNotifiedGeometry } from "../../../../packages/render/src/geometry-revision";
import { createSpriteQuad, setSpriteQuadSize } from "../../../../packages/render/src/sprite-quad";
import { createTilemapMeshes } from "../../../../packages/render/src/tilemap-mesh";

/**
 * The shadow maps' savings as before them, from the current; returns the restore. Every cascade of a sun's atlas map
 * redraws whenever the map does (`AtlasCascadedShadowGenerator.keepsCascade`), a mesh whose owner notifies its writes
 * (a sprite quad, a tilemap chunk) changes on its own, and a spot light's casters are tested against its range alone.
 */
function referenceShadowRefresh(): () => void {
  const cascades = AtlasCascadedShadowGenerator.prototype;
  const keepsCascade = cascades.keepsCascade;
  cascades.keepsCascade = () => false;
  const refresh = ShadowMapRefresh.prototype as unknown as {
    tracksGeometryWrites(mesh: Mesh): boolean;
    shadowCone(...args: unknown[]): unknown;
  };
  const tracksGeometryWrites = refresh.tracksGeometryWrites;
  const shadowCone = refresh.shadowCone;
  refresh.tracksGeometryWrites = function (this: unknown, mesh: Mesh) {
    return !hasOwnerNotifiedGeometry(mesh) && tracksGeometryWrites.call(this, mesh);
  };
  refresh.shadowCone = () => null;
  return () => {
    cascades.keepsCascade = keepsCascade;
    refresh.tracksGeometryWrites = tracksGeometryWrites;
    refresh.shadowCone = shadowCone;
  };
}

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

/** The view's frame, the captures' images and the shadow atlas's pages (their depth bits, digested). */
export type MainPassExactnessImages = { view: number[]; captures: Record<Shown, number[]>; atlas: ShadowAtlasPageDigest[] };

/** One frame's GL calls by function, and its passes as the GL signature lists them. */
export type MainPassExactnessFrame = { calls: Record<string, number>; passes: string[]; passCount: number; invalidates: number };

type ObjectsTaskInternals = { record(...args: unknown[]): unknown; startClear: FrameGraphClearTextureTask | undefined };
type GeometryTaskInternals = Pick<FrameGraphGeometryRendererTask, "textureDescriptions" | "camera" | "targetTexture" | "depthTest" | "depthWrite"> &
  Pick<LogicalGeometryTask, "seed" | "clearsDepth"> & {
    _prepareRendering(context: FrameGraphRenderContext, depthEnabled: boolean): number[];
    discardDepth(): void;
    pass: { frameGraphRenderTarget: FrameGraphRenderTarget } | undefined;
    _frameGraph: { engine: AbstractEngine };
  };

/**
 * The view's clear, geometry pass and light block bindings as before the savings; returns the restore. Each view's clear
 * task records its render pass ahead of the objects pass's, in that task; the geometry pass prepares through Babylon's
 * clears (the view depth to zero), binds its target again for the far plane and the depth, and keeps its depth.
 */
function referenceClears(): () => void {
  const objects = ManagedShadowObjectRendererTask.prototype as unknown as ObjectsTaskInternals;
  const record = objects.record;
  objects.record = function (this: ObjectsTaskInternals, ...args: unknown[]) {
    const clear = this.startClear;
    if (!clear) return record.apply(this, args);
    this.startClear = undefined;
    try {
      clear.record();
      return record.apply(this, args);
    } finally { this.startClear = clear; }
  };
  const geometry = LogicalGeometryTask.prototype as unknown as GeometryTaskInternals;
  const prepare = geometry._prepareRendering;
  const discardDepth = geometry.discardDepth;
  const babylonPrepare = (FrameGraphGeometryRendererTask.prototype as unknown as GeometryTaskInternals)._prepareRendering;
  geometry._prepareRendering = function (this: GeometryTaskInternals, context, depthEnabled) {
    const layout = babylonPrepare.call(this, context, depthEnabled);
    if (this.pass && this.textureDescriptions.some((texture) => texture.type === Constants.PREPASS_DEPTH_TEXTURE_TYPE)) {
      const far = Math.min(65000, this.camera?.maxZ || 65000);
      const targets = this.targetTexture === undefined ? 0 : Array.isArray(this.targetTexture) ? this.targetTexture.length : 1;
      const depth = new Array<boolean>(targets).fill(false)
        .concat(this.textureDescriptions.map((texture) => texture.type === Constants.PREPASS_DEPTH_TEXTURE_TYPE));
      context.bindRenderTarget(this.pass.frameGraphRenderTarget);
      context.clearColorAttachments(new Color4(far, 0, 0, 1), this._frameGraph.engine.buildTextureLayout(depth));
      if (this.seed) {
        drawGeometryDepthSeed(context, this._frameGraph.engine, this.seed, this.camera, far);
        context.setDepthStates(this.depthTest && depthEnabled, this.depthWrite && depthEnabled);
      } else if (this.clearsDepth) {
        this._frameGraph.engine.setDepthWrite(true);
        context.clear(null, false, true, false);
        context.setDepthStates(this.depthTest && depthEnabled, this.depthWrite && depthEnabled);
      }
      context.restoreDefaultFramebuffer();
    }
    return layout;
  };
  geometry.discardDepth = () => {};
  const lighting = HapticLightingBlock.prototype;
  const readsBindings = lighting.readsBindings;
  lighting.readsBindings = () => true;
  // Every full-screen pass loads its target again instead of starting from a clear.
  const clearTarget = fullTargetClear.clear;
  fullTargetClear.clear = () => {};
  return () => {
    objects.record = record;
    geometry._prepareRendering = prepare;
    geometry.discardDepth = discardDepth;
    lighting.readsBindings = readsBindings;
    fullTargetClear.clear = clearTarget;
  };
}

/** Draws one frame (`frame`) and returns its GL calls by function and its pass structure. */
function measureFrame(engine: AbstractEngine, frame: () => unknown): MainPassExactnessFrame {
  const gl = (engine as unknown as { _gl: WebGL2RenderingContext })._gl;
  const recorder = new GlSignatureRecorder();
  const uninstall = installGlSignature(gl, recorder);
  const calls: Record<string, number> = {};
  const own = gl as unknown as Record<string, unknown>;
  const restores: (() => void)[] = [];
  for (const name of Object.getOwnPropertyNames(WebGL2RenderingContext.prototype)) {
    if (name === "constructor" || typeof Object.getOwnPropertyDescriptor(WebGL2RenderingContext.prototype, name)?.value !== "function") continue;
    const call = own[name] as (...args: unknown[]) => unknown;
    const previous = Object.getOwnPropertyDescriptor(gl, name);
    own[name] = (...args: unknown[]) => {
      calls[name] = (calls[name] ?? 0) + 1;
      return call.apply(gl, args);
    };
    restores.push(() => { if (previous) Object.defineProperty(gl, name, previous); else delete own[name]; });
  }
  recorder.start();
  recorder.beginFrame();
  try { frame(); } finally {
    recorder.endFrame();
    for (const restore of restores.reverse()) restore();
    uninstall();
  }
  const stats = recorder.stats();
  return { calls, passes: stats?.structures[0]?.passes ?? [], passCount: stats?.passes ?? 0, invalidates: stats?.invalidates ?? 0 };
}

export async function runMainPassExactnessProof(options: { reference: boolean; largeWorld?: boolean; chain?: boolean }) {
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
  const restoreClears = options.reference ? referenceClears() : () => {};
  const restoreShadowRefresh = options.reference ? referenceShadowRefresh() : () => {};
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  document.getElementById("root")!.append(canvas);
  const engine = new Engine(canvas, false, { preserveDrawingBuffer: true, stencil: true, ...largeWorldEngineOptions(options.largeWorld === true) });
  engine.setSize(SIZE, SIZE);
  const scene = new Scene(engine);
  try {
    scene.clearColor = new Color4(0.05, 0.06, 0.09, 1);
    configureEditorRenderingGroups(scene);
    allowSceneScreenShadows(scene, () => true);
    setSceneRenderSettings(scene, {
      mode: "pbr",
      // Ambient occlusion and reflections: the geometry pass writes normals and reflectivity beside the view depth.
      effects: normalizeRenderEffectsSettings({
        ambientOcclusion: { enabled: true }, reflections: { enabled: true },
        ...(options.chain ? { bloom: { enabled: true }, volumetricLighting: { enabled: true }, upscaling: { enabled: true, renderScale: 0.75 } } : {}),
      }),
      cel: normalizeCelShadingSettings({ outlinesEnabled: false }),
      // The chain antialiases with FXAA, a post-process stage, instead of multisampling.
      quality: normalizeRenderingQuality({ postprocessing: { profile: "high", preset: "high", ...(options.chain ? { antiAliasing: "fxaa" as const } : {}) } }),
      shadows: normalizeShadowSettings({ cascades: 2, mapSize: 512, distance: 30, screenShadows: "high" }),
    });
    // The world at half the backbuffer: the chain ends at the view's size and its output copy fills the backbuffer.
    if (options.chain) setSceneOutputScale(scene, 0.5);
    const camera = new FreeCamera("Main Camera", new Vector3(0, 3.2, -7), scene);
    camera.setTarget(new Vector3(0, 0.6, 1.5));
    camera.minZ = 0.1;
    camera.maxZ = 80;
    scene.activeCamera = camera;

    const material = async (name: string, color: number[], metallic: number, roughness: number, opacity = 1): Promise<Material> => {
      const doc = createDefaultMaterialDocument(name);
      doc.nodes.find((node) => node.id === "baseColor")!.properties.value = color;
      const output = doc.nodes.find((node) => node.id === "output")!.properties;
      output[materialPinDefaultPropertyKey("metallic")] = [metallic];
      output[materialPinDefaultPropertyKey("roughness")] = [roughness];
      if (opacity < 1) {
        doc.blendMode = "translucent";
        output[materialPinDefaultPropertyKey("opacity")] = [opacity];
      }
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
    // A translucent caster: Babylon's shadow passes draw none of its parts, so no map redraws for it.
    const glass = MeshBuilder.CreateSphere("glass", { diameter: 0.9, segments: 16 }, scene);
    glass.position.set(0.3, 0.45, 0.4);
    glass.material = await material("glass", [0.35, 0.65, 0.95], 0, 0.1, 0.45);
    // A lattice-caged box under a component root: its shadow follows the cage, the root and the box, which the maps
    // track, so a sun cascade it does not reach keeps its tile when the cage changes.
    const cageRoot = new Mesh("cage root", scene);
    cageRoot.position.set(2.8, 0, 3.6);
    const caged = MeshBuilder.CreateBox("caged", { size: 0.9 }, scene);
    caged.parent = cageRoot;
    caged.position.y = 0.45;
    caged.material = await material("caged", [0.75, 0.6, 0.5], 0, 0.6);
    const cage = (twist: number) => ({
      enabled: true, resolution: [2, 2, 2] as [number, number, number], strength: 1, fitToMesh: true,
      boundsMin: [-1, -1, -1] as [number, number, number], boundsMax: [1, 1, 1] as [number, number, number],
      // The top four controls slide along X by `twist`, the bottom four not: a shear.
      offsets: Array.from({ length: 24 }, (_, index) => index % 3 === 0 && Math.floor(index / 3) % 4 >= 2 ? twist : 0),
    });
    setMeshLatticeDeformer(cageRoot, cage(0.35));
    // Instances of one box, each with its own colour (a Per Instance parameter): every pass draws them as one batch,
    // from one buffer of world rows and one of colours.
    const tintDocument = createDefaultMaterialDocument("tinted");
    const tint = tintDocument.nodes.find((node) => node.id === "baseColor")!;
    tint.type = "param.color";
    tint.properties = { name: "Tint", value: [0.7, 0.7, 0.7, 1], perInstance: true };
    tintDocument.edges.find((edge) => edge.sourceNodeId === "baseColor")!.sourcePinId = "rgb";
    const tintPlan = lowerMaterialDocument(tintDocument);
    if (!tintPlan.ok) throw new Error("tinted did not lower");
    const tintCompiled = compileMaterialPlan(tintPlan.plan, { scene, name: "tinted" });
    if (!tintCompiled.ok) throw new Error("tinted did not compile");
    await tintCompiled.ready;
    const post = MeshBuilder.CreateBox("post", { width: 0.35, height: 1.4, depth: 0.35 }, scene);
    post.material = tintCompiled.material;
    post.position.set(-3, 0.7, 2.5);
    const posts = [post, ...[[-0.4, 3.5, [0.9, 0.2, 0.2]], [0.6, 3.8, [0.2, 0.8, 0.3]], [2.6, 0.5, [0.2, 0.4, 0.95]]].map(([x, z, color], index) => {
      const instance = post.createInstance(`post ${index}`);
      instance.position.set(x as number, 0.7, z as number);
      setMeshInstanceParameters(instance, tintCompiled.material, new Map([["Tint", { kind: "color" as const, value: [...(color as number[]), 1] as [number, number, number, number] }]]));
      return instance;
    })];

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

    // A sprite quad and an animated tilemap chunk, opaque, casting: their owners write their updatable buffers through
    // notified updates only, so their shadows are cached until such a write.
    const sprite = createSpriteQuad(scene, "sprite", { pivot: { x: 0.5, y: 0.5 }, width: 120, height: 120 });
    sprite.position.set(-3.2, 1.2, 2.6);
    sprite.material = rough;
    const tileset = normalizeTilesetPayload({ atlasWidth: 32, atlasHeight: 16, tileWidth: 16, tileHeight: 16, tiles: [{ id: 2, animation: [2, 1] }] });
    let tilemap = { ...createDefaultTilemapPayload(), chunkSize: 2, tilesets: [{ guid: "atlas", firstGid: 1, tileCount: 2 }] };
    tilemap = setTile(setTile(tilemap, "layer-1", 0, 0, 2), "layer-1", 1, 0, 2);
    const tiles = createTilemapMeshes(scene, "tilemap", tilemap, new Map([["atlas", tileset]]), 0.8, 0.8);
    tiles.position.set(-0.6, 1.4, 4.2);
    const chunk = tiles.getChildMeshes().find((mesh) => mesh.name.endsWith(":anim")) as Mesh;
    chunk.material = rough;

    const mirror = createMirrorSurfaceMesh(scene, "mirror", parseMirrorProperties({ width: 3, height: 2 }));
    mirror.position.set(3.2, 1.2, 4);
    mirror.rotation.y = Math.PI / 4;

    const view = new SceneRenderCoordinator(scene, { leanPreparation: !options.reference });
    // Every draw of an instanced batch fills and uploads its buffers again.
    if (options.reference) scene._instanceUploads = undefined;
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
    // Timing never decides an image: a capture view's preparation and a program's link finish asynchronously, and a
    // view not ready for a frame keeps its previous image, so one run could read a capture a frame behind the other.
    // A frame counts only when no program was compiling as it started, the view drew it ready, and every capture
    // published an image of it; the images are read only after such frames, with nothing compiling.
    let drawn = 0;
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 16));
    const quiet = async (limit: number) => {
      while (pendingDriverEffects(engine).length) {
        if (performance.now() > limit) throw new Error("Programs were still compiling.");
        await tick();
      }
    };
    const settledFrame = async () => {
      const limit = performance.now() + 30_000;
      for (;;) {
        await quiet(limit);
        const published = captures.diagnostics().map((entry) => entry.draws);
        const result = frame();
        drawn += 1;
        const captured = captures.diagnostics().every((entry, index) => entry.draws === published[index]! + 1);
        if (result.rendered && result.readyForPresentation && captured && !pendingDriverEffects(engine).length) return;
        if (performance.now() > limit) throw new Error(`A frame did not settle: ${JSON.stringify(captures.diagnostics())}`);
        await tick();
      }
    };
    // A still stretch: the frames' shadow texels drawn, then the images.
    for (let index = 0; index < 4; index++) await settledFrame();
    const counts = shadowAtlasDrawCounts(scene);
    const before = counts.texels;
    drawn = 0;
    for (let index = 0; index < 4; index++) await settledFrame();
    const stillTexelsPerFrame = (counts.texels - before) / drawn;
    const read = async (): Promise<MainPassExactnessImages> => ({
      view: await readView(engine),
      captures: Object.fromEntries(await Promise.all(QUALITIES.map(async (quality) => [quality, await readCapture(outputs[quality])] as const))) as
        Record<Shown, number[]>,
      atlas: await readShadowAtlasPages(scene),
    });
    const still = await read();
    // A still frame's GL calls and passes.
    await quiet(performance.now() + 30_000);
    const glFrame = measureFrame(engine, frame);
    // A caster moves: every map that reaches it draws again, and the images follow. The path they took, counted: tiles
    // drawn against the times a page was bound for them, and the retained casters' draws, the caster draws those stood
    // for and the rows a layer uploaded itself.
    const retainedBefore = findSceneShadowController(scene)?.retainedCasters() ?? null;
    const atlasBefore = { tiles: counts.tiles, passes: counts.passes };
    box.position.x += 0.4;
    box.rotation.y += 0.3;
    // An instance moves too: its batch's rows change.
    posts[2]!.position.z += 0.5;
    // The cage bends further and its root turns: the caged box's shadow changes with neither its own matrix nor its
    // geometry changing. The glass moves, which redraws nothing.
    setMeshLatticeDeformer(cageRoot, cage(-0.3));
    cageRoot.rotation.y += 0.4;
    glass.position.x -= 0.3;
    for (let index = 0; index < 4; index++) await settledFrame();
    const retainedAfter = findSceneShadowController(scene)?.retainedCasters() ?? null;
    const movedCounters = {
      tiles: counts.tiles - atlasBefore.tiles, passes: counts.passes - atlasBefore.passes,
      retainedDraws: (retainedAfter?.calls ?? 0) - (retainedBefore?.calls ?? 0), casterDraws: (retainedAfter?.drawn ?? 0) - (retainedBefore?.drawn ?? 0),
      lateUploads: (retainedAfter?.lateUploads ?? 0) - (retainedBefore?.lateUploads ?? 0),
    };
    const moved = await read();
    // The sprite quad resized and the tilemap chunk's vertices rewritten, each through a notified write, then a single
    // settled frame (drawn again only if it did not settle): every map they reach draws them again in it.
    setSpriteQuadSize(sprite, 1.6, 0.7, { x: 0.3, y: 0.6 });
    const positions = Float32Array.from(chunk.getVerticesData(VertexBuffer.PositionKind)!);
    for (let at = 1; at < positions.length; at += 3) positions[at] = positions[at]! * 1.5;
    chunk.updateVerticesData(VertexBuffer.PositionKind, positions);
    const tilesBefore = counts.tiles;
    await settledFrame();
    const rewrittenTiles = counts.tiles - tilesBefore;
    const rewritten = await read();
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
    return { still, moved, rewritten, rewrittenTiles, stillTexelsPerFrame, glFrame, movedCounters, renderer: engine.getGlInfo().renderer };
  } finally {
    block._buildBlock = build;
    controller.applyViewRefresh = applyViewRefresh;
    restoreClears();
    restoreShadowRefresh();
    scene.dispose();
    engine.dispose();
    canvas.remove();
  }
}
