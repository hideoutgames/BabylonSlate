import {
  PBRMetallicRoughnessBlock,
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
import { syncSceneLightSamplers } from "./scene-light-samplers";
import {
  BAKED_IRRADIANCE_INV_PI_GLSL,
  bakedIrradianceTexelSample,
  type BakedIrradianceSampling,
} from "./baked-irradiance";

/** App-owned PBR graph lighting; keep the native block's discovery/type contract. */
export class ScenePbrLightingBlock extends PBRMetallicRoughnessBlock {
  /**
   * Per-receiver baked atlas sampling for one cloned graph. The clone's
   * `SLATE_BAKED` sample joins `diffuseBase` at PBR's normalized `E / PI`
   * convention; the authored material and every other receiver keep the
   * realtime-only path.
   */
  bakedIrradiance: BakedIrradianceSampling | null = null;

  override getClassName(): string {
    return "ScenePbrLightingBlock";
  }

  override prepareDefines(
    defines: NodeMaterialDefines,
    material: NodeMaterial,
    mesh?: Mesh,
  ): void {
    super.prepareDefines(defines, material, mesh);
    defines.setValue("SLATE_BAKED", !!this.bakedIrradiance, true);
    defines.setValue(
      "SLATE_BAKED_ENV",
      !!this.bakedIrradiance?.includesEnvironment,
      true,
    );
  }

  override bind(effect: Effect, material: NodeMaterial, mesh?: Mesh): void {
    super.bind(effect, material, mesh);
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

  override updateUniformsAndSamples(state: NodeMaterialBuildState, material: NodeMaterial, defines: NodeMaterialDefines, uniformBuffers: string[]): void {
    super.updateUniformsAndSamples(state, material, defines, uniformBuffers);
    syncSceneLightSamplers(state, material, defines);
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    const start = state.compilationString.length;
    super._buildBlock(state);
    bindNodeShadowView(state, start, this.view.associatedVariableName);
    if (!this.bakedIrradiance) return this;
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
      return this;
    }
    if (state.target !== NodeMaterialBlockTargets.Fragment) return this;
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
    // The texel sample lands inline so WGSL can read `fragmentInputs` and the
    // `uniforms` block — a top-level fn could not see either. `finalDiffuse`
    // is declared unconditionally by pbrBlockFinalUnlitComponents; joining
    // `diffuseBase` ahead of it flows the baked term through the graph's own
    // albedo multiply, matching the PBR material plugin's `E * coverage / PI`
    // convention. `finalIrradiance` exists only inside `#ifdef REFLECTION`;
    // zeroing the environment irradiance there mirrors the plugin's
    // environmentIntensity reset while keeping specular radiance.
    const diffuse = wgsl
      ? "var finalDiffuse: vec3f=diffuseBase;"
      : "vec3 finalDiffuse=diffuseBase;";
    const irradiance = wgsl
      ? "var finalIrradiance: vec3f=reflectionOut.environmentIrradiance;"
      : "vec3 finalIrradiance=reflectionOut.environmentIrradiance;";
    const texel = wgsl
      ? `var slateBakedTexel: vec4f=${bakedIrradianceTexelSample(true)};`
      : `vec4 slateBakedTexel=${bakedIrradianceTexelSample(false)};`;
    const generated = checkedShader(
      state.compilationString.slice(start),
      "graph baked irradiance",
    )
      .replace(
        diffuse,
        `#if defined(SLATE_BAKED) && !defined(UNLIT)\n${texel}\ndiffuseBase+=slateBakedTexel.rgb*slateBakedTexel.a*${BAKED_IRRADIANCE_INV_PI_GLSL};\n#endif\n${diffuse}`,
      )
      .replace(
        irradiance,
        `#ifdef SLATE_BAKED_ENV\nreflectionOut.environmentIrradiance=${wgsl ? "vec3f" : "vec3"}(0.);\n#endif\n${irradiance}`,
      ).value;
    state.compilationString =
      state.compilationString.slice(0, start) + generated;
    return this;
  }
}
RegisterClass("BABYLON.ScenePbrLightingBlock", ScenePbrLightingBlock);
