import { ShaderStore } from "@babylonjs/core";
import { clusteredLightingComputeWGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/clusteredLightingCompute";
import { checkedShader } from "./checked-shader";

/** Continue CEL's sequential tie comparison across a conventional prefix. */
export function celClusteredLighting(source: string): string {
  const start = source.indexOf("lightingInfo computeClusteredLighting(");
  if (start < 0)
    throw new Error("Babylon clustered CEL lighting hook is missing.");
  const head = checkedShader(
    source.slice(0, start),
    "clustered CEL result",
  ).replace(
    "{vec3 diffuse;",
    "{vec3 diffuse;float slateCelPeak;float slateCelTotal;float slateCelWins;",
  ).value;
  const body = checkedShader(source.slice(start), "clustered CEL children")
    .replace("float glossiness", "float glossiness,float slateCelPreviousPeak")
    .replace(
      "lightingInfo result;ivec2 tilePosition",
      `lightingInfo result;
result.diffuse=vec3(0.0);
result.slateCelPeak=slateCelPreviousPeak;result.slateCelTotal=0.0;result.slateCelWins=0.0;
#ifdef SPECULARTERM
result.specular=vec3(0.0);
#endif
ivec2 tilePosition`,
    )
    .replace(
      "result.diffuse+=info.diffuse;",
      `float incoming=slateCelStrength(info.diffuse);
float wins=incoming>result.slateCelPeak+max(1.0,result.slateCelPeak)*0.00001 ? 1.0 : 0.0;
result.slateCelWins=max(result.slateCelWins,wins);
result.slateCelPeak=max(result.slateCelPeak,incoming);
result.slateCelTotal+=incoming;
result.diffuse=slateCelAccumulate(result.diffuse,info.diffuse,wins);`,
    )
    .replace(
      "result.specular+=info.specular;",
      "result.specular=slateCelAccumulate(result.specular,info.specular,wins);",
    ).value;
  return head + body;
}

/**
 * WGSL mirror of celClusteredLighting: the compute children move to a slate
 * include while the lightsFragmentFunctions source gets the same struct
 * fields and include substitution. Mirrors the GLSL patch 1:1.
 */
export function celClusteredLightingWGSL(source: string): string {
  return checkedShader(source, "clustered CEL WGSL")
    .replace(
      "{diffuse: vec3f,",
      "{diffuse: vec3f,slateCelPeak: f32,slateCelTotal: f32,slateCelWins: f32,",
      1,
    )
    .replace(
      "#include<clusteredLightingCompute>[0..maxSimultaneousLights]",
      "#include<slateCelClusteredLightingCompute>[0..maxSimultaneousLights]",
    ).value;
}

// The WebGPU mask lives in tileMaskBuffer{X}; the patched compute child keeps
// CEL's sequential tie comparison inside each clustered pass.
ShaderStore.GetIncludesShadersStore(1).slateCelClusteredLightingCompute =
  checkedShader(
    clusteredLightingComputeWGSL.shader,
    "clustered CEL WGSL compute",
  )
    .replace(
      "glossiness: f32\n)->lightingInfo",
      "glossiness: f32,slateCelPreviousPeak: f32\n)->lightingInfo",
    )
    .replace(
      "{var result: lightingInfo;let tilePosition",
      `{var result: lightingInfo;
result.diffuse=vec3f(0.0);
result.slateCelPeak=slateCelPreviousPeak;result.slateCelTotal=0.0;result.slateCelWins=0.0;
#ifdef SPECULARTERM
result.specular=vec3f(0.0);
#endif
let tilePosition`,
    )
    .replace(
      "result.diffuse+=info.diffuse;",
      `var incoming=slateCelStrength(info.diffuse);
var wins=0.0;
if incoming>result.slateCelPeak+max(1.0,result.slateCelPeak)*0.00001 { wins=1.0; }
result.slateCelWins=max(result.slateCelWins,wins);
result.slateCelPeak=max(result.slateCelPeak,incoming);
result.slateCelTotal+=incoming;
result.diffuse=slateCelAccumulate(result.diffuse,info.diffuse,wins);`,
    )
    .replace(
      "result.specular+=info.specular;",
      "result.specular=slateCelAccumulate(result.specular,info.specular,wins);",
    ).value;
