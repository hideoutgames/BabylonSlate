import {
  FragmentOutputBlock, NodeMaterialBlock, NodeMaterialBlockTargets as Targets,
  NodeMaterialBlockConnectionPointTypes as Types, RawTexture, Texture,
  type AbstractMesh, type BaseTexture, type Effect, type Mesh, type NodeMaterial,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { geometryOutputWrite } from "./geometry-surface-output-block";
import { overlayVisualStyle } from "./overlay-visual-style";

/**
 * What one mesh draws with the unlit Material (`unlit-material.ts`). Bound per draw, so meshes with different textures,
 * colours and alpha share one program.
 */
export type UnlitBinding = {
  /** The texture the colour multiplies, or none (`UnlitMaterialKey.textured` instances read it). */
  texture: BaseTexture | null;
  /** Display-space colour, clamped to [0, 1] (Standard's clamped emissive). */
  color: readonly [number, number, number];
  alpha: number;
  /** Fragments whose alpha is below this are discarded; 0 discards none. */
  cutoff: number;
  /** Blended whatever the alpha (Standard's `MATERIAL_ALPHABLEND`). */
  blend: boolean;
  /** The texture's alpha multiplies the surface's (Standard's `useAlphaFromDiffuseTexture` with a texture that has alpha). */
  textureAlpha: boolean;
  /** Back faces flip the geometry pass's normal (Standard's `twoSidedLighting`). */
  twoSided: boolean;
};

const bindings = new WeakMap<AbstractMesh, UnlitBinding>();
const DEFAULT_BINDING: UnlitBinding = {
  texture: null, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: false, textureAlpha: true, twoSided: false,
};

const materialBindings = new WeakMap<object, UnlitBinding>();

export function setUnlitBinding(mesh: AbstractMesh, binding: UnlitBinding): void {
  bindings.set(mesh, binding);
}
/** Every mesh drawing `material` draws `binding` (`ownedUnlitMaterial`). */
export function setMaterialUnlitBinding(material: object, binding: UnlitBinding): void {
  materialBindings.set(material, binding);
}
/**
 * The binding `mesh` draws: its material's own (`ownedUnlitMaterial`), its own, or, for a pooled visual's leaf
 * replaced by a mesh of its own under the visual (`setActorMeshMaterial`), the visual's.
 */
export function unlitBinding(mesh: AbstractMesh | undefined): UnlitBinding {
  if (!mesh) return DEFAULT_BINDING;
  return (mesh.material && materialBindings.get(mesh.material)) ?? bindings.get(mesh) ?? bindings.get(mesh.parent as AbstractMesh) ?? DEFAULT_BINDING;
}
export function hasUnlitBinding(mesh: AbstractMesh): boolean {
  return bindings.has(mesh);
}

const perMeshMaterials = new WeakSet<object>();
/** Marks an unlit Material: each mesh binds its own values, which pooled instances (drawn as their source) cannot. */
export function markPerMeshBindingMaterial(material: object): void {
  perMeshMaterials.add(material);
}
export function hasPerMeshBindings(material: object): boolean {
  return perMeshMaterials.has(material);
}

/** Uniform names: one graph per instance, so fixed names keep every instance's code byte-identical. */
const U = {
  sampler: "unlitTextureSampler",
  matrix: "unlitTextureMatrix",
  color: "unlitColor",
  alpha: "unlitAlpha",
  finish: "unlitFinish",
  tint: "unlitTint",
  geometry: "unlitGeometry",
} as const;

/** Whether the mesh's vertex colours carry alpha (Standard's `VERTEXALPHA`). */
function vertexAlpha(mesh: AbstractMesh): boolean {
  return mesh.hasVertexAlpha && mesh.useVertexColors;
}

/** Every per-mesh uniform, bound by the surface block (and again by the frozen-material rebind hook). */
function bindUnlitUniforms(effect: Effect, material: NodeMaterial, mesh: AbstractMesh, fallback: BaseTexture | null, textured: boolean): void {
  const binding = unlitBinding(mesh);
  if (textured) {
    const texture = binding.texture ?? fallback;
    effect.setTexture(U.sampler, texture);
    if (texture) effect.setMatrix(U.matrix, texture.getTextureMatrix());
  }
  effect.setFloat4(U.color, binding.color[0], binding.color[1], binding.color[2], binding.alpha);
  const keepAlpha = material.needAlphaBlendingForMesh(mesh);
  effect.setFloat4(U.alpha, binding.cutoff, keepAlpha ? 1 : 0, textured && binding.textureAlpha && binding.texture?.hasAlpha ? 1 : 0, vertexAlpha(mesh) ? 1 : 0);
  effect.setFloat4(U.finish, mesh.visibility, 0, 0, 0);
  const { opacity, tint } = overlayVisualStyle(mesh);
  effect.setFloat4(U.tint, tint[0], tint[1], tint[2], tint[3] * opacity);
  const scene = mesh.getScene();
  effect.setFloat4(U.geometry, binding.cutoff > 0 && !binding.blend ? 1 : 0, scene._mirroredCameraPosition ? -1 : 1, binding.twoSided ? 1 : 0, 0);
}

/** Vertex: the bound texture's UV transform, as Standard's `diffuseMatrix` (an identity is exact). */
export class UnlitUvBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, Targets.Vertex);
    this.registerInput("uv", Types.Vector2);
    this.registerOutput("output", Types.Vector2);
  }
  get uv() { return this._inputs[0]!; }
  get output() { return this._outputs[0]!; }
  override getClassName(): string { return "UnlitUvBlock"; }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state._emitUniformFromString(U.matrix, Types.Matrix);
    const wgsl = state.shaderLanguage === 1;
    state.compilationString += `${state._declareOutput(this.output)} = (${wgsl ? "uniforms." : ""}${U.matrix} * vec4${wgsl ? "f" : ""}(${this.uv.associatedVariableName}, 1.0, 0.0)).xy;\n`;
    return this;
  }
}
RegisterClass("BABYLON.UnlitUvBlock", UnlitUvBlock);

