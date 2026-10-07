import { Material, ShaderLanguage, type Scene } from "@babylonjs/core";
import { Lattice } from "@babylonjs/core/Meshes/lattice";
import { LatticePluginMaterial } from "@babylonjs/core/Meshes/lattice.material";
import { checkedShader } from "./checked-shader";

export const LATTICE_UNIFORMS = ["lattice_cellSize", "lattice_min", "lattice_max", "lattice_resolution", "lattice_position", "slateWorldToLattice", "slateLatticeToWorld", "slateLatticeEnabled"];
export const LATTICE_SAMPLER = "latticeData";

/** Shader generation uses the public stock plugin without allocating its texture. */
class ShaderTemplate extends LatticePluginMaterial {
  override refreshData(): void {}
}
class Carrier extends Material {
  private readonly language: ShaderLanguage;
  constructor(scene: Scene, language: ShaderLanguage) {
    super("__latticeCarrier", scene, true);
    this.language = language;
  }
  override get shaderLanguage(): ShaderLanguage { return this.language; }
}
const functions = new Map<ShaderLanguage, string>();

/** Babylon owns fetching and interpolation. Only stage, boundary derivative,
 * and the analytic differential are adapted here, checked against 9.29 hooks. */
export function latticeShaderFunctions(scene: Scene, language: ShaderLanguage): string {
  const cached = functions.get(language);
  if (cached) return cached;
  const wgsl = language === ShaderLanguage.WGSL;
  const carrier = new Carrier(scene, language);
  const stock = new ShaderTemplate(new Lattice({ resolutionX: 2, resolutionY: 2, resolutionZ: 2 }), carrier);
  let body: string;
  try { body = stock.getCustomCode("vertex", language)!.CUSTOM_VERTEX_UPDATE_POSITION; }
  finally { carrier.dispose(); }
  const vec = wgsl ? "vec3f" : "vec3", mat = wgsl ? "mat3x3f" : "mat3", v4 = wgsl ? "vec4f" : "vec4";
  const u = wgsl ? "uniforms." : "";
  const declare = (name: string, type: string, value: string) => wgsl ? `var ${name}: ${type} = ${value};` : `${type} ${name} = ${value};`;
  const adapter = checkedShader(body, `stock lattice ${language}`);
  // At the upper face use the last complete cell (weight 1), preserving the
  // stock position while avoiding a zero derivative from duplicate samples.
  for (const axis of ["x", "y", "z"]) {
    const cast = wgsl ? "i32" : "int";
    adapter.replace(`${cast}(floor(localPos.${axis}))`, `min(${cast}(floor(localPos.${axis})), ${cast}(lattice_resolution.${axis}) - 2)`);
  }
  adapter.replace("positionUpdated = deformedPos + lattice_position;", `
    localJacobian = ${mat}(
      mix(mix(p100-p000,p110-p010,ty),mix(p101-p001,p111-p011,ty),tz)/lattice_cellSize.x,
      mix(mix(p010-p000,p110-p100,tx),mix(p011-p001,p111-p101,tx),tz)/lattice_cellSize.y,
      (p1-p0)/lattice_cellSize.z);
    positionUpdated = deformedPos + lattice_position;
    changed = true;`);
  const identity = `${mat}(${vec}(1.0,0.0,0.0),${vec}(0.0,1.0,0.0),${vec}(0.0,0.0,1.0))`;
  const matrix3 = (name: string) => wgsl ? `${mat}(${u}${name}[0].xyz,${u}${name}[1].xyz,${u}${name}[2].xyz)` : `${mat}(${name})`;
  const result = `${wgsl ? "struct SlateLatticeResult { position: vec3f, jacobian: mat3x3f, }" : "struct SlateLatticeResult { vec3 position; mat3 jacobian; };"}
${wgsl ? "fn slateLattice(worldPosition: vec3f) -> SlateLatticeResult" : "SlateLatticeResult slateLattice(vec3 worldPosition)"} {
  ${declare("result", "SlateLatticeResult", `SlateLatticeResult(worldPosition,${identity})`)}
#ifdef SLATE_LATTICE
  if (${u}slateLatticeEnabled > 0.5) {
    ${declare("positionUpdated", vec, `(${u}slateWorldToLattice * ${v4}(worldPosition,1.0)).xyz`)}
    ${declare("localJacobian", mat, identity)}
    ${declare("changed", "bool", "false")}
    ${adapter.value}
    if (changed) {
      result.position = (${u}slateLatticeToWorld * ${v4}(positionUpdated,1.0)).xyz;
      result.jacobian = ${matrix3("slateLatticeToWorld")} * localJacobian * ${matrix3("slateWorldToLattice")};
    }
  }
#endif
  return result;
}
${latticeNormalShaderFunction(language)}
${wgsl ? "fn slateLatticeTangent(j: mat3x3f, t: vec3f, n: vec3f) -> vec3f" : "vec3 slateLatticeTangent(mat3 j, vec3 t, vec3 n)"} {
  ${declare("tangent", vec, "j*t")}
  tangent = tangent - n*dot(tangent,n);
  if (dot(tangent,tangent) < 0.0000001) { return t; }
  return normalize(tangent);
}
${wgsl ? "fn slateLatticeBitangent(j: mat3x3f, t: vec3f, b: vec3f, n: vec3f) -> vec3f" : "vec3 slateLatticeBitangent(mat3 j, vec3 t, vec3 b, vec3 n)"} {
  ${declare("bitangent", vec, "cross(n,t)")}
  if (dot(bitangent,bitangent) < 0.0000001) { return b; }
  if (dot(bitangent,j*b) < 0.0) { bitangent = -bitangent; }
  return normalize(bitangent);
}`;
  functions.set(language, result);
  return result;
}

