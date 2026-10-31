/**
 * Test-build-only: the two Standard-material changes the engine made before the unlit Material replaced its last
 * Standard surface, kept so the unlit parity proof (`unlit-parity-proof.ts`) draws its Standard references as the
 * engine drew them. The engine itself creates no Standard material.
 */
import { MaterialPluginBase, ShaderLanguage, ShaderStore, type Material } from "@babylonjs/core";
import { defaultPixelShader } from "@babylonjs/core/Shaders/default.fragment";
import { defaultPixelShaderWGSL } from "@babylonjs/core/ShadersWGSL/default.fragment";
import { checkedShader } from "../../../../packages/render/src/checked-shader";

const PLUGIN_NAME = "HapticStandardFog";

/**
 * Babylon's fog mix in `fogFragment` as a Standard material expands it (display-space colour, display fog colour, raw
 * factor), and the one rule every surface fogs by in its place: Babylon PBR's, the factor in linear space toward the
 * linear fog colour (`sceneFogKeep`), mixed in linear and returned display-space as Standard's colour is.
 */
const FOG_MIX = {
  glsl: {
    pattern: String.raw`color\.rgb=mix\(vFogColor,color\.rgb,fog\);`,
    rule: "color.rgb=toGammaSpace(mix(toLinearSpace(vFogColor),toLinearSpace(color.rgb),toLinearSpace(fog)));",
  },
  wgsl: {
    pattern: String.raw`color= vec4f\(mix\(uniforms\.vFogColor,color\.rgb,fog\),color\.a\);`,
    rule: "color=vec4f(toGammaSpaceVec3(mix(toLinearSpaceVec3(uniforms.vFogColor),toLinearSpaceVec3(color.rgb),toLinearSpace(fog))),color.a);",
  },
} as const;

/**
 * Fogs a Standard material by the one rule every surface fogs by, so 3D Text and sprites fade as graph Materials and
 * water do at the same distance. Code only: no uniforms or defines, and nothing where the material draws without fog.
 */
export class StandardFogPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, PLUGIN_NAME, 220, {}, true, false);
    this._enable(true);
  }
  override isCompatible(): boolean {
    return true;
  }
  override getCustomCode(type: string, language?: ShaderLanguage) {
    if (type !== "fragment") return null;
    const mix = FOG_MIX[language === ShaderLanguage.WGSL ? "wgsl" : "glsl"];
    return { [`!${mix.pattern}`]: mix.rule };
  }
}

/**
 * The Standard shader's geometry-pass reflectivity write in Babylon 9.29 (`default.fragment`, GLSL and WGSL): the
 * specular map or specular color, as the F0 that Real-Time Reflections read. Group 1 is that native body.
 */
const STANDARD_REFLECTIVITY_WRITE =
  /#ifdef PREPASS_REFLECTIVITY\n(#if defined\(SPECULAR\)\n[^\n]*\n#else\n[^\n]*\n#endif)\n/;

/** A statement writing `value` (a vec4) to the reflectivity attachment. */
function reflectivityWrite(wgsl: boolean, value: string): string {
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
