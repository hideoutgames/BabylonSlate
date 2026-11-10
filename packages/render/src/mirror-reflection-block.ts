import {
  NodeMaterialBlockConnectionPointTypes as Types,
} from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import type { NodeMaterial, NodeMaterialDefines } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Shaders/ShadersInclude/helperFunctions";
// The WGSL twin registers with the WebGPU Engine's code (webgpu-registrations).
import { environmentCube, environmentPlaceholder } from "./haptic-lighting-block";
import { existingMirrorFallbackTexture, mirrorReflectionBinding, type MirrorReflectionBinding } from "./mirror-surface-state";

const scratchOffset = new Matrix();
const scratchMatrix = new Matrix();
/** The roughness the environment's sharpest level is filtered for (Babylon's prefilter floor), which a mirror reads. */
const SHARPEST_ROUGHNESS = 0.0005;

/**
 * The reflection a Mirror component drew, sampled at the surface's own screen position plus Offset (texture units).
 *
 * The sampler and its code compile only into a Mirror surface's variant (a per-mesh define), so the same Material on
 * any other mesh, or in a preview, outputs black and binds nothing. A surface whose reflection has not drawn yet (or
 * holds no storage) binds the scene's one-texel placeholder and outputs black. `builtIn` is the Mirror's own surface:
 * the stored colour unchanged (already in the view's colour space) times the component's Tint. Otherwise the output is
 * linear colour, as graph colours are: display-encoded reflections are decoded.
 *
 * A surface that does not reflect everything (`MirrorReflectionBinding.reflects`) compiles a second variant, which
 * shows the environment where its reflection drew nothing: the cube that lights the surface (the Reflection Probe it
 * stands in, or the Scene's sky), looked up along the mirrored view ray, projected onto a probe's box and read at its
 * sharpest level. The reflection's alpha says where nothing drew; a surface without a drawn reflection is all
 * environment. A Scene with no environment, or one whose cube is still loading, shows its clear colour there.
 */
export class MirrorReflectionBlock extends NodeMaterialBlock {
  readonly builtIn: boolean;
  private sampler = "";
  private define = "";
  private matrix = "";
  private parameters = "";
  private tint = "";
  private environmentDefine = "";
  private environmentSampler = "";
  private environmentMatrix = "";
  private environmentForm = "";
  private environmentBoxPosition = "";
  private environmentBoxSize = "";
  private eye = "";
  private normal = "";
  private backdrop = "";

  constructor(name: string, builtIn = false) {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.builtIn = builtIn;
    this.registerInput("worldPosition", Types.Vector4, false);
    this.registerInput("offset", Types.Vector2, true);
    this.registerOutput("color", Types.Color3);
  }

  get worldPosition() { return this._inputs[0]!; }
  get offset() { return this._inputs[1]!; }
  get color() { return this._outputs[0]!; }

  override getClassName(): string { return "MirrorReflectionBlock"; }

  override prepareDefines(defines: NodeMaterialDefines, _material: NodeMaterial, mesh?: AbstractMesh): void {
    const binding = mirrorReflectionBinding(mesh);
    defines.setValue(this.define, !!binding, true);
    defines.setValue(this.environmentDefine, !!binding && binding.reflects !== "everything", true);
  }

