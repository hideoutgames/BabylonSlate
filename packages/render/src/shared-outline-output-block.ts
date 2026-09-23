import {
  FragmentOutputBlock, NodeMaterialBlock, NodeMaterialBlockTargets as Targets,
  NodeMaterialBlockConnectionPointTypes as Types,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { SHARED_OUTLINE_ATTRIBUTE } from "./shared-outline";

/** One actor ID for ordinary/thin meshes; independent IDs for regular instances. */
export class SharedOutlineIdentityBlock extends NodeMaterialBlock {
  constructor(name: string) { super(name, Targets.Vertex); this.registerOutput("identity", Types.Float, Targets.Vertex); }
  get identity() { return this._outputs[0]!; }
  override getClassName(): string { return "SharedOutlineIdentityBlock"; }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    const wgsl = state.shaderLanguage === 1;
    state._emitUniformFromString("selectionId", Types.Float);
    if (!state.attributes.includes(SHARED_OUTLINE_ATTRIBUTE)) state.attributes.push(SHARED_OUTLINE_ATTRIBUTE);
    state._attributeDeclaration += `#if defined(INSTANCES) && !defined(THIN_INSTANCES)\n${wgsl
      ? `attribute ${SHARED_OUTLINE_ATTRIBUTE}: f32;` : `attribute float ${SHARED_OUTLINE_ATTRIBUTE};`}\n#endif\n`;
    state.compilationString += `#if defined(INSTANCES) && !defined(THIN_INSTANCES)\n${state._declareOutput(this.identity)} = ${wgsl ? "vertexInputs." : ""}${SHARED_OUTLINE_ATTRIBUTE};\n#else\n${state._declareOutput(this.identity)} = ${wgsl ? "uniforms." : ""}selectionId;\n#endif\n`;
    return this;
  }
}

/** Replace lighting output while retaining the authored deformation/discard graph. */
export class SharedOutlineOutputBlock extends FragmentOutputBlock {
  constructor(name: string) { super(name); }
  override getClassName(): string { return "SharedOutlineOutputBlock"; }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    const wgsl = state.shaderLanguage === 1;
    const uniform = wgsl ? "uniforms." : "";
    state._emitUniformFromString("tableSize", Types.Vector2);
    state._emitUniformFromString("discardNonmembers", Types.Float);
    state._emitUniformFromString("coverageAlpha", Types.Float);
    state._emit2DSampler("styleSampler");
    const id = state._getFreeVariableName("outlineIdentity");
    const uv = state._getFreeVariableName("outlineStyleUV");
    const mod = (value: string, divisor: string) => wgsl ? `(${value} % ${divisor})` : `mod(${value}, ${divisor})`;
    const vec2 = state._getShaderType(Types.Vector2), vec4 = state._getShaderType(Types.Vector4);
    state.compilationString += `${state._declareLocalVar(id, Types.Float)} = floor(${this.rgb.associatedVariableName} + 0.5);\n`;
    state.compilationString += `${state._declareLocalVar(uv, Types.Vector2)} = (${vec2}(${mod(id, `${uniform}tableSize.x`)}, floor(${id} / ${uniform}tableSize.x)) + ${vec2}(0.5)) / ${uniform}tableSize;\n`;
    state.compilationString += `if (${uniform}coverageAlpha <= 0.0) { discard; }\n`;
    if (this.a.isConnected) state.compilationString += `if (${this.a.associatedVariableName} <= 0.0) { discard; }\n`;
    state.compilationString += `if (${state._generateTextureSampleLOD(uv, "styleSampler", "0.0")}.a <= 0.0) {\nif (${uniform}discardNonmembers > 0.5) { discard; }\n${id} = 0.0;\n}\n`;
    state.compilationString += `${wgsl ? "fragmentOutputs.color" : "gl_FragColor"} = ${vec4}(${mod(id, "256.0")}, ${mod(`floor(${id} / 256.0)`, "256.0")}, floor(${id} / 65536.0), 255.0) / 255.0;\n`;
    return this;
  }
}
