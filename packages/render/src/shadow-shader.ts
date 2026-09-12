import { ShaderStore } from "@babylonjs/core";
import { lightFragment } from "@babylonjs/core/Shaders/ShadersInclude/lightFragment";
import { lightFragmentWGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/lightFragment";
import { checkedShader } from "./checked-shader";

export function withShadowDistanceFade(source: string, wgsl: boolean): string {
  const depth = `${wgsl ? "fragmentInputs." : ""}vPositionFromCamera{X}.z`;
  const end = `${wgsl ? "uniforms." : ""}viewFrustumZ{X}[SHADOWCSMNUM_CASCADES{X}-1]`;
  return checkedShader(
    source,
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
