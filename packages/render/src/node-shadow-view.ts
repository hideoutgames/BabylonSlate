import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { NodeMaterialBlockTargets } from "@babylonjs/core";
import { checkedShader } from "./checked-shader";

/** Babylon 9.20's WGSL shadow include expects a native uniform, not a graph's View input. */
export function bindNodeShadowView(
  state: NodeMaterialBuildState,
  start: number,
  view: string,
): void {
  if (state.shaderLanguage !== 1 || state.target !== NodeMaterialBlockTargets.Vertex) return;
  // Restrict substitution to this owned block's include. Native PBR/Standard
  // shaders correctly use scene.view and must keep the shared include unchanged.
  const generated = checkedShader(state.compilationString.slice(start), "graph WGSL shadow View")
    .replace("#include<shadowsVertex>[0..maxSimultaneousLights]",
      `#include<shadowsVertex>(uniforms\\.view,${view})[0..maxSimultaneousLights]`).value;
  state.compilationString = state.compilationString.slice(0, start) + generated;
}
