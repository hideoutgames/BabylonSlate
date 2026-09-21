import { PrepareUniformsAndSamplersForLight, type NodeMaterial, type NodeMaterialDefines } from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";

/** Babylon's graph build state survives light-type changes and multiple view passes. */
export function syncSceneLightSamplers(state: NodeMaterialBuildState, material: NodeMaterial, defines: NodeMaterialDefines): void {
  // LightBlock appends the LTC names on every define update. Repeated names
  // consume additional WebGL texture units, eventually exceeding the limit.
  const samplers = new Set(state.samplers);
  samplers.add("areaLightsLTC1Sampler");
  samplers.add("areaLightsLTC2Sampler");
  for (let index = 0; index < material.maxSimultaneousLights && defines[`LIGHT${index}`]; index++) {
    const dynamic: string[] = [];
    // The native block skips sampler discovery once vLightData exists. A point
    // slot can later become a textured area/clustered light without new uniforms.
    PrepareUniformsAndSamplersForLight(index, [], dynamic, defines[`PROJECTEDLIGHTTEXTURE${index}`], null, false, defines[`IESLIGHTTEXTURE${index}`], defines[`CLUSTLIGHT${index}`], defines[`RECTAREALIGHTEMISSIONTEXTURE${index}`], state.shaderLanguage === 1);
    for (const sampler of dynamic) samplers.add(sampler);
  }
  state.samplers = [...samplers];
}
