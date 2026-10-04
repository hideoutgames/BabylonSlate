import {
  NodeMaterialBlock, NodeMaterialBlockTargets as Targets,
  NodeMaterialBlockConnectionPointTypes as Types, RawTexture, Texture,
  type AbstractMesh, type BaseTexture, type Effect, type Mesh, type NodeMaterial,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";

export type TextMaterialBinding = {
  atlas: BaseTexture | null;
  mode: "solid" | "bitmap" | "msdf";
  color: readonly [number, number, number];
  outlineColor: readonly [number, number, number];
  outline: number;
  /** Lower-left and size, independent of the atlas packing. */
  atlasRect: readonly [number, number, number, number];
  materialRect: readonly [number, number, number, number];
};

const bindings = new WeakMap<AbstractMesh, TextMaterialBinding>();
export function bindTextMaterialGlyph(mesh: Mesh, binding: TextMaterialBinding): void {
  bindings.set(mesh, binding);
}
export function textMaterialGlyphBinding(mesh: Mesh): TextMaterialBinding | undefined {
  return bindings.get(mesh);
}

/** Text owns coverage and span tint; the authored graph owns the fill effect. */
export class TextMaterialBlock extends NodeMaterialBlock {
  private fallback: RawTexture | null = null;
  private sampler = "";
  private parameters = "";
  private tint = "";
  private stroke = "";
  private atlasRect = "";
  private materialRect = "";
  private opacity = "";

  constructor(name: string) {
    super(name, Targets.Fragment);
    this.registerInput("glyphUV", Types.Vector2);
    this.registerOutput("uv", Types.Vector2);
    this.registerOutput("color", Types.Color4);
  }
  get glyphUV() { return this._inputs[0]!; }
  get uv() { return this._outputs[0]!; }
  get color() { return this._outputs[1]!; }
  override getClassName(): string { return "TextMaterialBlock"; }

  override isReady(mesh: AbstractMesh): boolean {
    return bindings.get(mesh)?.atlas?.isReady() ?? true;
  }

  override bind(effect: Effect, _material: NodeMaterial, mesh?: Mesh): void {
    const binding = mesh ? bindings.get(mesh) : undefined;
    effect.setTexture(this.sampler, binding?.atlas ?? this.fallback);
    effect.setFloat2(this.parameters, binding?.mode === "msdf" ? 2 : binding?.mode === "bitmap" ? 1 : 0, Math.max(0, binding?.outline ?? 0) * 0.08);
    effect.setFloat3(this.tint, ...(binding?.color ?? [1, 1, 1] as const));
    effect.setFloat3(this.stroke, ...(binding?.outlineColor ?? [0, 0, 0] as const));
    effect.setFloat4(this.atlasRect, ...(binding?.atlasRect ?? [0, 0, 1, 1] as const));
    effect.setFloat4(this.materialRect, ...(binding?.materialRect ?? [0, 0, 1, 1] as const));
    effect.setFloat(this.opacity, mesh?.visibility ?? 1);
  }

  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    if (!this.fallback) {
      this.fallback = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1,
        state.sharedData.nodeMaterial.getScene(), false, false, Texture.NEAREST_SAMPLINGMODE);
    }
    this.sampler = state._getFreeVariableName("textGlyphAtlas");
    this.parameters = state._getFreeVariableName("textGlyphParameters");
    this.tint = state._getFreeVariableName("textGlyphTint");
    this.stroke = state._getFreeVariableName("textGlyphStroke");
    this.atlasRect = state._getFreeVariableName("textAtlasRect");
    this.materialRect = state._getFreeVariableName("textMaterialRect");
    this.opacity = state._getFreeVariableName("textGlyphOpacity");
    // Each glyph binds its own atlas; the compiler also rebinds these values
    // through onBindObservable when Babylon skips frozen forced bindings.
    state.sharedData.forcedBindableBlocks.push(this);
    state.sharedData.blockingBlocks.push(this);
    state._emit2DSampler(this.sampler);
    state._emitUniformFromString(this.parameters, Types.Vector2);
    state._emitUniformFromString(this.tint, Types.Vector3);
    state._emitUniformFromString(this.stroke, Types.Vector3);
    state._emitUniformFromString(this.atlasRect, Types.Vector4);
    state._emitUniformFromString(this.materialRect, Types.Vector4);
    state._emitUniformFromString(this.opacity, Types.Float);
    const wgsl = state.shaderLanguage === 1;
    const uniform = wgsl ? "uniforms." : "";
    const params = uniform + this.parameters, tint = uniform + this.tint, stroke = uniform + this.stroke;
    const atlasRect = uniform + this.atlasRect, rect = uniform + this.materialRect;
    const vec4 = state._getShaderType(Types.Vector4);
    const sampled = state._getFreeVariableName("textGlyphSample");
    const distance = state._getFreeVariableName("textGlyphDistance");
    const pixel = state._getFreeVariableName("textGlyphPixel");
    const fill = state._getFreeVariableName("textGlyphFill");
    const outline = state._getFreeVariableName("textGlyphOutline");
    const uv = this.glyphUV.associatedVariableName;
    const sample = wgsl ? `textureSample(${this.sampler}, ${this.sampler}Sampler, ${uv})` : `texture2D(${this.sampler}, ${uv})`;
    if (!wgsl) state._emitExtension("derivatives", "#extension GL_OES_standard_derivatives : enable");
    state.compilationString += `${state._declareOutput(this.uv)} = ((${uv} - ${atlasRect}.xy) / ${atlasRect}.zw) * ${rect}.zw + ${rect}.xy;\n`;
    state.compilationString += `${state._declareLocalVar(sampled, Types.Vector4)} = ${sample};\n`;
    state.compilationString += `${state._declareOutput(this.color)} = ${vec4}(${tint}, 1.0);\n`;
    state.compilationString += `if (${params}.x > 0.5) { ${this.color.associatedVariableName} = ${sampled}; }\n`;
    // Evaluate derivatives uniformly, outside the per-glyph mode branch (WGSL).
    state.compilationString += `${state._declareLocalVar(distance, Types.Float)} = max(min(${sampled}.r, ${sampled}.g), min(max(${sampled}.r, ${sampled}.g), ${sampled}.b));\n`;
    state.compilationString += `${state._declareLocalVar(pixel, Types.Float)} = max(fwidth(${distance}) * 0.5, 0.0001);\n`;
    state.compilationString += `${state._declareLocalVar(fill, Types.Float)} = clamp((${distance} - 0.5) / ${pixel} + 0.5, 0.0, 1.0);\n`;
    state.compilationString += `${state._declareLocalVar(outline, Types.Float)} = clamp((${distance} - 0.5 + ${params}.y) / ${pixel} + 0.5, 0.0, 1.0);\n`;
    state.compilationString += `if (${params}.x > 1.5) { ${this.color.associatedVariableName} = ${vec4}(mix(${stroke}, ${tint}, ${fill}), max(${fill}, ${outline})); }\n`;
    state.compilationString += `${this.color.associatedVariableName}.a *= ${uniform}${this.opacity};\n`;
    return this;
  }

  override dispose(): void {
    this.fallback?.dispose();
    this.fallback = null;
    super.dispose();
  }
}
RegisterClass("BABYLON.TextMaterialBlock", TextMaterialBlock);
