import {
  Camera, Color3, CubeTexture, NodeMaterial, NodeMaterialBlock, NodeMaterialBlockTargets, NodeMaterialBlockConnectionPointTypes as Types, PBRMaterial,
  ShaderLanguage, Texture, ThinTexture, Vector3, type AbstractMesh, type BaseTexture, type Effect, type Material, type Mesh, type NodeMaterialConnectionPoint,
  type NodeMaterialDefines, type Scene,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { createDefaultWaterDefinition, WATER_BLEND_COLOR_PARTNERS, type WaterDefinition } from "@haptic/core";
import { sceneWaterQualityDeviceClamp } from "./render-settings";
import type { WaterContactField } from "./water-contact-field";
import { WATER_FIELD_SHORE_RANGE as SHORE, type WaterField } from "./water-field";
import {
  contactRange, fresnelSource, marchSource, meshVertexWaves, placeholderField, reflectionKeepSource, sceneWaterNodeLighting, stripShaderComments, toWgsl,
  transmittanceSource, waterAbsorption,
  sceneWaterBodyLight, WATER_BLEND_ATTRIBUTE_CONDITION, WATER_CLOCK_UNIFORM, WATER_FAR_ROUGHNESS, WATER_GLOSS_FALLOFF, WATER_GPU_WAVES_DEFINE, WATER_NODE_BLEND_DEFINE,
} from "./water-material";
import { isSkyboxMesh } from "./skybox";
import { WATER_SCENE_COPY_SKY_DEPTH, isMainWaterPass, waterSceneCopyForPass } from "./water-scene-copy";
import { declareWaterAttributes, isWaterSurfaceMesh, WATER_SURFACE_DEFINE } from "./water-surface-block";

/**
 * The water nodes' fragment blocks: Water Foam, Water Depth Fade, Water Scene Color and Water Reflection. Each reads
 * the water surface it draws through `meshWaterNodeSurface` (the asset, and the terrain and contact fields its water
 * mesh keeps for it) and the view's scene copy for the pass being drawn; on any other mesh (a material preview) every
 * output keeps a neutral value. Their per-pixel wave inputs (Wave Height, Crest Foam, Normal) come from the graph's
 * Water Waves block when the graph holds one.
 */

/** What a Custom Material's water nodes read for one water mesh; the water mesh owns it. */
export interface WaterNodeSurface {
  readonly water: WaterDefinition;
  /** Terrain under the surface, once a node needs it (`materialUsesWaterFields`). */
  field: WaterField | null;
  /** Objects crossing the surface, likewise. */
  contacts: WaterContactField | null;
  /** The neighbours whose colours it mixes toward while blending, by slot (null where a slot is empty). */
  partners: readonly (WaterDefinition | null)[];
}
const nodeSurfaces = new WeakMap<AbstractMesh, WaterNodeSurface>();
/** Registers (or with null removes) what `mesh`'s Custom Material water nodes read. */
export function setMeshWaterNodeSurface(mesh: AbstractMesh, surface: WaterNodeSurface | null): void {
  if (surface) nodeSurfaces.set(mesh, surface);
  else nodeSurfaces.delete(mesh);
}
export function meshWaterNodeSurface(mesh: AbstractMesh | null | undefined): WaterNodeSurface | null {
  return (mesh && nodeSurfaces.get(mesh)) || null;
}

/** The pass drawn has the view's scene copy (Water Scene Color, Water Depth Fade and the reflection march sample it). */
export const WATER_NODE_COPY_DEFINE = "SLATE_WATER_NODE_COPY";
/** Water Reflection marches the copy for scene objects; its value is the march's step count. */
export const WATER_NODE_SSR_DEFINE = "SLATE_WATER_SSR_STEPS";
/** Water Reflection samples an environment or skybox cube (`waterSkyCube`); otherwise it reflects the analytic sky. */
export const WATER_NODE_ENV_DEFINE = "SLATE_WATER_NODE_ENV";
export const WATER_NODE_SCENE_SAMPLER = "slateWaterSceneSampler";
export const WATER_NODE_ENV_SAMPLER = "slateWaterNodeEnvSampler";
const FIELD_SAMPLER = "slateWaterFieldSampler";
const CONTACT_SAMPLER = "slateWaterContactSampler";
const FIELD_UNIFORMS = ["slateWaterFieldBounds", "slateWaterFieldInfo", "slateWaterFieldStep", "slateWaterContactBounds", "slateWaterContactInfo"] as const;
/** (floating origin xyz, 0): the nodes' positions are relative to it, the fields are not. */
const ORIGIN_UNIFORM = "slateWaterNodeOrigin";
/** (Foam Width, Contact Foam Width, contact and shore foam strength, Depth Color Distance). */
const FOAM_UNIFORM = "slateWaterNodeFoamTerms";
/** Water Depth Fade's per-channel absorption and path cap (`waterAbsorption`). */
const ABSORB_UNIFORM = "slateWaterNodeAbsorb";
const absorbScratch = new Float64Array(4);
/** (Refraction, Roughness, Reflection Strength, 1 for an orthographic view). */
const LOOK_UNIFORM = "slateWaterNodeLook";
/** (1 / output width, 1 / output height, projection [0][0], projection [1][1]). */
const SCREEN_UNIFORM = "slateWaterNodeScreen";
/** The march's own screen terms (`marchSource`): (1 / width, 1 / height, Refraction, march distance). */
const MARCH_UNIFORM = "slateWaterScreen";
const SKY_UNIFORMS = ["slateWaterNodeSky", "slateWaterNodeHorizon", "slateWaterNodeSun", "slateWaterNodeSunColor", "slateWaterNodeSunShape"] as const;
/** (max LOD, RGBD, gamma space, level × scene environment intensity) and (1, ±1 y, ±1 z, LOD offset). */
const ENV_UNIFORMS = ["slateWaterNodeEnv", "slateWaterNodeEnvFlip"] as const;
const ENV_MATRIX = "slateWaterNodeEnvMatrix";
/** Longest reflected ray the march follows (world units), shortened to the view's far plane; as built-in water. */
const MARCH_DISTANCE = 500;
/** Refraction: screen offset per unit of view-space tilt, per metre of water behind the surface; as built-in water. */
const REFRACTION_SHIFT = 1.2;
const REFRACTION_DEPTH_CAP = 3;
const REFRACTION_SHIFT_PX = [28, 3] as const;
const REFRACTION_FAR = [6, 60] as const;
/** Bound where the pass has no copy or the variant has no cube: Babylon's empty texture. */
const EMPTY_TEXTURE = new ThinTexture(null);

const f = (n: number) => n.toFixed(6);
const wgslOf = (state: NodeMaterialBuildState) => state.shaderLanguage === ShaderLanguage.WGSL;
/** Binds GLSL-shaped node code (`U.` uniforms) and translates it for WGSL. */
function bind(code: string, wgsl: boolean): string {
  return `${stripShaderComments((wgsl ? toWgsl(code) : code).replace(/\bU\./g, wgsl ? "uniforms." : ""))}\n`;
}

function declareSampler(state: NodeMaterialBuildState, name: string, kind: "2d" | "cube", define: string): void {
  if (state.samplers.includes(name)) return;
  state.samplers.push(name);
  const declaration = wgslOf(state)
    ? `var ${name}Sampler: sampler;\nvar ${name}: ${kind === "cube" ? "texture_cube<f32>" : "texture_2d<f32>"};`
    : `uniform highp ${kind === "cube" ? "samplerCube" : "sampler2D"} ${name};`;
  state._samplerDeclaration += `#ifdef ${define}\n${declaration}\n#endif\n`;
}

/**
 * The water mesh's data for the fragment (`vSlateWaterNodeData`: mesh spacing or CPU wave height, bank distance, body
 * depth, CPU clock) and its flow (`vSlateWaterNodeFlow`), written into the vertex program from the fragment build.
 */
function emitSurfaceVaryings(state: NodeMaterialBuildState): void {
  const wgsl = wgslOf(state), vertex = state._vertexState;
  declareWaterAttributes(vertex, WATER_SURFACE_DEFINE, [["slateWaterData", 4], ["slateWaterFlow", 3]]);
  const out = wgsl ? "vertexOutputs." : "", input = wgsl ? "vertexInputs." : "";
  if (vertex._emitVaryingFromString("vSlateWaterNodeData", Types.Vector4, WATER_SURFACE_DEFINE)) {
    vertex.compilationString += `#ifdef ${WATER_SURFACE_DEFINE}\n${out}vSlateWaterNodeData = ${input}slateWaterData;\n#endif\n`;
  }
  if (vertex._emitVaryingFromString("vSlateWaterNodeFlow", Types.Vector3, WATER_SURFACE_DEFINE)) {
    vertex.compilationString += `#ifdef ${WATER_SURFACE_DEFINE}\n${out}vSlateWaterNodeFlow = ${input}slateWaterFlow;\n#endif\n`;
  }
  state._emitVaryingFromString("vSlateWaterNodeData", Types.Vector4, WATER_SURFACE_DEFINE);
  state._emitVaryingFromString("vSlateWaterNodeFlow", Types.Vector3, WATER_SURFACE_DEFINE);
}

/**
 * Fragment locals every water node starts from: `swnData` and `swnFlow` (neutral off a water mesh: no bank, 1 m deep,
 * still) and `swnPos`, the absolute world position of `position` (a Vector 4 expression).
 */
function surfaceLocals(state: NodeMaterialBuildState, position: string): string {
  const wgsl = wgslOf(state), input = wgsl ? "fragmentInputs." : "";
  return bind(`
vec4 swnData = vec4(0.0, 10000.0, 1.0, 0.0);
vec3 swnFlow = vec3(0.0);
`, wgsl) + `#ifdef ${WATER_SURFACE_DEFINE}\nswnData = ${input}vSlateWaterNodeData;\nswnFlow = ${input}vSlateWaterNodeFlow;\n#endif\n`
    + bind(`vec3 swnPos = ${position}.xyz + U.${ORIGIN_UNIFORM}.xyz;\n`, wgsl);
}

/**
 * Terrain and contact taps (`swnFieldAt`, `swnContactAt`), as built-in water decodes them (`cutSource`) without its
 * slope refinement: the field gives (on, terrain depth below the rest surface, shoreline distance, known terrain) and
 * the contacts the signed distance to the nearest object at a wave height.
 */
function emitFieldHelpers(state: NodeMaterialBuildState): void {
  const wgsl = wgslOf(state);
  for (const name of [...FIELD_UNIFORMS, ORIGIN_UNIFORM, FOAM_UNIFORM]) state._emitUniformFromString(name, Types.Vector4);
  declareSampler(state, FIELD_SAMPLER, "2d", WATER_SURFACE_DEFINE);
  declareSampler(state, CONTACT_SAMPLER, "2d", WATER_SURFACE_DEFINE);
  const taps = wgsl ? `
fn swnFieldTap(uv: vec2f) -> vec4f { return textureSampleLevel(${FIELD_SAMPLER}, ${FIELD_SAMPLER}Sampler, uv, 0.0); }
fn swnContactTap(uv: vec2f) -> vec4f { return textureSampleLevel(${CONTACT_SAMPLER}, ${CONTACT_SAMPLER}Sampler, uv, 0.0); }
` : `
vec4 swnFieldTap(vec2 uv) { return textureLod(${FIELD_SAMPLER}, uv, 0.0); }
vec4 swnContactTap(vec2 uv) { return textureLod(${CONTACT_SAMPLER}, uv, 0.0); }
`;
  const code = `
vec4 swnFieldAt(vec2 xz) {
  vec2 uv = (xz - U.slateWaterFieldBounds.xy) * U.slateWaterFieldBounds.zw;
  vec4 tap = swnFieldTap(uv);
  vec2 edge = min(uv, vec2(1.0) - uv) / max(U.slateWaterFieldStep.xy * 3.0, vec2(0.000001));
  float on = U.slateWaterFieldInfo.x * clamp(min(edge.x, edge.y), 0.0, 1.0);
  float span = U.slateWaterFieldStep.z;
  float coarse = mix(U.slateWaterFieldInfo.z, U.slateWaterFieldInfo.w, tap.g);
  float fine = U.slateWaterFieldInfo.y + tap.b * span;
  float top = U.slateWaterFieldInfo.y + span;
  float depth = mix(fine, coarse, smoothstep(top - 0.8, top - 0.2, fine));
  return vec4(on, depth, mix(${f(SHORE[0])}, ${f(SHORE[1])}, tap.r), tap.a * on);
}
float swnContactAt(vec2 xz, float height) {
  vec2 uv = (xz - U.slateWaterContactBounds.xy) * U.slateWaterContactBounds.zw;
  vec4 tap = swnContactTap(uv);
  float on = U.slateWaterContactInfo.x * step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  float layer = (clamp(height / max(0.001, U.slateWaterContactInfo.z), -1.0, 1.0) * 0.5 + 0.5) * 3.0;
  vec4 weights = max(vec4(0.0), vec4(1.0) - abs(vec4(0.0, 1.0, 2.0, 3.0) - vec4(layer)));
  return mix(1.0, dot(tap, weights) * 2.0 - 1.0, on) * U.slateWaterContactInfo.y;
}
`;
  state._emitFunction("swnFieldAt", `#ifdef ${WATER_SURFACE_DEFINE}\n${taps}${bind(code, wgsl)}#endif\n`, "");
}

/** The scene copy's taps (`swSceneColor`, `swSceneDepth`, `swSceneTexel`, `swSceneTexelUv`), as built-in water's. */
function emitCopyHelpers(state: NodeMaterialBuildState): void {
  const wgsl = wgslOf(state), s = WATER_NODE_SCENE_SAMPLER;
  state._emitUniformFromString(SCREEN_UNIFORM, Types.Vector4);
  state._emitUniformFromString(LOOK_UNIFORM, Types.Vector4);
  declareSampler(state, s, "2d", WATER_NODE_COPY_DEFINE);
  const code = wgsl ? `
fn swSceneColor(uv: vec2f) -> vec3f { return textureSampleLevel(${s}, ${s}Sampler, uv, 0.0).rgb; }
fn swSceneTexel(uv: vec2f) -> vec4f {
  let swSize = vec2i(textureDimensions(${s}, 0));
  return textureLoad(${s}, clamp(vec2i(uv * vec2f(swSize)), vec2i(0), swSize - vec2i(1)), 0);
}
fn swSceneDepth(uv: vec2f) -> f32 { return swSceneTexel(uv).a; }
fn swSceneTexelUv() -> vec2f { return 1.0 / vec2f(textureDimensions(${s}, 0)); }
` : `
vec3 swSceneColor(vec2 uv) { return textureLod(${s}, uv, 0.0).rgb; }
vec4 swSceneTexel(vec2 uv) {
  ivec2 swSize = textureSize(${s}, 0);
  return texelFetch(${s}, clamp(ivec2(uv * vec2(swSize)), ivec2(0), swSize - ivec2(1)), 0);
}
float swSceneDepth(vec2 uv) { return swSceneTexel(uv).a; }
vec2 swSceneTexelUv() { return 1.0 / vec2(textureSize(${s}, 0)); }
`;
  state._emitFunction("swSceneColor", `#ifdef ${WATER_NODE_COPY_DEFINE}\n${code}#endif\n`, "");
}

const fragCoord = (state: NodeMaterialBuildState) => wgslOf(state) ? "fragmentInputs.position" : "gl_FragCoord";

/** Water depth below this pixel's surface, as `swnDepth`: the body's shelving bank, the terrain where it is known. */
function depthSource(height: string): string {
  return `
float swnBody = max(0.01, swnData.z);
vec4 swnField = swnFieldAt(swnPos.xz);
float swnDepth = mix(swnBody * (1.0 - exp(-min(max(swnData.y, 0.0), 24.0) * 0.35 / swnBody)), max(0.0, swnField.y + ${height}), swnField.w);
`;
}

/** Defines every water node block sets: the surface data, the GPU wave path and the pass's scene copy. */
function prepareSurfaceDefines(defines: NodeMaterialDefines, material: NodeMaterial, mesh: AbstractMesh | undefined, copy: boolean): boolean {
  const surface = isWaterSurfaceMesh(mesh);
  defines.setValue(WATER_SURFACE_DEFINE, surface, true);
  defines.setValue(WATER_GPU_WAVES_DEFINE, surface && meshVertexWaves(mesh) !== null, true);
  const scene = material.getScene();
  const copied = copy && surface && isMainWaterPass(scene, scene.getEngine().currentRenderPassId);
  if (copy) defines.setValue(WATER_NODE_COPY_DEFINE, copied, true);
  return copied;
}

function contactStrength(w: WaterDefinition): number {
  const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  return smooth(0, 0.1, w.foamAmount) * Math.max(w.foamAmount, 0.85) * smooth(0, 0.05, w.contactFoamWidth);
}

/** Origin, look and foam terms and the terrain and contact fields of `mesh` (neutral placeholders off a water mesh). */
function bindSurface(effect: Effect, scene: Scene, mesh: AbstractMesh | undefined): void {
  const surface = meshWaterNodeSurface(mesh), w = surface?.water;
  const origin = scene.floatingOriginMode ? scene.floatingOriginOffset : Vector3.ZeroReadOnly;
  effect.setFloat4(ORIGIN_UNIFORM, origin.x, origin.y, origin.z, 0);
  const ortho = scene.activeCamera?.mode === Camera.ORTHOGRAPHIC_CAMERA ? 1 : 0;
  effect.setFloat4(LOOK_UNIFORM, w?.refraction ?? 0, w?.roughness ?? 0.1, w?.reflectionStrength ?? 1, ortho);
  effect.setFloat4(FOAM_UNIFORM, w?.foamWidth ?? 0, w?.contactFoamWidth ?? 0, w ? contactStrength(w) : 0, w?.depthColorDistance ?? 4);
  const field = surface?.field?.texture ? surface.field : null;
  effect.setTexture(FIELD_SAMPLER, field?.texture ?? placeholderField(scene));
  if (field) {
    const bounds = field.bounds, depth = field.depthRange, texel = field.texelSize;
    effect.setFloat4("slateWaterFieldBounds", bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!);
    effect.setFloat4("slateWaterFieldInfo", 1, field.fineDepthMin, depth[0]!, depth[1]!);
    effect.setFloat4("slateWaterFieldStep", texel[0], texel[1], field.fineDepthSpan, 0);
  } else {
    effect.setFloat4("slateWaterFieldBounds", 0, 0, 1, 1);
    effect.setFloat4("slateWaterFieldInfo", 0, 0, 0, 1);
    effect.setFloat4("slateWaterFieldStep", 1, 1, 1, 0);
  }
  const contacts = surface?.contacts?.texture ? surface.contacts : null;
  effect.setTexture(CONTACT_SAMPLER, contacts?.texture ?? placeholderField(scene));
  if (contacts) {
    const bounds = contacts.bounds;
    effect.setFloat4("slateWaterContactBounds", bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!);
    effect.setFloat4("slateWaterContactInfo", 1, contacts.range, contacts.amplitude, 0);
  } else {
    effect.setFloat4("slateWaterContactBounds", 0, 0, 1, 1);
    effect.setFloat4("slateWaterContactInfo", 0, w ? contactRange(w) : 8, 1, 0);
  }
}

/** The pass's scene copy and the screen terms that read it (Babylon's empty texture where the pass has none). */
function bindCopy(effect: Effect, scene: Scene, mesh: AbstractMesh | undefined): void {
  const copy = waterSceneCopyForPass(scene, scene.getEngine().currentRenderPassId);
  effect.setTexture(WATER_NODE_SCENE_SAMPLER, copy?.texture ?? EMPTY_TEXTURE);
  const projection = scene.getProjectionMatrix().m, camera = scene.activeCamera;
  const x = copy ? copy.invSize[0] : 0, y = copy ? copy.invSize[1] : 0;
  effect.setFloat4(SCREEN_UNIFORM, x, y, projection[0]!, projection[5]!);
  const distance = Math.min(camera && camera.maxZ > 0 ? camera.maxZ : MARCH_DISTANCE, MARCH_DISTANCE);
  effect.setFloat4(MARCH_UNIFORM, x, y, meshWaterNodeSurface(mesh)?.water.refraction ?? 0, distance);
}

/** Whether the variant drawing `mesh` samples the copy for its reflection march (`WATER_NODE_SSR_DEFINE`): its step count, else 0. */
function marchSteps(scene: Scene, surface: WaterNodeSurface | null, copied: boolean): number {
  if (!copied || !surface?.water.objectReflections) return 0;
  const clamp = sceneWaterQualityDeviceClamp(scene), reflections = clamp.quality.reflections;
  const marches = reflections === "screenSpace" || (reflections === "planar" && clamp.screenSpaceFallback);
  return marches ? Math.max(1, Math.round(clamp.quality.reflectionSteps)) : 0;
}

const skyScans = new WeakMap<Scene, { count: number; stale: boolean; boxes: AbstractMesh[] }>();
/**
 * The cube Water Reflection samples: the scene's environment, else the visible skybox's reflection cube once it is
 * ready, else null (the analytic sky of `sceneWaterNodeLighting`). The mesh list is scanned only after it changed.
 */
export function waterSkyCube(scene: Scene): BaseTexture | null {
  const environment = scene.environmentTexture;
  if (environment) return environment.isCube ? environment : null;
  let scan = skyScans.get(scene);
  if (!scan) {
    const entry = { count: -1, stale: true, boxes: [] as AbstractMesh[] };
    scene.onMeshRemovedObservable.add(() => { entry.stale = true; });
    skyScans.set(scene, scan = entry);
  }
  if (scan.stale || scan.count !== scene.meshes.length) {
    scan.boxes = scene.meshes.filter(isSkyboxMesh);
    scan.count = scene.meshes.length;
    scan.stale = false;
  }
  const sky = scan.boxes.find((mesh) => !mesh.isDisposed() && mesh.isEnabled() && mesh.isVisible);
  const texture = sky?.material instanceof PBRMaterial ? sky.material.reflectionTexture : null;
  return texture instanceof CubeTexture && texture.isReady() ? texture : null;
}

/** Uniforms of the analytic sky and of the cube `texture` (when there is one). Allocation-free. */
function bindSky(effect: Effect, scene: Scene, texture: BaseTexture | null): void {
  const light = sceneWaterNodeLighting(scene);
  effect.setFloat4("slateWaterNodeSky", light.sky[0]!, light.sky[1]!, light.sky[2]!, 0);
  effect.setFloat4("slateWaterNodeHorizon", light.horizon[0]!, light.horizon[1]!, light.horizon[2]!, 0);
  effect.setFloat4("slateWaterNodeSun", light.sun[0]!, light.sun[1]!, light.sun[2]!, light.sun[3]!);
  effect.setFloat4("slateWaterNodeSunColor", light.sunColor[0]!, light.sunColor[1]!, light.sunColor[2]!, 0);
  effect.setFloat4("slateWaterNodeSunShape", light.sunShape[0]!, light.sunShape[1]!, light.sunShape[2]!, light.sunShape[3]!);
  effect.setTexture(WATER_NODE_ENV_SAMPLER, texture ?? EMPTY_TEXTURE);
  if (!texture) return;
  const size = texture.getSize().width, lods = Math.max(0, Math.log2(Math.max(size, 1)));
  effect.setFloat4("slateWaterNodeEnv", lods * texture.lodGenerationScale, texture.isRGBD ? 1 : 0, texture.gammaSpace ? 1 : 0, texture.level * scene.environmentIntensity);
  // Babylon's cube lookups: an inverted cubic map flips Y; Z flips with `invertZ`, and again for a right-handed skybox.
  const skybox = texture.coordinatesMode === Texture.SKYBOX_MODE;
  const flipZ = skybox && scene.useRightHandedSystem ? !texture.invertZ : texture.invertZ;
  effect.setFloat4("slateWaterNodeEnvFlip", 1, texture.coordinatesMode === Texture.INVCUBIC_MODE ? -1 : 1, flipZ ? -1 : 1, texture.lodGenerationOffset);
  effect.setMatrix(ENV_MATRIX, texture.getReflectionTextureMatrix());
}

/** The shared base: every water node block is fragment-only, has defines and binds per draw. */
abstract class WaterNodeBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Fragment);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state.sharedData.blocksWithDefines.push(this);
    state.sharedData.forcedBindableBlocks.push(this);
    return this;
  }
  /** `point`'s variable, or `fallback` (an expression) where it is not connected. */
  protected value(point: NodeMaterialConnectionPoint, fallback: string): string {
    return point.isConnected ? point.associatedVariableName : fallback;
  }
  /** Declares `output` with `value` where something reads it. */
  protected declare(state: NodeMaterialBuildState, output: NodeMaterialConnectionPoint, value: string): string {
    return output.hasEndpoints ? `${state._declareOutput(output)} = ${value};\n` : "";
  }
}

