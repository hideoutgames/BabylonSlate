import { MaterialPluginBase, PBRBaseMaterial, RegisterMaterialPlugin, StandardMaterial, type AbstractMesh, type Material, type MaterialDefines, type Scene, type ShaderLanguage, type SubMesh, type UniformBuffer } from "@babylonjs/core";
import { defaultVertexShader } from "@babylonjs/core/Shaders/default.vertex";
import { pbrVertexShader } from "@babylonjs/core/Shaders/pbr.vertex";
import { defaultVertexShaderWGSL } from "@babylonjs/core/ShadersWGSL/default.vertex";
import { pbrVertexShaderWGSL } from "@babylonjs/core/ShadersWGSL/pbr.vertex";
import { bumpFragment } from "@babylonjs/core/Shaders/ShadersInclude/bumpFragment";
import { bumpFragmentWGSL } from "@babylonjs/core/ShadersWGSL/ShadersInclude/bumpFragment";
import { bindMeshLatticeDeformerBuffer, hasMeshLatticeDeformer } from "./lattice-deformer-binding";
import { checkedShader } from "./checked-shader";
import { LATTICE_WORLD_POSITION_PATTERN, latticeNormalShaderFunction, latticeShaderDeclarations, latticeShaderFunctions, latticeWorldPositionCode } from "./lattice-deformer-shader";

/** Registered before native material UBO layout freezes. Per-mesh defines keep
 * ordinary draws free of a vertex sampler, including shared/frozen materials. */
