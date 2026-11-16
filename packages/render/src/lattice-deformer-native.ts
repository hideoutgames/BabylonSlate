import { PBRBaseMaterial } from "@babylonjs/core/Materials/PBR/pbrBaseMaterial";
import type { Material } from "@babylonjs/core/Materials/material";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Scene } from "@babylonjs/core/scene";
import { defaultVertexShader } from "@babylonjs/core/Shaders/default.vertex";
import { pbrVertexShader } from "@babylonjs/core/Shaders/pbr.vertex";
import { bumpFragment } from "@babylonjs/core/Shaders/ShadersInclude/bumpFragment";
import { bindMeshLatticeDeformerBuffer, hasMeshLatticeDeformer } from "./lattice-deformer-binding";
import { checkedShader } from "./checked-shader";
import { LATTICE_SAMPLER, LATTICE_WORLD_POSITION_PATTERN, latticeNormalShaderFunction, latticeShaderDeclarations, latticeShaderFunctions, latticeWorldPositionCode } from "./lattice-deformer-shader";

/** Attached on demand to the materials an active cage draws. Per-mesh defines
 * keep ordinary draws of a shared or frozen material free of a vertex sampler. */
export class LatticeDeformerPlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "SlateLattice", 220, { SLATE_LATTICE: false }, true, false);
    this.registerForExtraEvents = true;
    // Material.clone rebuilds a serialized plugin as a bare MaterialPluginBase carrying this name, which
    // would then pass for the real one. The owner attaches a fresh plugin to the clone instead.
    this.doNotSerialize = true;
    this._enable(true);
  }
  override isCompatible(): boolean { return true; }
  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    (defines as MaterialDefines & { SLATE_LATTICE: boolean }).SLATE_LATTICE = hasMeshLatticeDeformer(mesh);
  }
  override hardBindForSubMesh(buffer: UniformBuffer, _scene: Scene, _engine: unknown, subMesh: SubMesh): void {
    // Only an effect compiled with the cage reads it: ordinary draws skip the parent walk and the uniform write.
    if (!(subMesh.materialDefines as (MaterialDefines & { SLATE_LATTICE?: boolean }) | null)?.SLATE_LATTICE) return;
    bindMeshLatticeDeformerBuffer(buffer, subMesh.getEffectiveMesh());
  }
  override getSamplers(samplers: string[]): void { samplers.push(LATTICE_SAMPLER); }
  override getUniforms() {
    const uniforms = ["lattice_cellSize", "lattice_min", "lattice_max", "lattice_resolution", "lattice_position"].map((name) => ({ name, size: 3, type: "vec3" }));
    uniforms.push({ name: "slateWorldToLattice", size: 16, type: "mat4" }, { name: "slateLatticeToWorld", size: 16, type: "mat4" }, { name: "slateLatticeEnabled", size: 1, type: "float" });
    return { ubo: uniforms, vertex: uniforms.map(({ name, type }) => `uniform ${type} ${name};`).join("\n") };
  }
  override getCustomCode(type: string): Record<string, string> | null {
    const objectNormalVaryings = `#if defined(SLATE_LATTICE) && defined(OBJECTSPACE_NORMALMAP)\n${[0, 1, 2].map((i) => `varying vec3 vSlateLatticeJ${i};`).join("\n")}\n#endif\n`;
    if (type === "fragment") {
      const normalMap = "(normalW\\s*=\\s*normalize\\(mat3\\(normalMatrix[^;]*\\*\\s*normalW\\);)";
      checkedShader(bumpFragment.shader, "lattice object normal map").replace(new RegExp(normalMap), "$1");
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: objectNormalVaryings + `#if defined(SLATE_LATTICE) && defined(OBJECTSPACE_NORMALMAP)\n${latticeNormalShaderFunction()}\n#endif\n`,
        ["!" + normalMap]: `$1\n#ifdef SLATE_LATTICE\nnormalW = slateLatticeNormal(mat3(vSlateLatticeJ0,vSlateLatticeJ1,vSlateLatticeJ2),normalW);\n#endif\n`,
      };
    }
    if (type !== "vertex") return null;
    const source = this._material instanceof PBRBaseMaterial ? pbrVertexShader.shader : defaultVertexShader.shader;
    const normal = "(vNormalW\\s*=\\s*normalize\\(normalWorld\\s*\\*\\s*(?:normalUpdated|vNormalW)\\);)";
    // Regex plugin hooks run after include expansion. Validate their original
    // stock anchors now rather than silently losing a stage after an upgrade.
    checkedShader(source, "native lattice")
      .replace(new RegExp(LATTICE_WORLD_POSITION_PATTERN), "$1")
      .replace(new RegExp(normal, "g"), "$1", 2);
    return {
      CUSTOM_VERTEX_DEFINITIONS: objectNormalVaryings + latticeShaderDeclarations(false) + latticeShaderFunctions(this._material.getScene()),
      ["!" + LATTICE_WORLD_POSITION_PATTERN]: "$1" + latticeWorldPositionCode(),
      ["!" + normal]: `$1\n#ifdef SLATE_LATTICE\nvNormalW = slateLatticeNormal(slateLatticeResult.jacobian,vNormalW);\n#endif\n`,
      // Stock bumpVertex uses untouched normalUpdated/tangentUpdated. Rebuild
      // an orthonormal frame from its original T/B and the final normal; the
      // transformed original B retains UV/world/cage reflection handedness.
      CUSTOM_VERTEX_MAIN_END: `
#if defined(SLATE_LATTICE) && defined(OBJECTSPACE_NORMALMAP)
vSlateLatticeJ0 = slateLatticeResult.jacobian[0];
vSlateLatticeJ1 = slateLatticeResult.jacobian[1];
vSlateLatticeJ2 = slateLatticeResult.jacobian[2];
#endif
#if defined(SLATE_LATTICE) && defined(TANGENT) && defined(NORMAL) && (defined(BUMP) || defined(PARALLAX) || defined(CLEARCOAT_BUMP) || defined(ANISOTROPIC))
vec3 slateLatticeBasisT = slateLatticeTangent(slateLatticeResult.jacobian,vTBN[0],vNormalW);
vTBN = mat3(slateLatticeBasisT,
 slateLatticeBitangent(slateLatticeResult.jacobian,slateLatticeBasisT,vTBN[1],vNormalW),vNormalW);
#endif`,
    };
  }
}
const supportedClasses = new Set(["StandardMaterial", "PBRMaterial", "PBRMetallicRoughnessMaterial", "PBRSpecularGlossinessMaterial"]);
/** The only way this plugin reaches a material: no global factory, because one
 * adds its code, sampler and uniforms to every Standard/PBR shader, cage or not.
 * The cage owner calls this for each material it draws, then marks them dirty.
 * Babylon's plugin constructor resets the draw cache and rebuilds the native UBO
 * layout of a material that already compiled, so the next draw recompiles it. */
export function ensureLatticeDeformerPlugin(material: Material): LatticeDeformerPlugin | null {
  const existing = material.pluginManager?.getPlugin<LatticeDeformerPlugin>("SlateLattice");
  if (existing) return existing;
  return supportedClasses.has(material.getClassName()) && (material instanceof PBRBaseMaterial || material instanceof StandardMaterial) ? new LatticeDeformerPlugin(material) : null;
}