export function latticeNormalShaderFunction(language: ShaderLanguage): string {
  return language === ShaderLanguage.WGSL ? `fn slateLatticeNormal(j: mat3x3f, n: vec3f) -> vec3f {
  let c0 = cross(j[1],j[2]); let c1 = cross(j[2],j[0]); let c2 = cross(j[0],j[1]);
  let d = dot(j[0],c0); let normal = mat3x3f(c0,c1,c2)*n;
  if (abs(d) < 0.0000001 || dot(normal,normal) < 0.0000001) { return n; }
  return normalize(normal * sign(d));
}` : `vec3 slateLatticeNormal(mat3 j, vec3 n) {
  vec3 c0 = cross(j[1],j[2]); vec3 c1 = cross(j[2],j[0]); vec3 c2 = cross(j[0],j[1]);
  float d = dot(j[0],c0); vec3 normal = mat3(c0,c1,c2)*n;
  if (abs(d) < 0.0000001 || dot(normal,normal) < 0.0000001) { return n; }
  return normalize(normal * sign(d));
}`;
}

export function latticeShaderDeclarations(language: ShaderLanguage, uniforms = true): string {
  const wgsl = language === ShaderLanguage.WGSL;
  return `#ifdef SLATE_LATTICE\n${wgsl ? "var latticeData: texture_3d<f32>;" : "precision highp sampler3D;\nuniform sampler3D latticeData;"}
${uniforms ? LATTICE_UNIFORMS.map((name) => {
    const type = name.startsWith("slate") ? name.endsWith("Enabled") ? "float" : "mat4" : "vec3";
    return wgsl ? `uniform ${name}: ${type === "float" ? "f32" : type === "mat4" ? "mat4x4f" : "vec3f"};` : `uniform ${type} ${name};`;
  }).join("\n") : ""}\n#endif\n`;
}

export const LATTICE_WORLD_POSITION_PATTERN = "(worldPos\\s*(?::\\s*vec4f)?\\s*=\\s*finalWorld\\s*\\*\\s*vec4f?\\(positionUpdated,\\s*1\\.0\\);)";
export function latticeWorldPositionCode(wgsl: boolean): string {
  return `\n${wgsl ? "var slateLatticeResult: SlateLatticeResult" : "SlateLatticeResult slateLatticeResult"} = slateLattice(worldPos.xyz);\nworldPos = ${wgsl ? "vec4f" : "vec4"}(slateLatticeResult.position,worldPos.w);\n`;
}