  override bind(effect: Effect, material: NodeMaterial, mesh?: AbstractMesh): void {
    const binding = mirrorReflectionBinding(mesh);
    if (!binding) return;
    const scene = material.getScene();
    const texture = binding.texture?.getInternalTexture() ? binding.texture : null;
    if (texture) {
      effect.setTexture(this.sampler, texture);
      // Positions arrive relative to this pass's floating origin; the matrix takes them relative to the drawn one.
      const offset = scene.floatingOriginOffset, origin = binding.origin;
      const dx = offset.x - origin.x, dy = offset.y - origin.y, dz = offset.z - origin.z;
      if (dx === 0 && dy === 0 && dz === 0) effect.setMatrix(this.matrix, binding.viewProjection);
      else {
        Matrix.TranslationToRef(dx, dy, dz, scratchOffset);
        scratchOffset.multiplyToRef(binding.viewProjection, scratchMatrix);
        effect.setMatrix(this.matrix, scratchMatrix);
      }
    } else {
      const fallback = existingMirrorFallbackTexture(scene);
      if (fallback) effect.setTexture(this.sampler, fallback);
      effect.setMatrix(this.matrix, Matrix.IdentityReadOnly);
    }
    effect.setFloat4(this.parameters, texture ? 1 : 0, binding.gammaSpace ? 1 : 0, 0, 0);
    if (this.builtIn) effect.setFloat3(this.tint, binding.tint[0], binding.tint[1], binding.tint[2]);
    if (binding.reflects !== "everything") this.bindEnvironment(effect, scene, binding);
  }

