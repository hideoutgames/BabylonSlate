import {
  LightBlock,
  NodeMaterialBlockTargets,
  NodeMaterialBlockConnectionPointTypes,
  type Effect,
  type Mesh,
  type NodeMaterial,
  type NodeMaterialDefines,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { checkedShader } from "./checked-shader";
import { bindNodeShadowView } from "./node-shadow-view";
import {
  bindCelSettings,
  celFunctions,
  celLightAccumulators,
  celLightingFunctions,
  celEnvironmentAccumulation,
  CEL_UNIFORMS,
} from "./cel-shader";
import type { BakedIrradianceSampling } from "./baked-irradiance";

/** Native CEL light evaluation inside authored surface graphs. */
export class CelLightBlock extends LightBlock {
  /**
   * Per-receiver baked atlas sampling for one cloned graph. The clone's
   * `SLATE_BAKED` sample joins the environment accumulation; the authored
   * material and every other receiver keep the realtime-only path.
   */
  bakedIrradiance: BakedIrradianceSampling | null = null;

  constructor(name: string) {
    super(name);
    this.registerInput("environmentInfluence", NodeMaterialBlockConnectionPointTypes.Float, true, NodeMaterialBlockTargets.Fragment);
  }

  get environmentInfluence() {
    return this.getInputByName("environmentInfluence")!;
  }

  override getClassName(): string {
    return "CelLightBlock";
  }

  override prepareDefines(
    defines: NodeMaterialDefines,
    material: NodeMaterial,
    mesh?: Mesh,
  ): void {
    super.prepareDefines(defines, material, mesh);
    defines.setValue("SLATE_CEL_TWO_SIDED", !material.backFaceCulling, true);
    defines.setValue("SLATE_BAKED", !!this.bakedIrradiance, true);
    defines.setValue(
      "SLATE_BAKED_ENV",
      !!this.bakedIrradiance?.includesEnvironment,
      true,
    );
  }

  override bind(effect: Effect, material: NodeMaterial, mesh?: Mesh): void {
    super.bind(effect, material, mesh);
    bindCelSettings(effect, material.getScene());
    if (this.bakedIrradiance) {
      effect.setTexture("slateBakedIrradiance", this.bakedIrradiance.texture);
      effect.setFloat4(
        "slateBakedRect",
        this.bakedIrradiance.scale[0],
        this.bakedIrradiance.scale[1],
        this.bakedIrradiance.offset[0],
        this.bakedIrradiance.offset[1],
      );
    }
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    if (state.target === NodeMaterialBlockTargets.Fragment) {
      for (const uniform of CEL_UNIFORMS)
        state._emitUniformFromString(
          uniform,
          NodeMaterialBlockConnectionPointTypes.Vector4,
        );
      state._emitFunction(
        "slateCelFunctions",
        celFunctions(state.shaderLanguage === 1),
        "CEL Lighting",
      );
    }
    const start = state.compilationString.length;
    super._buildBlock(state);
    bindNodeShadowView(state, start, this.view.associatedVariableName);
    if (this.bakedIrradiance) {
      const wgsl = state.shaderLanguage === 1;
      if (state.target === NodeMaterialBlockTargets.Vertex) {
        state._emitVaryingFromString(
          "vSlateBakedUV",
          NodeMaterialBlockConnectionPointTypes.Vector2,
          "SLATE_BAKED",
        );
        if (!state.attributes.includes("uv2")) state.attributes.push("uv2");
        state.compilationString += wgsl
          ? "\nvertexOutputs.vSlateBakedUV=vertexInputs.uv2;"
          : "\nvSlateBakedUV=uv2;";
      } else if (state.target === NodeMaterialBlockTargets.Fragment) {
        state._emitVaryingFromString(
          "vSlateBakedUV",
          NodeMaterialBlockConnectionPointTypes.Vector2,
          "SLATE_BAKED",
        );
        state._emitUniformFromString(
          "slateBakedRect",
          NodeMaterialBlockConnectionPointTypes.Vector4,
          "SLATE_BAKED",
        );
        state._emit2DSampler("slateBakedIrradiance", "SLATE_BAKED");
      }
    }
    if (state.target === NodeMaterialBlockTargets.Fragment) {
      const key = Object.keys(state.functions).find((name) =>
        name.startsWith("lightsFragmentFunctions"),
      );
      if (key)
        state.functions[key] = celLightingFunctions(
          state.functions[key]!,
          state.shaderLanguage === 1,
        );
      const generated = checkedShader(state.compilationString.slice(start), state.shaderLanguage === 1 ? "graph WGSL" : "graph GLSL")
        .replace("aggShadow = aggShadow / numLights;", `${celEnvironmentAccumulation(state.shaderLanguage === 1, this.environmentInfluence.isConnected ? this.environmentInfluence.associatedVariableName : "1.0")}\naggShadow = aggShadow / numLights;`)
        .replaceAll(
          "#include<lightFragment>",
          "#include<slateCelLightFragment>",
          1,
        )
        .replace(
          /(vec3 diffuseBase|var diffuseBase: vec3f)/,
          `${celLightAccumulators(state.shaderLanguage === 1)}$1`,
        )
        .replace(
          " = diffuseBase",
          " = slateCelSurfaceLight(diffuseBase, slateCelPeak)",
        )
        .replace(
          " = specularBase",
          " = slateCelSurfaceSpecular(specularBase)",
          this.specularOutput.hasEndpoints ? 1 : 0,
        )
        .replace(
          ` = ${this.worldNormal.associatedVariableName}.xyz;`,
          ` = normalize(${this.worldNormal.associatedVariableName}.xyz);\n#ifdef SLATE_CEL_TWO_SIDED\n${state.shaderLanguage === 1 ? "normalW = select(-normalW, normalW, fragmentInputs.frontFacing);" : "normalW = gl_FrontFacing ? normalW : -normalW;"}\n#endif\n`,
        )
        .replace("aggShadow / numLights", "aggShadow / max(1.0, numLights)").value;
      state.compilationString =
        state.compilationString.slice(0, start) + generated;
    }
    return this;
  }
}
RegisterClass("BABYLON.CelLightBlock", CelLightBlock);
