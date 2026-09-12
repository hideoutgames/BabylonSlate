import {
  LightBlock, NodeMaterialBlockTargets, NodeMaterialBlockConnectionPointTypes,
  type Effect, type Mesh, type NodeMaterial, type NodeMaterialDefines,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { bindCelSettings, celFunctions, celLightingFunctions, CEL_UNIFORMS } from "./cel-shader";

/** Native CEL light evaluation inside authored surface graphs. */
export class CelLightBlock extends LightBlock {
  override getClassName(): string { return "CelLightBlock"; }

  override prepareDefines(defines: NodeMaterialDefines, material: NodeMaterial, mesh?: Mesh): void {
    super.prepareDefines(defines, material, mesh);
    defines.setValue("SLATE_CEL_TWO_SIDED", !material.backFaceCulling, true);
  }

  override bind(effect: Effect, material: NodeMaterial, mesh?: Mesh): void {
    super.bind(effect, material, mesh);
    bindCelSettings(effect, material.getScene());
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    if (state.target === NodeMaterialBlockTargets.Fragment) {
      for (const uniform of CEL_UNIFORMS) state._emitUniformFromString(uniform, NodeMaterialBlockConnectionPointTypes.Vector4);
      state._emitFunction("slateCelFunctions", celFunctions(state.shaderLanguage === 1), "CEL Lighting");
    }
    const start = state.compilationString.length;
    super._buildBlock(state);
    if (state.target === NodeMaterialBlockTargets.Fragment) {
      const key = Object.keys(state.functions).find((name) => name.startsWith("lightsFragmentFunctions"));
      if (key) state.functions[key] = celLightingFunctions(state.functions[key]!, state.shaderLanguage === 1);
      const generated = state.compilationString.slice(start)
        .replaceAll("#include<lightFragment>", "#include<slateCelLightFragment>")
        .replace(" = diffuseBase", " = slateCelSurfaceLight(diffuseBase)")
        .replace(` = ${this.worldNormal.associatedVariableName}.xyz;`, ` = normalize(${this.worldNormal.associatedVariableName}.xyz);\n#ifdef SLATE_CEL_TWO_SIDED\n${state.shaderLanguage === 1 ? "normalW = select(-normalW, normalW, fragmentInputs.frontFacing);" : "normalW = gl_FrontFacing ? normalW : -normalW;"}\n#endif\n`)
        .replace("aggShadow / numLights", "aggShadow / max(1.0, numLights)");
      state.compilationString = state.compilationString.slice(0, start) + generated;
    }
    return this;
  }
}
RegisterClass("BABYLON.CelLightBlock", CelLightBlock);