  /** What the surface shows where its reflection drew nothing: the cube that lights it, the eye and its plane. */
  private bindEnvironment(effect: Effect, scene: Scene, binding: MirrorReflectionBinding): void {
    // Positions are relative to the pass's floating origin, so the eye and a probe's box are too.
    const origin = scene.floatingOriginOffset;
    const eye = scene.activeCamera?.globalPosition ?? origin;
    const cube = environmentCube(scene);
    effect.setFloat4(this.eye, eye.x - origin.x, eye.y - origin.y, eye.z - origin.z, cube ? 1 : 0);
    effect.setFloat3(this.normal, binding.normal.x, binding.normal.y, binding.normal.z);
    const clear = scene.clearColor;
    effect.setFloat3(this.backdrop, clear.r, clear.g, clear.b);
    if (!cube) {
      // WebGPU draws only with every declared texture bound.
      effect.setTexture(this.environmentSampler, environmentPlaceholder(scene));
      return;
    }
    effect.setTexture(this.environmentSampler, cube);
    effect.setMatrix(this.environmentMatrix, cube.getReflectionTextureMatrix());
    const box = cube as CubeTexture;
    // Its form, as the light block reads it: a probe's box projection, the signs of the cube's y and z axes, and its
    // encoding (0 linear, 1 gamma, 2 RGBD).
    effect.setFloat4(this.environmentForm, box.boundingBoxSize ? 1 : 0,
      cube.coordinatesMode === Constants.TEXTURE_INVCUBIC_MODE ? -1 : 1,
      (scene.useRightHandedSystem ? !cube.invertZ : cube.invertZ) ? -1 : 1,
      cube.isRGBD ? 2 : cube.gammaSpace ? 1 : 0);
    // The cube's sharpest level, which is its first unless its levels are offset; a cube without level metadata reads its first.
    const lod = Math.max(0, Math.log2(cube.getSize().width * SHARPEST_ROUGHNESS) * cube.lodGenerationScale + cube.lodGenerationOffset) || 0;
    const position = box.boundingBoxSize ? box.boundingBoxPosition : origin;
    effect.setFloat4(this.environmentBoxPosition, position.x - origin.x, position.y - origin.y, position.z - origin.z, lod);
    const size = box.boundingBoxSize;
    effect.setFloat3(this.environmentBoxSize, size?.x ?? 0, size?.y ?? 0, size?.z ?? 0);
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    const wgsl = state.shaderLanguage === 1;
    this.sampler = state._getFreeVariableName("slateMirrorSampler");
    this.define = state._getFreeDefineName("SLATE_MIRROR_REFLECTION");
    this.matrix = state._getFreeVariableName("slateMirrorViewProjection");
    this.parameters = state._getFreeVariableName("slateMirrorParameters");
    this.environmentDefine = state._getFreeDefineName("SLATE_MIRROR_ENVIRONMENT");
    this.environmentSampler = state._getFreeVariableName("slateMirrorEnvironmentSampler");
    this.environmentMatrix = state._getFreeVariableName("slateMirrorEnvironmentMatrix");
    this.environmentForm = state._getFreeVariableName("slateMirrorEnvironmentForm");
    this.environmentBoxPosition = state._getFreeVariableName("slateMirrorEnvironmentBoxPosition");
    this.environmentBoxSize = state._getFreeVariableName("slateMirrorEnvironmentBoxSize");
    this.eye = state._getFreeVariableName("slateMirrorEye");
    this.normal = state._getFreeVariableName("slateMirrorNormal");
    this.backdrop = state._getFreeVariableName("slateMirrorBackdrop");
    state.sharedData.blocksWithDefines.push(this);
    state.sharedData.bindableBlocks.push(this);
    state._emit2DSampler(this.sampler, this.define);
    state._emitCubeSampler(this.environmentSampler, this.environmentDefine);
    state._emitUniformFromString(this.matrix, Types.Matrix);
    state._emitUniformFromString(this.parameters, Types.Vector4);
    state._emitUniformFromString(this.environmentMatrix, Types.Matrix);
    state._emitUniformFromString(this.environmentForm, Types.Vector4);
    state._emitUniformFromString(this.environmentBoxPosition, Types.Vector4);
    state._emitUniformFromString(this.environmentBoxSize, Types.Vector3);
    state._emitUniformFromString(this.eye, Types.Vector4);
    state._emitUniformFromString(this.normal, Types.Vector3);
    state._emitUniformFromString(this.backdrop, Types.Vector3);
    if (this.builtIn) {
      this.tint = state._getFreeVariableName("slateMirrorTint");
      state._emitUniformFromString(this.tint, Types.Vector3);
    }
    state._emitFunctionFromInclude("helperFunctions", "Mirror reflection decoding");
    if (!wgsl) state._emitExtension("shaderTextureLod", "#extension GL_EXT_shader_texture_lod : enable");
    const uniform = wgsl ? "uniforms." : "";
    const vec2 = wgsl ? "vec2f" : "vec2", vec3 = wgsl ? "vec3f" : "vec3", vec4 = wgsl ? "vec4f" : "vec4";
    const toLinear = wgsl ? "toLinearSpaceVec3" : "toLinearSpace", toGamma = wgsl ? "toGammaSpaceVec3" : "toGammaSpace";
    const clip = state._getFreeVariableName("slateMirrorClip");
    const uv = state._getFreeVariableName("slateMirrorUv");
    const sampled = state._getFreeVariableName("slateMirrorSample");
    const output = this.color.associatedVariableName;
    const position = `${this.worldPosition.associatedVariableName}.xyz`;
    const parameters = `${uniform}${this.parameters}`;
    const offset = this.offset.isConnected ? this.offset.associatedVariableName : `${vec2}(0.0)`;
    let code = `${state._declareOutput(this.color)} = ${vec3}(0.0);\n#ifdef ${this.define}\n`;
    code += `${state._declareLocalVar(clip, Types.Vector4)} = ${uniform}${this.matrix} * ${vec4}(${position}, 1.0);\n`;
    code += `${state._declareLocalVar(uv, Types.Vector2)} = ${vec2}(0.5) + ${vec2}(0.5) * ${clip}.xy / max(${clip}.w, 1e-6) + ${offset};\n`;
    code += `${state._declareLocalVar(sampled, Types.Vector4)} = ${state._generateTextureSample(uv, this.sampler)};\n`;
    code += `#ifdef ${this.environmentDefine}\n`;
    // The environment along the view ray mirrored across the surface, in linear colour.
    const ray = state._getFreeVariableName("slateMirrorRay");
    const environment = state._getFreeVariableName("slateMirrorEnvironment");
    const farthest = state._getFreeVariableName("slateMirrorFarthest");
    const radiance = state._getFreeVariableName("slateMirrorRadiance");
    const form = `${uniform}${this.environmentForm}`, box = `${uniform}${this.environmentBoxPosition}`, half = `(${uniform}${this.environmentBoxSize} * 0.5)`;
    const lookup = wgsl
      ? `textureSampleLevel(${this.environmentSampler}, ${this.environmentSampler}Sampler, ${ray}, ${box}.w)`
      : `textureCubeLodEXT(${this.environmentSampler}, ${ray}, ${box}.w)`;
    code += `${state._declareLocalVar(ray, Types.Vector3)} = reflect(normalize(${position} - ${uniform}${this.eye}.xyz), ${uniform}${this.normal});\n`;
    code += `${state._declareLocalVar(environment, Types.Vector3)} = ${toLinear}(${uniform}${this.backdrop});\n`;
    code += `if (${uniform}${this.eye}.w > 0.5) {\n`;
    // Onto a Reflection Probe's box, as the light block projects its reflections.
    code += `if (${form}.x > 0.5) {\n`;
    code += `${state._declareLocalVar(farthest, Types.Vector3)} = max((${box}.xyz + ${half} - ${position}) / ${ray}, (${box}.xyz - ${half} - ${position}) / ${ray});\n`;
    code += `${ray} = ${position} + ${ray} * min(min(${farthest}.x, ${farthest}.y), ${farthest}.z) - ${box}.xyz;\n}\n`;
    code += `${ray} = (${uniform}${this.environmentMatrix} * ${vec4}(${ray}, 0.0)).xyz * ${vec3}(1.0, ${form}.y, ${form}.z);\n`;
    code += `${state._declareLocalVar(radiance, Types.Vector4)} = ${lookup};\n`;
    code += `${environment} = ${radiance}.rgb;\n`;
    code += `if (${form}.w > 1.5) { ${environment} = fromRGBD(${radiance}); } else if (${form}.w > 0.5) { ${environment} = ${toLinear}(${environment}); }\n}\n`;
    if (this.builtIn) {
      // In the reflection's own colour space: a display-encoded one holds what a draw clamps and encodes.
      const open = state._getFreeVariableName("slateMirrorOpen");
      code += `if (${parameters}.y > 0.5) { ${environment} = ${toGamma}(clamp(${environment}, ${vec3}(0.0), ${vec3}(1.0))); }\n`;
      code += `${state._declareLocalVar(open, Types.Float)} = mix(1.0, ${sampled}.a, ${parameters}.x);\n`;
      code += `${output} = (${sampled}.rgb * ${parameters}.x + ${environment} * ${open}) * ${uniform}${this.tint};\n`;
    } else {
      // Linear, as graph colours are: the drawn part is decoded as its own colour, not as its coverage-weighted one.
      const cover = state._getFreeVariableName("slateMirrorCover");
      code += `${state._declareLocalVar(cover, Types.Float)} = (1.0 - ${sampled}.a) * ${parameters}.x;\n`;
      code += `${output} = ${sampled}.rgb / max(${cover}, 1e-4);\n`;
      code += `if (${parameters}.y > 0.5) { ${output} = ${toLinear}(${output}); ${environment} = min(${environment}, ${vec3}(1.0)); }\n`;
      code += `${output} = ${output} * ${cover} + ${environment} * (1.0 - ${cover});\n`;
    }
    code += "#else\n";
    if (this.builtIn) {
      code += `${output} = ${sampled}.rgb * ${uniform}${this.tint} * ${parameters}.x;\n`;
    } else {
      code += `${output} = ${sampled}.rgb;\n`;
      code += `if (${parameters}.y > 0.5) { ${output} = ${toLinear}(${output}); }\n`;
      code += `${output} = ${output} * ${parameters}.x;\n`;
    }
    code += "#endif\n#endif\n";
    state.compilationString += code;
    return this;
  }
}
RegisterClass("BABYLON.MirrorReflectionBlock", MirrorReflectionBlock);