/**
 * Water Foam: the foam built-in water draws, as masks. Crest Foam is the Water Waves block's whitecaps (0 without a
 * Water Waves node); Shore Foam is where the water over known terrain is shallow (Foam Width); Contact Foam is the
 * collar around objects crossing the surface (Contact Foam Width), frayed by a breakup noise drifting with the flow.
 * Foam is all of them, as built-in water combines them. Foam Amount scales every mask.
 */
export class WaterFoamBlock extends WaterNodeBlock {
  constructor(name: string) {
    super(name);
    this.registerInput("worldPosition", Types.Vector4);
    this.registerInput("waveHeight", Types.Float, true);
    this.registerInput("crestFoam", Types.Float, true);
    for (const output of ["foam", "crest", "shore", "contact"]) this.registerOutput(output, Types.Float);
  }
  get worldPosition() { return this._inputs[0]!; }
  /** The Water Waves block's per-pixel Wave Height (the compiler connects it). */
  get waveHeight() { return this._inputs[1]!; }
  /** The Water Waves block's Crest Foam (the compiler connects it). */
  get crestFoam() { return this._inputs[2]!; }
  get foam() { return this._outputs[0]!; }
  get crest() { return this._outputs[1]!; }
  get shore() { return this._outputs[2]!; }
  get contact() { return this._outputs[3]!; }
  override getClassName(): string { return "WaterFoamBlock"; }
  override prepareDefines(defines: NodeMaterialDefines, material: NodeMaterial, mesh?: AbstractMesh): void {
    prepareSurfaceDefines(defines, material, mesh, false);
  }
  override bind(effect: Effect, material: NodeMaterial, mesh?: Mesh): void {
    bindSurface(effect, material.getScene(), mesh);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    const wgsl = wgslOf(state);
    emitSurfaceVaryings(state);
    emitFieldHelpers(state);
    state._emitUniformFromString(WATER_CLOCK_UNIFORM, Types.Vector4);
    state._emitFunction("swnNoise", bind(`
float swnHash(vec2 p) {
  vec3 q = fract(vec3(p.x, p.y, p.x) * 0.1031);
  q += vec3(dot(q, q.yzx + vec3(33.33)));
  return fract((q.x + q.y) * q.z);
}
float swnNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 t = fract(p);
  t = t * t * (vec2(3.0) - 2.0 * t);
  return mix(mix(swnHash(i), swnHash(i + vec2(1.0, 0.0)), t.x), mix(swnHash(i + vec2(0.0, 1.0)), swnHash(i + vec2(1.0, 1.0)), t.x), t.y);
}
`, wgsl), "");
    const [foam, , shore, contact] = this._outputs.map((output) => output.associatedVariableName);
    const crestValue = this.value(this.crestFoam, "0.0");
    state.compilationString += this.declare(state, this.foam, "0.0") + this.declare(state, this.crest, crestValue)
      + this.declare(state, this.shore, "0.0") + this.declare(state, this.contact, "0.0");
    if (!this.foam.hasEndpoints && !this.shore.hasEndpoints && !this.contact.hasEndpoints) return this;
    const gpuHeight = this.value(this.waveHeight, "0.0");
    const assign = (output: NodeMaterialConnectionPoint, name: string | undefined, value: string) => output.hasEndpoints ? `${name} = ${value};\n` : "";
    state.compilationString += `{\n${surfaceLocals(state, this.worldPosition.associatedVariableName)}#ifdef ${WATER_SURFACE_DEFINE}\n`
      + bind(`float swnHeight = swnData.x;\nfloat swnTime = swnData.w;\n`, wgsl)
      + `#ifdef ${WATER_GPU_WAVES_DEFINE}\nswnHeight = ${gpuHeight};\nswnTime = ${wgsl ? "uniforms." : ""}${WATER_CLOCK_UNIFORM}.x;\n#endif\n`
      + bind(`${depthSource("swnHeight")}
vec4 swnTerms = U.${FOAM_UNIFORM};
vec2 swnFlowed = swnPos.xz - swnFlow.xz * swnTime;
float swnFoot = length(fwidth(swnPos.xz));
float swnBreak = mix(0.5, swnNoise(swnFlowed * 0.9 + vec2(swnTime * 0.05, 0.0)) * 0.65 + swnNoise(swnFlowed * 3.1 - vec2(0.0, swnTime * 0.08)) * 0.35, 1.0 - smoothstep(0.15, 0.6, swnFoot));
float swnShore = swnField.w * (1.0 - smoothstep(0.0, swnTerms.x * 0.35 + 0.08, swnDepth)) * (0.6 + 0.4 * swnBreak) * swnTerms.z;
float swnObject = abs(swnContactAt(swnPos.xz, swnHeight));
float swnWidth = max(0.05, swnTerms.y);
float swnCollar = (1.0 - smoothstep(0.0, swnWidth, swnObject)) * (0.65 + 0.35 * swnBreak);
swnCollar = max(swnCollar, (1.0 - smoothstep(swnWidth, swnWidth * 2.5, swnObject)) * smoothstep(0.55, 0.7, swnBreak)) * swnTerms.z;
`, wgsl)
      + assign(this.foam, foam, `clamp(max(${crestValue}, max(swnShore, swnCollar)), 0.0, 1.0)`)
      + assign(this.shore, shore, "swnShore") + assign(this.contact, contact, "swnCollar")
      + "#endif\n}\n";
    return this;
  }
}
RegisterClass("BABYLON.WaterFoamBlock", WaterFoamBlock);

