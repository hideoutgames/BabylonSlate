import { FragmentOutputBlock } from "@babylonjs/core/Materials/Node/Blocks/Fragment/fragmentOutputBlock";
import { InputBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/inputBlock";
import {
  NodeMaterialBlockConnectionPointTypes as Types,
} from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialSystemValues } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialSystemValues";
import type { NodeMaterial, NodeMaterialDefines } from "@babylonjs/core/Materials/Node/nodeMaterial";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import type { Effect } from "@babylonjs/core/Materials/effect";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { foliageFadeForMesh, HAPTIC_BAYER_4X4_GLSL } from "./foliage-fade";
import { meshCastsShadows } from "./instance-pool";
import { WORLD_DEBUG_FLAT_DEFINE, worldDebugOff } from "./world-debug";
import type { MaterialPlumbing } from "./material-block-registry";

/**
 * Surface output with the same geometry encodings as Babylon's native materials, except the view depth's second channel:
 * 1 where the drawn mesh casts shadows, 0 elsewhere (`meshCastsShadows`), which only a pass with an RG depth target keeps
 * (Screen-Space Shadows march over casters alone). Bound per mesh; the compiler rebinds it for frozen Materials.
 */
export class GeometrySurfaceOutputBlock extends FragmentOutputBlock {
  private casterUniform = "";
  private foliageFadeUniform = "";
  constructor(name: string) {
    super(name);
    this.registerInput("geometryPosition", Types.Vector4);
    this.registerInput("geometryNormal", Types.Vector3);
    this.registerInput("geometryView", Types.Matrix);
    this.registerInput("geometryCamera", Types.Vector4);
    this.registerInput("geometryBaseColor", Types.Color3, true);
    this.registerInput("geometryMetallic", Types.Float, true);
    this.registerInput("geometryRoughness", Types.Float, true);
    this.registerInput("geometrySpecular", Types.Float, true);
  }

  get geometryPosition() { return this.getInputByName("geometryPosition")!; }
  get geometryNormal() { return this.getInputByName("geometryNormal")!; }
  get geometryView() { return this.getInputByName("geometryView")!; }
  get geometryCamera() { return this.getInputByName("geometryCamera")!; }
  get geometryBaseColor() { return this.getInputByName("geometryBaseColor")!; }
  get geometryMetallic() { return this.getInputByName("geometryMetallic")!; }
  get geometryRoughness() { return this.getInputByName("geometryRoughness")!; }
  get geometrySpecular() { return this.getInputByName("geometrySpecular")!; }
  override getClassName(): string { return "GeometrySurfaceOutputBlock"; }
  override prepareDefines(defines: NodeMaterialDefines, nodeMaterial: NodeMaterial, mesh?: AbstractMesh): void {
    super.prepareDefines(defines, nodeMaterial);
    // `worlddebug shading off`: one constant colour, so the compiler drops the surface's shading and texture reads.
    if (mesh) defines.setValue(WORLD_DEBUG_FLAT_DEFINE, worldDebugOff(mesh.getScene(), "shading"), true);
  }
  override bind(effect: Effect, material: NodeMaterial, mesh?: Mesh): void {
    super.bind(effect, material, mesh);
    effect.setFloat(this.casterUniform, mesh && meshCastsShadows(mesh) ? 1 : 0);
    const fade = foliageFadeForMesh(mesh);
    if (fade) effect.setFloat2(this.foliageFadeUniform, fade[0], fade[1]);
    else effect.setFloat2(this.foliageFadeUniform, 0, 0);
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    const vec4 = state._getShaderType(Types.Vector4);
    const normal = this.geometryNormal.associatedVariableName;
    const position = this.geometryPosition.associatedVariableName;
    const view = this.geometryView.associatedVariableName;
    const camera = this.geometryCamera.associatedVariableName;
    const vec3 = state._getShaderType(Types.Vector3);
    const metallic = this.geometryMetallic.isConnected ? this.geometryMetallic.associatedVariableName : "0.0";
    const roughness = this.geometryRoughness.isConnected ? this.geometryRoughness.associatedVariableName : "0.5";
    const dielectricF0 = this.geometrySpecular.isConnected ? `(0.08 * clamp(${this.geometrySpecular.associatedVariableName}, 0.0, 1.0))` : "0.04";
    const reflectivity = this.geometryBaseColor.isConnected
      ? `${vec4}(mix(${vec3}(${dielectricF0}), ${this.geometryBaseColor.associatedVariableName}, clamp(${metallic}, 0.0, 1.0)), 1.0 - clamp(${roughness}, 0.0, 1.0))`
      : `${vec4}(0.0)`;
    this.casterUniform = state._getFreeVariableName("hapticGeometryCaster");
    state._emitUniformFromString(this.casterUniform, Types.Float);
    this.foliageFadeUniform = state._getFreeVariableName("hapticFoliageFade");
    state._emitUniformFromString(this.foliageFadeUniform, Types.Vector2);
    state._emitFunction("hapticBayer4x4", HAPTIC_BAYER_4X4_GLSL, "");
    state.sharedData.forcedBindableBlocks.push(this);
    const caster = this.casterUniform;
    const fade = this.foliageFadeUniform;
    const color = "gl_FragColor";
    state.compilationString += `if (${fade}.y > 0.0) { float _hapticFadeDist = length((${view} * ${position}).xyz); float _hapticFadeT = clamp((_hapticFadeDist - ${fade}.x) / max(0.001, ${fade}.y - ${fade}.x), 0.0, 1.0); if (_hapticFadeT > 0.0 && _hapticFadeT >= hapticBayer4x4(gl_FragCoord.xy)) discard; }\n`;
    state.compilationString += `#ifdef ${WORLD_DEBUG_FLAT_DEFINE}\n${color} = ${vec4}(0.5, 0.5, 0.5, ${color}.a);\n#endif\n`;
    const savedColor = state._getFreeVariableName("geometrySurfaceColor");
    state.compilationString += `#ifdef PREPASS\n${state._declareLocalVar(savedColor, Types.Vector4)} = ${color};\n#endif\n`;
    // FragmentOutputBlock assumes attachment zero is color. Geometry tasks can
    // put color last or omit it entirely, so overwrite each requested slot after
    // the native output, within this block (including after CEL/PBR switches).
    for (const [define, value] of [
      ["PREPASS_COLOR", savedColor],
      ["PREPASS_DEPTH", `${vec4}((${view} * ${position}).z, ${caster}, 0.0, 1.0)`],
      ["PREPASS_REFLECTIVITY", reflectivity],
      ["PREPASS_NORMALIZED_VIEW_DEPTH", `${vec4}(((${view} * ${position}).z - ${camera}.y) / (${camera}.z - ${camera}.y), 0.0, 0.0, 1.0)`],
      ["PREPASS_WORLD_NORMAL", `${vec4}(normalize(${normal}) * 0.5 + 0.5, 1.0)`],
    ]) {
      state.compilationString += geometryOutputWrite(define, value);
    }
    return this;
  }
}
RegisterClass("BABYLON.GeometrySurfaceOutputBlock", GeometrySurfaceOutputBlock);