/**
 * Fragment: Standard's unlit colour and alpha. rgb = colour · [texture rgb] · [vertex rgb], alpha = alpha · [texture a] ·
 * [vertex a], discarded below the cutoff, and 1 where an alpha-tested surface does not blend; also the geometry pass's
 * face normal, from derivatives taken before any discard. Binds every per-mesh uniform of the unlit graph.
 */
export class UnlitSurfaceBlock extends NodeMaterialBlock {
  /** Build-time: the instance samples the bound texture. */
  textured = false;
  /** The Material whose blending decides whether alpha is kept (a pass variant's surface); the drawing one otherwise. */
  alphaOwner: NodeMaterial | null = null;
  private fallback: RawTexture | null = null;

  constructor(name: string) {
    super(name, Targets.Fragment);
    this.registerInput("uv", Types.Vector2, true);
    this.registerInput("vertexColor", Types.Color4, true);
    this.registerInput("worldPosition", Types.Vector4);
    this.registerOutput("rgb", Types.Color3);
    this.registerOutput("a", Types.Float);
    this.registerOutput("faceNormal", Types.Vector3);
  }
  get uv() { return this._inputs[0]!; }
  get vertexColor() { return this._inputs[1]!; }
  get worldPosition() { return this._inputs[2]!; }
  get rgb() { return this._outputs[0]!; }
  get a() { return this._outputs[1]!; }
  get faceNormal() { return this._outputs[2]!; }
  override getClassName(): string { return "UnlitSurfaceBlock"; }

  override isReady(mesh: AbstractMesh): boolean {
    return !this.textured || (unlitBinding(mesh).texture?.isReady() ?? true);
  }

