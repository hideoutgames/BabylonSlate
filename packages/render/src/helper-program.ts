import { MaterialPluginBase, type MaterialDefines, type StandardMaterial } from "@babylonjs/core";

const PLUGIN_NAME = "SlateHelperProgram";

/**
 * Keeps two defines of Babylon's `default` program out of an owned unlit helper's cache key.
 * Babylon keys an Effect by its defines, and links a program per key even when two keys expand
 * to the same source. `NONUNIFORMSCALING` follows each mesh's world matrix and
 * `ALPHATEST_AFTERALLALPHACOMPUTATIONS` follows whether the material set a transparency mode,
 * so helpers that draw one program (collider dashes, volume fills, nav mesh fill, billboards)
 * linked it once per combination, in every render pass that draws them.
 *
 * Both are pinned only while the program cannot read them: `default.vertex` uses the first inside
 * `NORMAL`, and the fragment alpha code the second inside `ALPHATEST`. `NORMAL` is set when lights
 * need normals, which `disableLighting` helpers never ask for. A helper that does read either
 * keeps the live value. Re-read both shaders (GLSL and WGSL) when moving the Babylon pin.
 */
export class HelperProgramPlugin extends MaterialPluginBase {
  constructor(material: StandardMaterial) {
    super(material, PLUGIN_NAME, 230, {}, true, false);
    this._enable(true);
  }
  override isCompatible(): boolean {
    return true;
  }
  override prepareDefines(defines: MaterialDefines): void {
    if (!defines.NORMAL) defines.NONUNIFORMSCALING = false;
    if (!defines.ALPHATEST) defines.ALPHATEST_AFTERALLALPHACOMPUTATIONS = false;
  }
}

/** Let this owned unlit helper material share one program across meshes and transparency modes. */
export function shareHelperProgram(material: StandardMaterial): StandardMaterial {
  if (!material.pluginManager?.getPlugin(PLUGIN_NAME)) new HelperProgramPlugin(material);
  return material;
}