export class LatticeDeformerPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "SlateLattice", 220, { SLATE_LATTICE: false }, true, false);
    this.registerForExtraEvents = true;
    this._enable(true);
  }
  override isCompatible(): boolean { return true; }
  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    (defines as MaterialDefines & { SLATE_LATTICE: boolean }).SLATE_LATTICE = hasMeshLatticeDeformer(mesh);
  }
  override hardBindForSubMesh(buffer: UniformBuffer, _scene: Scene, _engine: unknown, subMesh: SubMesh): void {
    bindMeshLatticeDeformerBuffer(buffer, subMesh.getEffectiveMesh());
  }
  override getSamplers(samplers: string[]): void { samplers.push("latticeData"); }
  override getUniforms(language: ShaderLanguage = 0) {
    const uniforms = ["lattice_cellSize", "lattice_min", "lattice_max", "lattice_resolution", "lattice_position"].map((name) => ({ name, size: 3, type: "vec3" }));
    uniforms.push({ name: "slateWorldToLattice", size: 16, type: "mat4" }, { name: "slateLatticeToWorld", size: 16, type: "mat4" }, { name: "slateLatticeEnabled", size: 1, type: "float" });
    return { ubo: uniforms, vertex: language === 1 ? undefined : uniforms.map(({ name, type }) => `uniform ${type} ${name};`).join("\n") };
  }
  override getCustomCode(type: string, language: ShaderLanguage = 0): Record<string, string> | null {
    const wgsl = language === 1;
    const objectNormalVaryings = `#if defined(SLATE_LATTICE) && defined(OBJECTSPACE_NORMALMAP)\n${[0, 1, 2].map((i) => wgsl ? `varying vSlateLatticeJ${i}: vec3f;` : `varying vec3 vSlateLatticeJ${i};`).join("\n")}\n#endif\n`;
    if (type === "fragment") {
      const normalMap = "(normalW\\s*=\\s*normalize\\(mat3(?:x3f)?\\((?:uniforms\\.)?normalMatrix[^;]*\\*\\s*normalW\\);)";
      checkedShader(wgsl ? bumpFragmentWGSL.shader : bumpFragment.shader, "lattice object normal map").replace(new RegExp(normalMap), "$1");
      const input = wgsl ? "fragmentInputs." : "";
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: objectNormalVaryings + `#if defined(SLATE_LATTICE) && defined(OBJECTSPACE_NORMALMAP)\n${latticeNormalShaderFunction(language)}\n#endif\n`,
        ["!" + normalMap]: `$1\n#ifdef SLATE_LATTICE\nnormalW = slateLatticeNormal(${wgsl ? "mat3x3f" : "mat3"}(${input}vSlateLatticeJ0,${input}vSlateLatticeJ1,${input}vSlateLatticeJ2),normalW);\n#endif\n`,
      };
    }
    if (type !== "vertex") return null;
    const source = this._material instanceof PBRBaseMaterial
      ? (wgsl ? pbrVertexShaderWGSL.shader : pbrVertexShader.shader)
      : (wgsl ? defaultVertexShaderWGSL.shader : defaultVertexShader.shader);
    const normal = "((?:vertexOutputs\\.)?vNormalW\\s*=\\s*normalize\\(normalWorld\\s*\\*\\s*(?:normalUpdated|(?:vertexOutputs\\.)?vNormalW)\\);)";
    // Regex plugin hooks run after include expansion. Validate their original
    // stock anchors now rather than silently losing a stage after an upgrade.
    checkedShader(source, `native lattice ${language}`)
      .replace(new RegExp(LATTICE_WORLD_POSITION_PATTERN), "$1")
      .replace(new RegExp(normal, "g"), "$1", 2);
    const output = wgsl ? "vertexOutputs." : "";
    return {
      CUSTOM_VERTEX_DEFINITIONS: objectNormalVaryings + latticeShaderDeclarations(language, false) + latticeShaderFunctions(this._material.getScene(), language),
      ["!" + LATTICE_WORLD_POSITION_PATTERN]: "$1" + latticeWorldPositionCode(wgsl),
      ["!" + normal]: `$1\n#ifdef SLATE_LATTICE\n${output}vNormalW = slateLatticeNormal(slateLatticeResult.jacobian,${output}vNormalW);\n#endif\n`,
      // Stock bumpVertex uses untouched normalUpdated/tangentUpdated. Rebuild
      // an orthonormal frame from its original T/B and the final normal; the
      // transformed original B retains UV/world/cage reflection handedness.
      CUSTOM_VERTEX_MAIN_END: `
#if defined(SLATE_LATTICE) && defined(OBJECTSPACE_NORMALMAP)
${output}vSlateLatticeJ0 = slateLatticeResult.jacobian[0];
${output}vSlateLatticeJ1 = slateLatticeResult.jacobian[1];
${output}vSlateLatticeJ2 = slateLatticeResult.jacobian[2];
#endif
#if defined(SLATE_LATTICE) && defined(TANGENT) && defined(NORMAL) && (defined(BUMP) || defined(PARALLAX) || defined(CLEARCOAT_BUMP) || defined(ANISOTROPIC))
${wgsl ? `vertexOutputs.vTBN0 = slateLatticeTangent(slateLatticeResult.jacobian,vertexOutputs.vTBN0,vertexOutputs.vNormalW);
vertexOutputs.vTBN1 = slateLatticeBitangent(slateLatticeResult.jacobian,vertexOutputs.vTBN0,vertexOutputs.vTBN1,vertexOutputs.vNormalW);
vertexOutputs.vTBN2 = vertexOutputs.vNormalW;` : `vec3 slateLatticeBasisT = slateLatticeTangent(slateLatticeResult.jacobian,vTBN[0],vNormalW);
vTBN = mat3(slateLatticeBasisT,
 slateLatticeBitangent(slateLatticeResult.jacobian,slateLatticeBasisT,vTBN[1],vNormalW),vNormalW);`}
#endif`,
    };
  }
}
const supportedClasses = new Set(["StandardMaterial", "PBRMaterial", "PBRMetallicRoughnessMaterial", "PBRSpecularGlossinessMaterial", "CelMaterial"]);
/** Babylon clears global plugin factories after the last Engine is disposed.
 * Its public plugin constructor also rebuilds an existing native UBO layout. */
export function ensureLatticeDeformerPlugin(material: Material): LatticeDeformerPlugin | null {
  const existing = material.pluginManager?.getPlugin<LatticeDeformerPlugin>("SlateLattice");
  if (existing) return existing;
  return supportedClasses.has(material.getClassName()) && (material instanceof PBRBaseMaterial || material instanceof StandardMaterial) ? new LatticeDeformerPlugin(material) : null;
}
RegisterMaterialPlugin("SlateLattice", ensureLatticeDeformerPlugin);