/**
 * Water Depth Fade: metres of water below this pixel (Depth), a fade from 0 at the waterline toward 1 in deep water
 * over Distance metres (1 − e^(−Depth / Distance); Depth Color Distance where Distance is not connected), and the
 * Transmittance built-in water sees through that depth: per channel, how much of what lies below reaches the eye
 * (`transmittanceSource`, with the asset's absorption, at the Water Waves block's normal; none where the copy holds
 * nothing behind the water). Where the pass has the view's scene copy, Depth is what the copy holds behind the surface
 * (any geometry under the water), measured straight down; elsewhere the terrain the water mesh knows, else the body's
 * shelving bank and Depth.
 */
export class WaterDepthFadeBlock extends WaterNodeBlock {
  constructor(name: string) {
    super(name);
    this.registerInput("worldPosition", Types.Vector4);
    this.registerInput("cameraPosition", Types.Vector3);
    this.registerInput("view", Types.Matrix);
    this.registerInput("distance", Types.Float, true);
    this.registerInput("waveHeight", Types.Float, true);
    this.registerInput("waveNormal", Types.Vector3, true);
    this.registerOutput("depth", Types.Float);
    this.registerOutput("fade", Types.Float);
    this.registerOutput("transmittance", Types.Vector3);
  }
  get worldPosition() { return this._inputs[0]!; }
  get cameraPosition() { return this._inputs[1]!; }
  get view() { return this._inputs[2]!; }
  get distance() { return this._inputs[3]!; }
  get waveHeight() { return this._inputs[4]!; }
  /** The Water Waves block's Normal, which Transmittance sees the surface by (the compiler connects it). */
  get waveNormal() { return this._inputs[5]!; }
  get depth() { return this._outputs[0]!; }
  get fade() { return this._outputs[1]!; }
  get transmittance() { return this._outputs[2]!; }
  override getClassName(): string { return "WaterDepthFadeBlock"; }
  override prepareDefines(defines: NodeMaterialDefines, material: NodeMaterial, mesh?: AbstractMesh): void {
    prepareSurfaceDefines(defines, material, mesh, true);
  }
  override bind(effect: Effect, material: NodeMaterial, mesh?: Mesh): void {
    const scene = material.getScene();
    bindSurface(effect, scene, mesh);
    bindCopy(effect, scene, mesh);
    const absorb = waterAbsorption(meshWaterNodeSurface(mesh)?.water ?? PREVIEW_WATER, scene.getEngine().useExactSrgbConversions, absorbScratch);
    effect.setFloat4(ABSORB_UNIFORM, absorb[0]!, absorb[1]!, absorb[2]!, absorb[3]!);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    const wgsl = wgslOf(state), v3 = wgsl ? "vec3f" : "vec3";
    emitSurfaceVaryings(state);
    emitFieldHelpers(state);
    emitCopyHelpers(state);
    state._emitUniformFromString(ABSORB_UNIFORM, Types.Vector4);
    const [depth, fade, transmittance] = this._outputs.map((output) => output.associatedVariableName);
    state.compilationString += this.declare(state, this.depth, "1.0") + this.declare(state, this.fade, "1.0")
      + this.declare(state, this.transmittance, `${v3}(0.0)`);
    const position = this.worldPosition.associatedVariableName, eye = this.cameraPosition.associatedVariableName, view = this.view.associatedVariableName;
    const distance = this.value(this.distance, `${wgsl ? "uniforms." : ""}${FOAM_UNIFORM}.w`);
    state.compilationString += `{\n${surfaceLocals(state, position)}#ifdef ${WATER_SURFACE_DEFINE}\n`
      + bind(`float swnHeight = swnData.x;\n`, wgsl)
      + `#ifdef ${WATER_GPU_WAVES_DEFINE}\nswnHeight = ${this.value(this.waveHeight, "0.0")};\n#endif\n`
      + bind(depthSource("swnHeight"), wgsl)
      + bind("float swnOpenSky = 0.0;\n", wgsl)
      + `#ifdef ${WATER_NODE_COPY_DEFINE}\n`
      + bind(`
vec2 swnUv = ${fragCoord(state)}.xy * U.${SCREEN_UNIFORM}.xy;
float swnWaterZ = abs((${view} * vec4(${position}.xyz, 1.0)).z);
float swnSceneZ = swSceneDepth(swnUv);
float swnOrtho = U.${LOOK_UNIFORM}.w;
float swnDrop = mix(abs(${eye}.y - ${position}.y) / max(swnWaterZ, 0.001), abs(${view}[1][2]), swnOrtho);
float swnBehind = step(swnWaterZ, swnSceneZ) * (1.0 - step(${f(WATER_SCENE_COPY_SKY_DEPTH * 0.9)}, swnSceneZ));
swnDepth = mix(swnDepth, max(swnSceneZ - swnWaterZ, 0.0) * swnDrop, swnBehind);
// No geometry behind the water in the copy (its sky depth): open water lets nothing through, as built-in water.
swnOpenSky = step(${f(WATER_SCENE_COPY_SKY_DEPTH * 0.9)}, swnSceneZ);
`, wgsl)
      + "#endif\n"
      + (this.depth.hasEndpoints ? `${depth} = swnDepth;\n` : "")
      + (this.fade.hasEndpoints ? `${fade} = 1.0 - exp(-swnDepth / max(${distance}, 0.001));\n` : "")
      + (this.transmittance.hasEndpoints ? bind(`
vec3 swnTN = normalize(${this.value(this.waveNormal, `${v3}(0.0, 1.0, 0.0)`)});
float swnTNdotV = clamp(dot(swnTN, normalize(${eye} - ${position}.xyz)), 0.0, 1.0);${transmittanceSource("swnDepth", "swnTNdotV", `max(${distance}, 0.001)`, `U.${ABSORB_UNIFORM}.rgb`, `U.${ABSORB_UNIFORM}.w`, "swnT")}
${transmittance} = swnT * (1.0 - swnOpenSky);
`, wgsl) : "")
      + "#endif\n}\n";
    return this;
  }
}
RegisterClass("BABYLON.WaterDepthFadeBlock", WaterDepthFadeBlock);

