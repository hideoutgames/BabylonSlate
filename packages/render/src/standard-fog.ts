import { MaterialPluginBase, ShaderLanguage, StandardMaterial, type Material } from "@babylonjs/core";
import { registerPersistentMaterialPlugin } from "./material-plugin-registration";

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
registerPersistentMaterialPlugin(PLUGIN_NAME, (material) =>
  material instanceof StandardMaterial ? new StandardFogPlugin(material) : null,
);
