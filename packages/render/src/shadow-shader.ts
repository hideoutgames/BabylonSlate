import { ShaderStore } from "@babylonjs/core";
import { lightFragment } from "@babylonjs/core/Shaders/ShadersInclude/lightFragment";
import { lightFragmentWGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/lightFragment";
import { checkedShader } from "./checked-shader";
import { withDirectionalPcfReceiverBias } from "./shadow-receiver";

export function withShadowDistanceFade(source: string, wgsl: boolean): string {
  // Pinned 9.20 WGSL omits the array texture in the Low CSM blend call.
  // The browser split-crossing regression executes this otherwise invalid path.
  if (wgsl)
    source = checkedShader(source, "WGSL Low CSM blend texture").replace(
      "vDepthMetric{X}[index{X}],,shadowTexture{X}Sampler",
      "vDepthMetric{X}[index{X}],shadowTexture{X},shadowTexture{X}Sampler",
    ).value;
  const depth = `${wgsl ? "fragmentInputs." : ""}vPositionFromCamera{X}.z`;
  const end = `${wgsl ? "uniforms." : ""}viewFrustumZ{X}[SHADOWCSMNUM_CASCADES{X}-1]`;
  return checkedShader(
    withDirectionalPcfReceiverBias(source, wgsl),
    wgsl ? "shadow distance WGSL" : "shadow distance GLSL",
  ).replace(
    "aggShadow+=shadow;numLights+=1.0;",
    `#if defined(SHADOWCSM{X}) && defined(SLATE_SHADOW_FADE{X})
if (SLATE_SHADOW_FADE{X}>0.0) {
shadow=mix(shadow,1.0,smoothstep(${end}*(1.0-SLATE_SHADOW_FADE{X}),${end},abs(${depth})));
}
#endif
aggShadow+=shadow;numLights+=1.0;`,
  ).value;
}

for (const wgsl of [false, true]) {
  ShaderStore.GetIncludesShadersStore(wgsl ? 1 : 0).lightFragment =
    withShadowDistanceFade(
      (wgsl ? lightFragmentWGSL : lightFragment).shader,
      wgsl,
    );
}