/**
 * Water Scene Color: the view's scene copy behind this pixel (linear colour), bent by the surface's tilt through the
 * water behind it as built-in Refraction bends it (Refraction where connected, else the asset's), never taking anything
 * in front of the water. Available is 1 where the colour came from the copy, 0 where the pass has none (a material
 * preview, a capture, an opaque Material, Water Refraction off): Color is black there.
 */
export class WaterSceneColorBlock extends WaterNodeBlock {
  constructor(name: string) {
    super(name);
    this.registerInput("worldPosition", Types.Vector4);
    this.registerInput("view", Types.Matrix);
    this.registerInput("normal", Types.Vector3, true);
    this.registerInput("refraction", Types.Float, true);
    this.registerInput("waveNormal", Types.Vector3, true);
    this.registerOutput("color", Types.Color3);
    this.registerOutput("available", Types.Float);
  }
  get worldPosition() { return this._inputs[0]!; }
  get view() { return this._inputs[1]!; }
  get normal() { return this._inputs[2]!; }
  get refraction() { return this._inputs[3]!; }
  /** The Water Waves block's Normal, for an unconnected Normal (the compiler connects it). */
  get waveNormal() { return this._inputs[4]!; }
  get color() { return this._outputs[0]!; }
  get available() { return this._outputs[1]!; }
  override getClassName(): string { return "WaterSceneColorBlock"; }
  override prepareDefines(defines: NodeMaterialDefines, material: NodeMaterial, mesh?: AbstractMesh): void {
    prepareSurfaceDefines(defines, material, mesh, true);
  }
  override bind(effect: Effect, material: NodeMaterial, mesh?: Mesh): void {
    const scene = material.getScene();
    bindSurface(effect, scene, mesh);
    bindCopy(effect, scene, mesh);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    const wgsl = wgslOf(state), v3 = wgsl ? "vec3f" : "vec3";
    emitCopyHelpers(state);
    state._emitUniformFromString(ORIGIN_UNIFORM, Types.Vector4);
    const [color, available] = this._outputs.map((output) => output.associatedVariableName);
    state.compilationString += this.declare(state, this.color, `${v3}(0.0)`) + this.declare(state, this.available, "0.0");
    const position = this.worldPosition.associatedVariableName, view = this.view.associatedVariableName;
    const normal = this.value(this.normal, this.value(this.waveNormal, `${v3}(0.0, 1.0, 0.0)`));
    const refraction = this.value(this.refraction, `${wgsl ? "uniforms." : ""}${LOOK_UNIFORM}.x`);
    state.compilationString += `#ifdef ${WATER_NODE_COPY_DEFINE}\n{\n` + bind(`
vec2 swnUv = ${fragCoord(state)}.xy * U.${SCREEN_UNIFORM}.xy;
float swnWaterZ = abs((${view} * vec4(${position}.xyz, 1.0)).z);
float swnZ0 = swSceneDepth(swnUv);
vec3 swnN = normalize(${normal});
vec2 swnSlope = swnN.xz / max(swnN.y, 0.1);
vec2 swnTilt = (${view} * vec4(-swnSlope.x, 0.0, -swnSlope.y, 0.0)).xy;
float swnThick = min(max(swnZ0 - swnWaterZ, 0.0), ${f(REFRACTION_DEPTH_CAP)});
vec2 swnShift = swnTilt * U.${SCREEN_UNIFORM}.zw * (${refraction} * ${f(REFRACTION_SHIFT)} * swnThick * mix(1.0 / max(swnWaterZ, 0.05), 1.0, U.${LOOK_UNIFORM}.w));
swnShift = swnShift * min(1.0, mix(${f(REFRACTION_SHIFT_PX[0])}, ${f(REFRACTION_SHIFT_PX[1])}, smoothstep(${f(REFRACTION_FAR[0])}, ${f(REFRACTION_FAR[1])}, swnWaterZ)) * U.${SCREEN_UNIFORM}.x / max(length(swnShift), 0.000001));
vec2 swnBent = swnUv + swnShift;
float swnZ1 = swSceneDepth(swnBent);
float swnLeak = step(swnZ1, swnWaterZ);
swnBent = mix(swnBent, swnUv, swnLeak);
float swnSceneZ = mix(swnZ1, swnZ0, swnLeak);
`, wgsl)
      + (this.color.hasEndpoints ? `${color} = swSceneColor(swnBent);\n` : "")
      + (this.available.hasEndpoints ? `${available} = step(swnWaterZ - 0.01, swnSceneZ);\n` : "")
      + "}\n#endif\n";
    return this;
  }
}
RegisterClass("BABYLON.WaterSceneColorBlock", WaterSceneColorBlock);

