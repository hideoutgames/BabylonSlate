import {
  NodeMaterialBlockTargets,
  PBRMetallicRoughnessBlock,
  type AbstractMesh,
  type Effect,
  type Mesh,
  type NodeMaterial,
  type NodeMaterialDefines,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { PrepareDefinesForLights, PrepareDefinesForMultiview } from "@babylonjs/core/Materials/materialHelper.functions";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { HAPTIC_LIGHTS_GLSL, bindHapticLights, hapticLightLoopGlsl, hapticLightingActive } from "./haptic-lights";
import { bindNodeShadowView } from "./node-shadow-view";
import { syncSceneLightSamplers } from "./scene-light-samplers";

/** App-owned PBR graph lighting; keep the native block's discovery/type contract. */
export class ScenePbrLightingBlock extends PBRMetallicRoughnessBlock {
  override getClassName(): string {
    return "ScenePbrLightingBlock";
  }

  override prepareDefines(defines: NodeMaterialDefines, nodeMaterial: NodeMaterial, mesh?: AbstractMesh): void {
    // The Phase 4 spike's light loops (`haptic-lights.ts`) replace Babylon's per-light shader copies, so no light
    // change alters the defines: Babylon's light preparation is skipped, and its own reset clears what it set before.
    const scene = mesh?.getScene();
    const haptic = !!scene && hapticLightingActive(scene);
    const lightsDirty = defines._areLightsDirty;
    if (haptic) defines._areLightsDirty = false;
    super.prepareDefines(defines, nodeMaterial, mesh);
    defines._areLightsDirty = lightsDirty;
    if (!mesh || !scene) return;
    defines.setValue("HAPTIC_LIGHTS", haptic, true);
    if (!haptic) return;
    if (lightsDirty) {
      PrepareDefinesForLights(scene, mesh, defines, true, 0, true);
      PrepareDefinesForMultiview(scene, defines);
      defines._needNormals = true;
    }
    defines.setValue("SPECULARTERM", true, true);
  }

  // Where Babylon binds its own light buffers.
  override bind(effect: Effect, nodeMaterial: NodeMaterial, mesh?: Mesh): void {
    super.bind(effect, nodeMaterial, mesh);
    if (mesh) bindHapticLights(mesh.getScene(), effect);
  }

  override updateUniformsAndSamples(state: NodeMaterialBuildState, material: NodeMaterial, defines: NodeMaterialDefines, uniformBuffers: string[]): void {
    super.updateUniformsAndSamples(state, material, defines, uniformBuffers);
    syncSceneLightSamplers(state, material, defines);
    if (defines.HAPTIC_LIGHTS) uniformBuffers.push("HapticLights");
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    const start = state.compilationString.length;
    super._buildBlock(state);
    bindNodeShadowView(state, start, this.view.associatedVariableName);
    if (state.target === NodeMaterialBlockTargets.Fragment && state.shaderLanguage === ShaderLanguage.GLSL) {
      // After Babylon's own per-light copies (none in this mode), with the world position it substitutes for vPositionW.
      const code = state.compilationString;
      const lights = /#include<lightFragment>\(vPositionW,([^,)]+)\.xyz[^\n]*\n/g;
      lights.lastIndex = start;
      const include = lights.exec(code);
      if (!include) throw new Error("ScenePbrLightingBlock: Babylon's PBR block no longer includes lightFragment as expected.");
      state._emitFunction("hapticLights", HAPTIC_LIGHTS_GLSL, "");
      const end = include.index + include[0].length;
      state.compilationString = code.slice(0, end) + hapticLightLoopGlsl(include[1]!) + code.slice(end);
    }
    return this;
  }
}
RegisterClass("BABYLON.ScenePbrLightingBlock", ScenePbrLightingBlock);