  override bind(effect: Effect, material: NodeMaterial, mesh?: Mesh): void {
    if (mesh) bindUnlitUniforms(effect, this.alphaOwner ?? material, mesh, this.fallback, this.textured);
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    if (this.textured && !this.fallback) {
      this.fallback = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1,
        state.sharedData.nodeMaterial.getScene(), false, false, Texture.NEAREST_SAMPLINGMODE);
    }
    // Per-mesh values: the compiler's frozen-material hook rebinds them when Babylon skips frozen forced bindings.
    state.sharedData.forcedBindableBlocks.push(this);
    state.sharedData.blockingBlocks.push(this);
    const wgsl = state.shaderLanguage === 1;
    const u = wgsl ? "uniforms." : "";
    const vec3 = state._getShaderType(Types.Vector3), vec4 = state._getShaderType(Types.Vector4);
    if (this.textured) state._emit2DSampler(U.sampler);
    state._emitUniformFromString(U.color, Types.Vector4);
    state._emitUniformFromString(U.alpha, Types.Vector4);
    if (!wgsl) state._emitExtension("derivatives", "#extension GL_OES_standard_derivatives : enable");
    const sample = state._getFreeVariableName("unlitSample");
    const position = this.worldPosition.associatedVariableName;
    // Standard's normal without a normal attribute (`default.fragment`); outside any branch, as derivatives need.
    state.compilationString += `${state._declareOutput(this.faceNormal)} = normalize(cross(${wgsl ? "dpdx" : "dFdx"}(${position}.xyz), ${wgsl ? "dpdy" : "dFdy"}(${position}.xyz)));\n`;
    const uv = this.uv.isConnected ? this.uv.associatedVariableName : `${wgsl ? "vec2f" : "vec2"}(0.0)`;
    state.compilationString += `${state._declareLocalVar(sample, Types.Vector4)} = ${this.textured
      ? (wgsl ? `textureSample(${U.sampler}, ${U.sampler}Sampler, ${uv})` : `texture2D(${U.sampler}, ${uv})`)
      : `${vec4}(1.0)`};\n`;
    const rgb = this.rgb.associatedVariableName, a = this.a.associatedVariableName;
    state.compilationString += `${state._declareOutput(this.rgb)} = ${u}${U.color}.rgb * ${sample}.rgb;\n`;
    state.compilationString += `${state._declareOutput(this.a)} = ${u}${U.color}.a * mix(1.0, ${sample}.a, ${u}${U.alpha}.z);\n`;
    if (this.vertexColor.isConnected) {
      const color = this.vertexColor.associatedVariableName;
      state.compilationString += `#ifdef VERTEXCOLOR_NME\n${rgb} *= ${color}.rgb;\n${a} *= mix(1.0, ${color}.a, ${u}${U.alpha}.w);\n#endif\n`;
    }
    state.compilationString += `if (${a} < ${u}${U.alpha}.x) { discard; }\n`;
    state.compilationString += `if (${u}${U.alpha}.x > 0.0 && ${u}${U.alpha}.y < 0.5) { ${a} = 1.0; }\n`;
    state.compilationString += `${rgb} = max(${rgb}, ${vec3}(0.0));\n`;
    return this;
  }

  override dispose(): void {
    this.fallback?.dispose();
    this.fallback = null;
    super.dispose();
  }
}
RegisterClass("BABYLON.UnlitSurfaceBlock", UnlitSurfaceBlock);

/** Fragment, after image processing: Standard's `alpha *= visibility`, then the overlay style's tint. */
export class UnlitFinishBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, Targets.Fragment);
    this.registerInput("input", Types.Color4);
    this.registerOutput("output", Types.Color4);
  }
  get input() { return this._inputs[0]!; }
  get output() { return this._outputs[0]!; }
  override getClassName(): string { return "UnlitFinishBlock"; }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state._emitUniformFromString(U.finish, Types.Vector4);
    state._emitUniformFromString(U.tint, Types.Vector4);
    const u = state.shaderLanguage === 1 ? "uniforms." : "";
    const output = this.output.associatedVariableName;
    state.compilationString += `${state._declareOutput(this.output)} = ${this.input.associatedVariableName};\n`;
    state.compilationString += `${output}.a *= ${u}${U.finish}.x;\n${output} *= ${u}${U.tint};\n`;
    return this;
  }
}
RegisterClass("BABYLON.UnlitFinishBlock", UnlitFinishBlock);

/** Vertex: the current and previous clip positions Standard's linear velocity reads (`prePassVertex`). */
export class UnlitVelocityBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, Targets.Vertex);
    this.registerInput("position", Types.Vector3);
    this.registerInput("worldPosition", Types.Vector4);
    this.registerInput("viewProjection", Types.Matrix);
    this.registerOutput("current", Types.Vector4);
    this.registerOutput("previous", Types.Vector4);
  }
  get position() { return this._inputs[0]!; }
  get worldPosition() { return this._inputs[1]!; }
  get viewProjection() { return this._inputs[2]!; }
  get current() { return this._outputs[0]!; }
  get previous() { return this._outputs[1]!; }
  override getClassName(): string { return "UnlitVelocityBlock"; }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    // NodeMaterial binds both for a geometry pass (`MaterialHelperGeometryRendering.Bind`).
    state._emitUniformFromString("previousWorld", Types.Matrix, "PREPASS_VELOCITY_LINEAR");
    state._emitUniformFromString("previousViewProjection", Types.Matrix, "PREPASS_VELOCITY_LINEAR");
    const wgsl = state.shaderLanguage === 1;
    const u = wgsl ? "uniforms." : "", vec4 = state._getShaderType(Types.Vector4);
    const current = this.current.associatedVariableName, previous = this.previous.associatedVariableName;
    state.compilationString += `${state._declareOutput(this.current)} = ${vec4}(0.0);\n${state._declareOutput(this.previous)} = ${vec4}(0.0);\n`;
    state.compilationString += `#ifdef PREPASS_VELOCITY_LINEAR\n${current} = ${this.viewProjection.associatedVariableName} * ${this.worldPosition.associatedVariableName};\n`
      + `${previous} = ${u}previousViewProjection * ${u}previousWorld * ${vec4}(${this.position.associatedVariableName}, 1.0);\n#endif\n`;
    return this;
  }
}
RegisterClass("BABYLON.UnlitVelocityBlock", UnlitVelocityBlock);