/**
 * Water Reflection: what the water mirrors along the reflected view ray (linear colour times Reflection Strength; the sky
 * dimmed where the ray leaves below the horizon, as built-in water dims it) and the Fresnel weight of that reflection (built-in
 * water's environment BRDF: water's 2% at normal incidence, less at grazing angles the rougher the water). The sky is the
 * scene's environment or skybox cube, else the analytic sky built-in water reflects, blurred by Roughness (Roughness
 * where connected, else the asset's), which rises with distance as built-in water's does; scene objects replace it where
 * the asset's Object Reflections is on and the pass marches the scene copy (Screen Space reflections; Planar quality
 * marches too). Normal defaults to the Water Waves block's.
 */
export class WaterReflectionBlock extends WaterNodeBlock {
  constructor(name: string) {
    super(name);
    this.registerInput("worldPosition", Types.Vector4);
    this.registerInput("cameraPosition", Types.Vector3);
    this.registerInput("view", Types.Matrix);
    this.registerInput("viewProjection", Types.Matrix);
    this.registerInput("normal", Types.Vector3, true);
    this.registerInput("roughness", Types.Float, true);
    this.registerInput("waveNormal", Types.Vector3, true);
    this.registerOutput("color", Types.Color3);
    this.registerOutput("fresnel", Types.Float);
  }
  get worldPosition() { return this._inputs[0]!; }
  get cameraPosition() { return this._inputs[1]!; }
  get view() { return this._inputs[2]!; }
  get viewProjection() { return this._inputs[3]!; }
  get normal() { return this._inputs[4]!; }
  get roughness() { return this._inputs[5]!; }
  get waveNormal() { return this._inputs[6]!; }
  get color() { return this._outputs[0]!; }
  get fresnel() { return this._outputs[1]!; }
  override getClassName(): string { return "WaterReflectionBlock"; }
  override prepareDefines(defines: NodeMaterialDefines, material: NodeMaterial, mesh?: AbstractMesh): void {
    const scene = material.getScene();
    const copied = prepareSurfaceDefines(defines, material, mesh, true);
    defines.setValue(WATER_NODE_SSR_DEFINE, marchSteps(scene, meshWaterNodeSurface(mesh), copied), true);
    defines.setValue(WATER_NODE_ENV_DEFINE, waterSkyCube(scene) !== null, true);
  }
  override bind(effect: Effect, material: NodeMaterial, mesh?: Mesh): void {
    const scene = material.getScene();
    bindSurface(effect, scene, mesh);
    bindCopy(effect, scene, mesh);
    bindSky(effect, scene, waterSkyCube(scene));
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    const wgsl = wgslOf(state), v3 = wgsl ? "vec3f" : "vec3";
    emitCopyHelpers(state);
    state._emitUniformFromString(MARCH_UNIFORM, Types.Vector4);
    for (const name of [...SKY_UNIFORMS, ...ENV_UNIFORMS]) state._emitUniformFromString(name, Types.Vector4);
    state._emitUniformFromString(ENV_MATRIX, Types.Matrix);
    declareSampler(state, WATER_NODE_ENV_SAMPLER, "cube", WATER_NODE_ENV_DEFINE);
    state._emitFunction("swnEnvTap", `#ifdef ${WATER_NODE_ENV_DEFINE}\n${wgsl
      ? `fn swnEnvTap(dir: vec3f, lod: f32) -> vec4f { return textureSampleLevel(${WATER_NODE_ENV_SAMPLER}, ${WATER_NODE_ENV_SAMPLER}Sampler, dir, lod); }`
      : `vec4 swnEnvTap(vec3 dir, float lod) { return textureLod(${WATER_NODE_ENV_SAMPLER}, dir, lod); }`}\n#endif\n`, "");
    state._emitFunction("swMarch", `#if defined(${WATER_NODE_COPY_DEFINE}) && ${WATER_NODE_SSR_DEFINE} > 0\n${nodeMarchSource(wgsl)}\n#endif\n`, "");
    const [color, fresnel] = this._outputs.map((output) => output.associatedVariableName);
    state.compilationString += this.declare(state, this.color, `${v3}(0.0)`) + this.declare(state, this.fresnel, "0.0");
    const position = this.worldPosition.associatedVariableName, eye = this.cameraPosition.associatedVariableName;
    const normal = this.value(this.normal, this.value(this.waveNormal, `${v3}(0.0, 1.0, 0.0)`));
    const roughness = this.value(this.roughness, `${wgsl ? "uniforms." : ""}${LOOK_UNIFORM}.y`);
    state.compilationString += "{\n" + bind(`
vec3 swnV = normalize(${eye} - ${position}.xyz);
vec3 swnN = normalize(${normal});
float swnNdotV = clamp(dot(swnN, swnV), 0.0, 1.0);
float swnRoughNear = clamp(${roughness}, 0.0, 1.0);
float swnRough = mix(max(swnRoughNear, ${f(WATER_FAR_ROUGHNESS)}), swnRoughNear, 1.0 / (1.0 + length(${eye} - ${position}.xyz) * ${f(WATER_GLOSS_FALLOFF)}));
${fresnelSource("swnRough", "swnNdotV", "swnFres")}
vec3 swnR = reflect(-swnV, swnN);
${reflectionKeepSource("swnR.y", "swnV.y", "swnKeep")}
swnR = normalize(vec3(swnR.x, max(swnR.y, 0.02), swnR.z));
float swnSkyH = 1.0 - clamp(swnR.y, 0.0, 1.0);
swnSkyH = swnSkyH * swnSkyH * swnSkyH;
vec3 swnSky = mix(U.slateWaterNodeSky.rgb, U.slateWaterNodeHorizon.rgb, swnSkyH);
vec4 swnSun = U.slateWaterNodeSun;
float swnAz = clamp(dot(swnR.xz / max(length(swnR.xz), 0.0001), U.slateWaterNodeSunShape.xy), 0.0, 1.0);
float swnAura = max(dot(swnR, swnSun.xyz), 0.0);
swnAura = swnAura * swnAura;
swnAura = swnAura * swnAura;
swnAura = swnAura * swnAura;
swnSky += U.slateWaterNodeSunColor.rgb * swnSun.w * (U.slateWaterNodeSunColor.rgb * (swnSkyH * U.slateWaterNodeSunShape.z * (0.25 + 0.35 * swnAz * swnAz)) + vec3(swnAura * 0.05));
swnSky = mix(swnSky, mix(U.slateWaterNodeSky.rgb, U.slateWaterNodeHorizon.rgb, 0.55), smoothstep(0.1, 0.6, swnRough) * 0.5);
`, wgsl) + `#ifdef ${WATER_NODE_ENV_DEFINE}\n` + bind(`
vec3 swnDir = (U.${ENV_MATRIX} * vec4(swnR, 0.0)).xyz * U.slateWaterNodeEnvFlip.xyz;
vec4 swnEnv = swnEnvTap(swnDir, swnRough * U.slateWaterNodeEnv.x + U.slateWaterNodeEnvFlip.w);
vec3 swnGamma = pow(max(swnEnv.rgb, vec3(0.0)), vec3(2.2));
vec3 swnLinear = mix(swnEnv.rgb, swnGamma, U.slateWaterNodeEnv.z);
swnSky = mix(swnLinear, swnGamma / max(swnEnv.a, 0.0001), U.slateWaterNodeEnv.y) * U.slateWaterNodeEnv.w;
`, wgsl) + `#endif\n${bind("swnSky = swnSky * swnKeep;", wgsl)}#if defined(${WATER_NODE_COPY_DEFINE}) && ${WATER_NODE_SSR_DEFINE} > 0\n`
      + bind(`vec4 swnHit = swMarch(${position}.xyz, swnR, ${this.viewProjection.associatedVariableName}, ${this.view.associatedVariableName}, ${eye});
swnSky = mix(swnSky, swnHit.rgb, swnHit.a * (1.0 - smoothstep(0.2, 0.45, swnRoughNear)));
`, wgsl) + "#endif\n"
      + (this.color.hasEndpoints ? `${color} = swnSky * ${wgsl ? "uniforms." : ""}${LOOK_UNIFORM}.z;\n` : "")
      + (this.fresnel.hasEndpoints ? `${fresnel} = swnFres;\n` : "")
      + "}\n";
    return this;
  }
}
RegisterClass("BABYLON.WaterReflectionBlock", WaterReflectionBlock);

