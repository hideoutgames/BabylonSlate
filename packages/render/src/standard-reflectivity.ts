import { ShaderStore } from "@babylonjs/core";
import { defaultPixelShader } from "@babylonjs/core/Shaders/default.fragment";
import { defaultPixelShaderWGSL } from "@babylonjs/core/ShadersWGSL/default.fragment";
import { checkedShader } from "./checked-shader";

/**
 * The Standard shader's geometry-pass reflectivity write in Babylon 9.29 (`default.fragment`, GLSL and WGSL): the
 * specular map or specular color, as the F0 that Real-Time Reflections read. Group 1 is that native body.
 */
export const STANDARD_REFLECTIVITY_WRITE =
  /#ifdef PREPASS_REFLECTIVITY\n(#if defined\(SPECULAR\)\n[^\n]*\n#else\n[^\n]*\n#endif)\n/;

/** A statement writing `value` (a vec4) to the reflectivity attachment. */
export function reflectivityWrite(wgsl: boolean, value: string): string {
  return wgsl
    ? `fragData[PREPASS_REFLECTIVITY_INDEX]=${value};`
    : `WRITE_GEOMETRY_FRAGMENT_OUTPUT(PREPASS_REFLECTIVITY_INDEX,${value});`;
}

/**
 * Babylon writes a Standard surface's specular color whether or not the surface is lit, and a Standard Material's
 * specular color is white by default, so unlit sprites, texture quads and tilemap placeholders reflected as
 * mirrors. A Standard surface now reflects only with a specular light term (`SPECULARTERM`, which disabled lighting
 * never sets); otherwise it writes no reflectivity, as Babylon's unlit PBR does. Every other variant compiles the same
 * code: the change sits inside `PREPASS_REFLECTIVITY`, which only a reflectivity geometry pass defines.
 *
 * Installed when this module loads, before any Engine exists: Babylon's own lazy shader import only fills an empty
 * store entry, so it keeps this one.
 */
for (const wgsl of [false, true]) {
  const native = wgsl ? defaultPixelShaderWGSL : defaultPixelShader;
  ShaderStore.GetShadersStore(wgsl ? 1 : 0)[native.name] = checkedShader(
    native.shader,
    wgsl ? "Standard reflectivity WGSL" : "Standard reflectivity GLSL",
  ).replace(
    STANDARD_REFLECTIVITY_WRITE,
    (_match, body: string) =>
      `#ifdef PREPASS_REFLECTIVITY\n#ifdef SPECULARTERM\n${body}\n#else\n${reflectivityWrite(wgsl, `${wgsl ? "vec4f" : "vec4"}(0.0,0.0,0.0,1.0)*writeGeometryInfo`)}\n#endif\n`,
  ).value;
}