/**
 * The colour output with Standard's unlit geometry encodings (`default.fragment`): view depth, normalized view depth,
 * the derivative face normal (mirrored views and back faces of two-sided surfaces flip it), no reflectivity, linear
 * velocity and object ID, each scaled by Standard's `writeGeometryInfo` (1 for an alpha-tested surface, else alpha
 * above 0.4).
 */
export class UnlitOutputBlock extends FragmentOutputBlock {
  constructor(name: string) {
    super(name);
    /** View-space position, transformed per vertex as Standard's `vViewPos` is. */
    this.registerInput("geometryViewPosition", Types.Vector4);
    this.registerInput("geometryNormal", Types.Vector3);
    this.registerInput("geometryCamera", Types.Vector4);
    this.registerInput("velocityCurrent", Types.Vector4);
    this.registerInput("velocityPrevious", Types.Vector4);
  }
  get geometryViewPosition() { return this.getInputByName("geometryViewPosition")!; }
  get geometryNormal() { return this.getInputByName("geometryNormal")!; }
  get geometryCamera() { return this.getInputByName("geometryCamera")!; }
  get velocityCurrent() { return this.getInputByName("velocityCurrent")!; }
  get velocityPrevious() { return this.getInputByName("velocityPrevious")!; }
  override getClassName(): string { return "UnlitOutputBlock"; }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state._emitUniformFromString(U.geometry, Types.Vector4);
    const wgsl = state.shaderLanguage === 1;
    const u = wgsl ? "uniforms." : "";
    const vec2 = state._getShaderType(Types.Vector2), vec4 = state._getShaderType(Types.Vector4);
    const color = this.rgba.isConnected ? this.rgba.associatedVariableName : "";
    const info = state._getFreeVariableName("unlitGeometryInfo");
    const normal = state._getFreeVariableName("unlitGeometryNormal");
    const viewPosition = this.geometryViewPosition.associatedVariableName;
    const camera = this.geometryCamera.associatedVariableName;
    const current = this.velocityCurrent.associatedVariableName, previous = this.velocityPrevious.associatedVariableName;
    const frontFacing = wgsl ? "fragmentInputs.frontFacing" : "gl_FrontFacing";
    state.compilationString += `#ifdef PREPASS\n`
      + `${state._declareLocalVar(info, Types.Float)} = ${wgsl ? `select(0.0, 1.0, ${color}.a > 0.4)` : `${color}.a > 0.4 ? 1.0 : 0.0`};\n`
      + `if (${u}${U.geometry}.x > 0.5) { ${info} = 1.0; }\n`
      + `${state._declareLocalVar(normal, Types.Vector3)} = ${this.geometryNormal.associatedVariableName} * ${u}${U.geometry}.y;\n`
      + `if (${u}${U.geometry}.z > 0.5 && !${frontFacing}) { ${normal} = -${normal}; }\n#endif\n`;
    for (const [define, value] of [
      ["PREPASS_OBJECT_ID", `encodeObjectId(${u}objectId) * ${info}`],
      ["PREPASS_DEPTH", `${vec4}(${viewPosition}.z, 0.0, 0.0, ${info})`],
      ["PREPASS_NORMALIZED_VIEW_DEPTH", `${vec4}((${viewPosition}.z - ${camera}.y) / (${camera}.z - ${camera}.y), 0.0, 0.0, ${info})`],
      ["PREPASS_WORLD_NORMAL", `${vec4}(${normal} * 0.5 + 0.5, ${info})`],
      ["PREPASS_REFLECTIVITY", `${vec4}(0.0, 0.0, 0.0, 1.0) * ${info}`],
      ["PREPASS_VELOCITY_LINEAR", `${vec4}(${vec2}(0.5) * ((${previous}.xy / ${previous}.w) - (${current}.xy / ${current}.w)), 0.0, ${info})`],
    ]) state.compilationString += geometryOutputWrite(wgsl, define!, value!);
    return this;
  }
}
RegisterClass("BABYLON.UnlitOutputBlock", UnlitOutputBlock);