/** Water Colors' uniforms, apart from every other water uniform (the Water Waves node's foam terms are `slateWaterNodeFoam`). */
export const WATER_NODE_COLOR_UNIFORMS = ["slateWaterNodeShallowColor", "slateWaterNodeDeepColor", "slateWaterNodeFoamColor"] as const;
const COLOR_UNIFORMS = WATER_NODE_COLOR_UNIFORMS;
/** Partner k's colours (`WaterNodeSurface.partners`), in `COLOR_UNIFORMS` order: `slateWaterNodeShallowColor${k}` and so on. */
const PARTNER_COLOR_UNIFORMS = Array.from({ length: WATER_BLEND_COLOR_PARTNERS }, (_, k) => COLOR_UNIFORMS.map((name) => `${name}${k}`));
const BLEND_SHARES_VARYING = "vSlateWaterNodeShares";
const COLOR_FIELDS = ["shallowColor", "deepColor", "foamColor"] as const;
/** The Realistic defaults a material preview shows. */
const PREVIEW_WATER = createDefaultWaterDefinition();
const colorScratch = new Color3(), linearScratch = new Color3();

/**
 * Water Colors: the asset's Shallow, Deep and Foam Color (linear, as built-in water converts them) and its Opacity, so a
 * Custom Material follows the Water asset's Inspector. Where the water mesh blends with neighbours coloured unlike it,
 * the colours mix toward theirs by the same per-vertex shares built-in water uses, so a Custom Material body and its
 * neighbours meet in one colour. Scene Light is how strongly the scene lights the water's own colour, as built-in water
 * scales it. Off a water mesh (a material preview) the default water's.
 */
