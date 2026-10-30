import {
  Color3, NodeMaterialBlock, NodeMaterialBlockTargets, NodeMaterialBlockConnectionPointTypes as Types, ShaderLanguage,
  type AbstractMesh, type Effect, type NodeMaterial, type NodeMaterialDefines, type Scene,
} from "@babylonjs/core";
import { GetFogState } from "@babylonjs/core/Materials/materialHelper.functions";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import "@babylonjs/core/Shaders/ShadersInclude/fogFragmentDeclaration";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/fogFragmentDeclaration";
import "@babylonjs/core/Shaders/ShadersInclude/helperFunctions";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/helperFunctions";

/** The scene's fog (mode, start, end, density), for Babylon's fog factor (`emitSceneFogFactor`). */
export const SCENE_FOG_UNIFORM = "sceneFogInfo";
/** The scene's fog colour, linear, as surfaces mix toward it. */
export const SCENE_FOG_COLOR_UNIFORM = "sceneFogColor";
const linearFog = new Color3();

/** Binds `SCENE_FOG_UNIFORM`. Allocation-free. */
export function bindSceneFog(effect: Effect, scene: Scene): void {
  effect.setFloat4(SCENE_FOG_UNIFORM, scene.fogMode, scene.fogStart, scene.fogEnd, scene.fogDensity);
}

/** Binds `SCENE_FOG_COLOR_UNIFORM`: the scene's fog colour, linear as the shader's `toLinearSpace` makes it. Allocation-free. */
export function bindSceneFogColor(effect: Effect, scene: Scene): void {
  scene.fogColor.toLinearSpaceToRef(linearFog, scene.getEngine().useExactSrgbConversions);
  effect.setFloat4(SCENE_FOG_COLOR_UNIFORM, linearFog.r, linearFog.g, linearFog.b, 0);
}

/**
 * Declares how much of a surface the scene's fog keeps, one rule for every surface: Babylon PBR's, the fog factor in
 * linear space, `toLinearSpace(CalcFogFactor(view-space position, SCENE_FOG_UNIFORM))` (`sceneFogKeep`), from the
 * include Babylon's fog uses (emitted once per program). GLSL `vec3`/WGSL `vec3f` `viewPosition`; meaningful under `FOG`.
 */
export function emitSceneFogFactor(state: NodeMaterialBuildState): void {
  const wgsl = state.shaderLanguage === ShaderLanguage.WGSL;
  state._emitUniformFromString(SCENE_FOG_UNIFORM, Types.Vector4);
  state._emitFunctionFromInclude("helperFunctions", "");
  state._emitFunctionFromInclude("fogFragmentDeclaration", "", {
    removeUniforms: true, removeVaryings: true, removeIfDef: false,
    replaceStrings: wgsl ? [
      { search: /fn CalcFogFactor\(\)/, replace: "fn CalcFogFactor(vFogDistance: vec3f, vFogInfos: vec4f)" },
      { search: /uniforms.vFogInfos/g, replace: "vFogInfos" },
      { search: /fragmentInputs.vFogDistance/g, replace: "vFogDistance" },
    ] : [{ search: /float CalcFogFactor\(\)/, replace: "float CalcFogFactor(vec3 vFogDistance, vec4 vFogInfos)" }],
  });
  state._emitFunction("sceneFogKeep", `#ifdef FOG\n${wgsl
    ? `fn sceneFogKeep(viewPosition: vec3f) -> f32 { return toLinearSpace(CalcFogFactor(viewPosition, uniforms.${SCENE_FOG_UNIFORM})); }`
    : `float sceneFogKeep(vec3 viewPosition) { return toLinearSpace(CalcFogFactor(viewPosition, ${SCENE_FOG_UNIFORM})); }`}\n#endif\n`, "");
}

/**
 * Scene Fog: the scene's fog over a surface's linear colour, by the one rule every surface fogs by (`sceneFogKeep`,
 * Babylon PBR's linear-space fog factor) toward the scene's linear fog colour. The compiler adds it to every Surface
 * Material; the water nodes that undo or read the fog use the same factor.
 */
export class SceneFogBlock extends NodeMaterialBlock {
  /** The input and output are display-space (the legacy CEL surface's): fogged in linear by the same rule between. */
  displaySpace = false;
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Fragment);
    this.registerInput("input", Types.Color3);
    this.registerInput("worldPosition", Types.Vector4);
    this.registerInput("view", Types.Matrix);
    /** Optional: the view-space position transformed per vertex, as Standard's `vFogDistance` is; used in place of view × world position. */
    this.registerInput("viewPosition", Types.Vector4, true);
    this.registerOutput("output", Types.Color3);
  }
  get input() { return this._inputs[0]!; }
  get worldPosition() { return this._inputs[1]!; }
  get view() { return this._inputs[2]!; }
  get viewPosition() { return this._inputs[3]!; }
  get output() { return this._outputs[0]!; }
  override getClassName(): string { return "SceneFogBlock"; }
  override prepareDefines(defines: NodeMaterialDefines, material: NodeMaterial, mesh?: AbstractMesh): void {
    if (!mesh) return;
    // As Babylon's Fog block sets it: other blocks' fog terms read it too.
    defines.setValue("FOG", material.fogEnabled && GetFogState(mesh, mesh.getScene()));
  }
  override bind(effect: Effect, _material: NodeMaterial, mesh?: AbstractMesh): void {
    if (!mesh) return;
    const scene = mesh.getScene();
    bindSceneFog(effect, scene);
    bindSceneFogColor(effect, scene);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state.sharedData.blocksWithDefines.push(this);
    state.sharedData.bindableBlocks.push(this);
    const wgsl = state.shaderLanguage === ShaderLanguage.WGSL;
    emitSceneFogFactor(state);
    state._emitUniformFromString(SCENE_FOG_COLOR_UNIFORM, Types.Vector4);
    const output = this.output.associatedVariableName, input = this.input.associatedVariableName;
    const keep = state._getFreeVariableName("fogKeep");
    const linear = this.displaySpace ? `${wgsl ? "toLinearSpaceVec3" : "toLinearSpace"}(${input}.rgb)` : `${input}.rgb`;
    const fogged = `${keep} * ${linear} + (1.0 - ${keep}) * ${wgsl ? "uniforms." : ""}${SCENE_FOG_COLOR_UNIFORM}.rgb`;
    state.compilationString += `${state._declareOutput(this.output)} = ${input}.rgb;\n#ifdef FOG\n`
      + `${state._declareLocalVar(keep, Types.Float)} = sceneFogKeep(${this.viewPosition.isConnected ? this.viewPosition.associatedVariableName
        : `(${this.view.associatedVariableName} * vec4${wgsl ? "f" : ""}(${this.worldPosition.associatedVariableName}.xyz, 1.0))`}.xyz);\n`
      + `${output} = ${this.displaySpace ? `${wgsl ? "toGammaSpaceVec3" : "toGammaSpace"}(${fogged})` : fogged};\n#endif\n`;
    return this;
  }
}
RegisterClass("BABYLON.SceneFogBlock", SceneFogBlock);
