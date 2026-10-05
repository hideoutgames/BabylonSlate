import {
  NodeMaterialBlock, NodeMaterialBlockTargets as Targets, NodeMaterialBlockConnectionPointTypes as Types,
  InputBlock, NodeMaterialSystemValues, type NodeMaterialConnectionPoint,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import type { MaterialPlumbing } from "./material-block-registry";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapVertexExtraDeclaration";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapVertexNormalBias";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapVertexMetric";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapFragmentExtraDeclaration";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapFragmentSoftTransparentShadow";
import "@babylonjs/core/Shaders/ShadersInclude/shadowMapFragment";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapVertexExtraDeclaration";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapVertexNormalBias";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapVertexMetric";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapFragmentExtraDeclaration";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapFragmentSoftTransparentShadow";
import "@babylonjs/core/ShadersWGSL/ShadersInclude/shadowMapFragment";

// ShadowDepthWrapper supplies these values from the native ShadowGenerator.
// doNotInjectCode keeps the wrapper from registering them on our behalf.
function shadowUniforms(state: NodeMaterialBuildState): void {
  for (const name of ["biasAndScaleSM", "depthValuesSM", "lightDataSM", "softTransparentShadowSM"])
    if (!state.uniforms.includes(name)) state.uniforms.push(name);
}

/** Native shadow bias/projection/metric after the complete authored vertex graph. */
class AuthoredShadowVertexOutput extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, Targets.Vertex, true);
    this.registerInput("position", Types.Vector4);
    this.registerInput("normal", Types.Vector3);
    this.registerInput("viewProjection", Types.Matrix);
  }
  get position() { return this._inputs[0]!; }
  get normal() { return this._inputs[1]!; }
  get viewProjection() { return this._inputs[2]!; }
  override getClassName(): string { return "AuthoredShadowVertexOutput"; }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    shadowUniforms(state);
    state._emitFunctionFromInclude("shadowMapVertexExtraDeclaration", "");
    const world = state._getFreeVariableName("shadowWorldPosition");
    const normal = state._getFreeVariableName("shadowWorldNormal");
    const replacements = [{ search: /\bworldPos\b/g, replace: world }, { search: /\bvNormalW\b/g, replace: normal }];
    state.compilationString += `${state._declareLocalVar(world, Types.Vector4)} = ${this.position.associatedVariableName};\n`;
    state.compilationString += `${state._declareLocalVar(normal, Types.Vector3)} = normalize(${this.normal.associatedVariableName});\n`;
    state.compilationString += state._emitCodeFromInclude("shadowMapVertexNormalBias", "", { replaceStrings: replacements });
    state.compilationString += `${state.shaderLanguage === 1 ? "vertexOutputs.position" : "gl_Position"} = ${this.viewProjection.associatedVariableName} * ${world};\n`;
    state.compilationString += state._emitCodeFromInclude("shadowMapVertexMetric", "", { replaceStrings: replacements });
    return this;
  }
}

/** Native shadow encoding runs after the graph's optional alpha discard. */
export class AuthoredShadowFragmentOutput extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, Targets.Fragment, true);
    this.registerInput("opacity", Types.Float, true);
    this.registerInput("nativeOpacityMap", Types.Vector4, true);
  }
  get opacity(): NodeMaterialConnectionPoint { return this._inputs[0]!; }
  get nativeOpacityMap(): NodeMaterialConnectionPoint { return this._inputs[1]!; }
  override getClassName(): string { return "AuthoredShadowFragmentOutput"; }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    shadowUniforms(state);
    state._emitFunctionFromInclude("shadowMapFragmentExtraDeclaration", "");
    let alpha = this.opacity.isConnected ? this.opacity.associatedVariableName : "1.0";
    if (this.nativeOpacityMap.isConnected) {
      // Preserve the stock generator's cutoff and alpha-from-RGB behavior.
      const sample = this.nativeOpacityMap.associatedVariableName;
      alpha = state._getFreeVariableName("nativeShadowAlpha");
      state._injectAtEnd += `${state._declareLocalVar(alpha, Types.Float)} = ${sample}.a;\n`;
      const vector = state.shaderLanguage === 1 ? "vec3f" : "vec3";
      state._injectAtEnd += `#if SM_SOFTTRANSPARENTSHADOW == 1 && defined(SLATE_NATIVE_OPACITY_RGB)\n${alpha} = dot(${sample}.rgb, ${vector}(0.3, 0.59, 0.11));\n#endif\n`;
      state._injectAtEnd += `#ifdef ALPHATESTVALUE\nif (${alpha} < ALPHATESTVALUE) { discard; }\n#endif\n`;
    }
    state._injectAtEnd += state._emitCodeFromInclude("shadowMapFragmentSoftTransparentShadow", "", {
      replaceStrings: [{ search: /\balpha\b/g, replace: `(${alpha})` }],
    });
    state._injectAtEnd += state._emitCodeFromInclude("shadowMapFragment", "");
    return this;
  }
}

export function createAuthoredShadowVertexOutput(
  name: string, created: NodeMaterialBlock[], plumbing: MaterialPlumbing,
): NodeMaterialBlock {
  const output = new AuthoredShadowVertexOutput(`${name}_shadowVertex`);
  const viewProjection = new InputBlock(`${name}_shadowViewProjection`);
  viewProjection.setAsSystemValue(NodeMaterialSystemValues.ViewProjection);
  plumbing.worldPosition!.connectTo(output.position);
  plumbing.worldNormal!.connectTo(output.normal);
  viewProjection.output.connectTo(output.viewProjection);
  created.push(output, viewProjection);
  return output;
}