export class WaterColorsBlock extends WaterNodeBlock {
  constructor(name: string) {
    super(name);
    for (const output of ["shallowColor", "deepColor", "foamColor"]) this.registerOutput(output, Types.Color3);
    this.registerOutput("opacity", Types.Float);
    this.registerOutput("sceneLight", Types.Float);
  }
  get shallowColor() { return this._outputs[0]!; }
  get deepColor() { return this._outputs[1]!; }
  get foamColor() { return this._outputs[2]!; }
  get opacity() { return this._outputs[3]!; }
  /** How strongly the scene lights the water's own colour, as built-in water scales Deep Color (`sceneWaterBodyLight`). */
  get sceneLight() { return this._outputs[4]!; }
  override getClassName(): string { return "WaterColorsBlock"; }
  override prepareDefines(defines: NodeMaterialDefines, _material: NodeMaterial, mesh?: AbstractMesh): void {
    defines.setValue(WATER_NODE_BLEND_DEFINE, isWaterSurfaceMesh(mesh) && mesh!.isVerticesDataPresent("slateWaterBlendColors"), true);
  }
  override bind(effect: Effect, material: NodeMaterial, mesh?: Mesh): void {
    const surface = meshWaterNodeSurface(mesh), w = surface?.water ?? PREVIEW_WATER, exact = material.getScene().getEngine().useExactSrgbConversions;
    const scene = material.getScene(), light = sceneWaterBodyLight(scene, w, waterSkyCube(scene) !== null);
    // w: Opacity with Shallow Color, the scene's light on the water with Deep Color.
    const put = (names: readonly string[], water: WaterDefinition) => {
      for (const [i, name] of names.entries()) {
        const [r, g, b] = water[COLOR_FIELDS[i]!];
        colorScratch.set(r, g, b).toLinearSpaceToRef(linearScratch, exact);
        effect.setFloat4(name, linearScratch.r, linearScratch.g, linearScratch.b, i === 0 ? water.opacity : i === 1 ? light : 0);
      }
    };
    put(COLOR_UNIFORMS, w);
    // An empty slot repeats the asset's own colours, so a share toward it changes nothing.
    for (let k = 0; k < WATER_BLEND_COLOR_PARTNERS; k++) put(PARTNER_COLOR_UNIFORMS[k]!, surface?.partners[k] ?? w);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    const wgsl = wgslOf(state), u = wgsl ? "uniforms." : "", v3 = wgsl ? "vec3f" : "vec3";
    for (const name of [...COLOR_UNIFORMS, ...PARTNER_COLOR_UNIFORMS.flat()]) state._emitUniformFromString(name, Types.Vector4);
    // The partners' shares: partner 0's in slateWaterBlend's w, partners 1 and 2's in slateWaterBlendColors.
    const vertex = state._vertexState, into = wgsl ? "vertexOutputs." : "", input = wgsl ? "vertexInputs." : "";
    declareWaterAttributes(vertex, WATER_BLEND_ATTRIBUTE_CONDITION, [["slateWaterBlend", 4]]);
    declareWaterAttributes(vertex, WATER_NODE_BLEND_DEFINE, [["slateWaterBlendColors", 2]]);
    if (vertex._emitVaryingFromString(BLEND_SHARES_VARYING, Types.Vector3, WATER_NODE_BLEND_DEFINE)) {
      vertex.compilationString += `#ifdef ${WATER_NODE_BLEND_DEFINE}\n${into}${BLEND_SHARES_VARYING} = ${v3}(${input}slateWaterBlend.w, ${input}slateWaterBlendColors);\n#endif\n`;
    }
    state._emitVaryingFromString(BLEND_SHARES_VARYING, Types.Vector3, WATER_NODE_BLEND_DEFINE);
    const shares = `${wgsl ? "fragmentInputs." : ""}${BLEND_SHARES_VARYING}`;
    const color = (i: number, swizzle: string) => {
      const own = `${u}${COLOR_UNIFORMS[i]}.${swizzle}`;
      const mixed = `${own} * (1.0 - ${shares}.x - ${shares}.y - ${shares}.z)`
        + PARTNER_COLOR_UNIFORMS.map((names, k) => ` + ${u}${names[i]}.${swizzle} * ${shares}.${"xyz"[k]}`).join("");
      return { own, mixed };
    };
    const outputs = [...COLOR_UNIFORMS.map((_, i) => [this._outputs[i]!, color(i, "rgb")] as const), [this.opacity, color(0, "w")] as const];
    for (const [output, { own, mixed }] of outputs) {
      if (!output.hasEndpoints) continue;
      state.compilationString += `${state._declareOutput(output)} = ${own};\n#ifdef ${WATER_NODE_BLEND_DEFINE}\n${output.associatedVariableName} = ${mixed};\n#endif\n`;
    }
    state.compilationString += this.declare(state, this.sceneLight, `${u}${COLOR_UNIFORMS[1]}.w`);
    return this;
  }
}
RegisterClass("BABYLON.WaterColorsBlock", WaterColorsBlock);