/** The geometry outputs this block writes besides the colour. */
const GEOMETRY_DATA_OUTPUTS = ["PREPASS_DEPTH", "PREPASS_REFLECTIVITY", "PREPASS_NORMALIZED_VIEW_DEPTH", "PREPASS_WORLD_NORMAL"] as const;

/**
 * A preprocessor condition that holds in a geometry pass that reads nothing of the surface's lit colour: it has no
 * colour output, and its first attachment, where the fragment output writes the colour, is one of the outputs this
 * block overwrites. The light block compiles no lighting there (`HapticLightingBlock`): every output such a pass keeps
 * is computed from the surface's inputs alone.
 */
export const GEOMETRY_PASS_WITHOUT_COLOR =
  `defined(PREPASS) && !defined(PREPASS_COLOR) && (${GEOMETRY_DATA_OUTPUTS.map((define) => `(defined(${define}) && ${define}_INDEX == 0)`).join(" || ")})`;

/** Whether a program compiled with `defines` (an Effect's) meets `GEOMETRY_PASS_WITHOUT_COLOR`, as its preprocessor reads it. */
export function isGeometryPassWithoutColor(defines: string): boolean {
  const defined = (name: string) => new RegExp(`^#define ${name}(?: |$)`, "m").test(defines);
  return defined("PREPASS") && !defined("PREPASS_COLOR") &&
    GEOMETRY_DATA_OUTPUTS.some((define) => defined(define) && new RegExp(`^#define ${define}_INDEX 0$`, "m").test(defines));
}

/** Writes `value` to the geometry output `define` names (`PREPASS_WORLD_NORMAL` and so on), where the pass has one. */
export function geometryOutputWrite(define: string, value: string): string {
  let code = "";
  for (let index = 0; index < 8; index++) {
    const target = `gl_FragData[${index}]`;
    code += `#if defined(PREPASS) && defined(${define}) && ${define}_INDEX == ${index}\n${target} = ${value};\n#endif\n`;
  }
  return code;
}

export function connectGeometrySurfaceOutput(
  block: GeometrySurfaceOutputBlock,
  plumbing: MaterialPlumbing,
  normal: NodeMaterialConnectionPoint | null,
  created: NodeMaterialBlock[],
): void {
  plumbing.worldPosition!.connectTo(block.geometryPosition);
  (normal ?? plumbing.worldNormal)!.connectTo(block.geometryNormal);
  plumbing.view!.connectTo(block.geometryView);
  const camera = new InputBlock(`${block.name}_geometryCamera`);
  camera.setAsSystemValue(NodeMaterialSystemValues.CameraParameters);
  camera.output.connectTo(block.geometryCamera);
  created.push(camera);
}