const marchSources = new Map<boolean, string>();
/**
 * Built-in water's screen-space march (`marchSource`) with the view, view-projection and eye as parameters: the node's
 * own matrix inputs, which follow the floating origin as the graph's positions do.
 */
function nodeMarchSource(wgsl: boolean): string {
  let source = marchSources.get(wgsl);
  if (!source) {
    source = stripShaderComments(wgsl
      ? marchSource(true)
        .replace("fn swMarch(swOrigin: vec3f, swRay: vec3f) -> vec4f {", "fn swMarch(swOrigin: vec3f, swRay: vec3f, swVP: mat4x4f, swV: mat4x4f, swEyeP: vec3f) -> vec4f {")
        .replace(/scene\.viewProjection/g, "swVP").replace(/scene\.view\b/g, "swV").replace(/scene\.vEyePosition\.xyz/g, "swEyeP")
      : marchSource(false)
        .replace("vec4 swMarch(vec3 swOrigin, vec3 swRay) {", "vec4 swMarch(vec3 swOrigin, vec3 swRay, mat4 swVP, mat4 swV, vec3 swEyeP) {")
        .replace(/\bviewProjection\b/g, "swVP").replace(/\(view \*/g, "(swV *").replace(/\bvEyePosition\.xyz/g, "swEyeP"));
    marchSources.set(wgsl, source);
  }
  return source;
}

/** Water node blocks that read the terrain and contact fields. */
const FIELD_BLOCKS = [WaterFoamBlock, WaterDepthFadeBlock];
/** Water node blocks that sample the view's scene copy: (refraction-style reads, reflection marches). */
const COPY_BLOCKS = [WaterSceneColorBlock, WaterDepthFadeBlock];

/** Whether a built material's graph reads the terrain and contact fields (Water Foam, Water Depth Fade). */
export function materialUsesWaterFields(material: Material | null | undefined): boolean {
  return material instanceof NodeMaterial && material.attachedBlocks.some((block) => FIELD_BLOCKS.some((type) => block instanceof type));
}

/**
 * What a built material's graph reads from the view's scene copy: `refraction` for Water Scene Color and Water Depth
 * Fade, `reflection` for Water Reflection (which marches it for objects).
 */
export function materialSceneCopyUse(material: Material | null | undefined): { refraction: boolean; reflection: boolean } {
  const blocks = material instanceof NodeMaterial ? material.attachedBlocks : [];
  return {
    refraction: blocks.some((block) => COPY_BLOCKS.some((type) => block instanceof type)),
    reflection: blocks.some((block) => block instanceof WaterReflectionBlock),
  };
}
