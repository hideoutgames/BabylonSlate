import {
  NodeMaterial, NodeMaterialBlock, NodeMaterialBlockTargets, NodeMaterialBlockConnectionPointTypes as Types, ShaderLanguage, type AbstractMesh, type Effect,
  type Material, type Mesh, type NodeMaterialDefines,
} from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import {
  meshVertexWaves, WATER_BLEND_DEFINE, WATER_CLOCK_UNIFORM, WATER_EYE_UNIFORM, WATER_FFT_DEFINE, WATER_FFT_SAMPLER, WATER_FOAM_SAMPLER, WATER_GPU_WAVES_DEFINE,
  WATER_NODE_FOAM_UNIFORM, WATER_NODE_SUN_UNIFORM, WATER_NODE_VARYING, WATER_VERTEX_WAVE_UNIFORMS, waterWaveBlockSource, waterWaveNodeSources,
} from "./water-material";
import { declareWaterAttributes, isWaterSurfaceMesh, WATER_SURFACE_DEFINE } from "./water-surface-block";

/** Varyings of the rest point and world normal the fragment stage samples the spectrum at. */
const WATER_NODE_REST_VARYING = "vSlateWaterRest";
const WATER_NODE_NORMAL_VARYING = "vSlateWaterRestNormal";

/** Declares a 2D-array sampler once per stage, under `SLATE_WATER_GPU_WAVES` (high precision: GLSL ES has no default). */
function declareArraySampler(state: NodeMaterialBuildState, name: string): void {
  if (state.samplers.includes(name)) return;
  state.samplers.push(name);
  state._samplerDeclaration += `#ifdef ${WATER_GPU_WAVES_DEFINE}\n${state.shaderLanguage === ShaderLanguage.WGSL
    ? `var ${name}Sampler: sampler;\nvar ${name}: texture_2d_array<f32>;`
    : `uniform highp sampler2DArray ${name};`}\n#endif\n`;
}

/**
 * The FFT ocean for Custom Material water on the GPU, the counterpart of built-in shading's waves: a water mesh whose
 * material holds this block keeps a static rest grid and uploads no vertex data per frame. Its vertex stage displaces
 * the rest point with the same source as built-in shading (`waterWaveBlockSource`) from the same uniforms
 * (`WaterVertexWaves.bind`): Offset feeds World Position Offset, so every pass that compiles the graph (depth pre-pass,
 * shadows, outlines, captures) displaces identically. Its fragment stage samples every cascade per pixel as built-in
 * water does (`waterWaveNodeSources`): Normal (the displaced surface's, from the spectrum's slopes over the mesh's base
 * normal), Wave Height, Crest Foam (FFT-Ocean's whitecaps from the persistent turbulence, with the asset's Crest
 * Foam and Foam Amount) and Subsurface (FFT-Ocean's light through the crests, with the asset's Subsurface). A vertex
 * consumer of Normal or Wave Height reads the vertex's values instead. Meshes that are not such a water surface (a material preview, a mesh without the water vertex data) get no displacement, Height,
 * Crest Foam, Subsurface and Simulation Time 0, and the world normal they came with.
 */
export class WaterWavesBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.VertexAndFragment);
    this.registerInput("worldPosition", Types.Vector4);
    this.registerInput("worldNormal", Types.Vector3, true);
    this.registerOutput("position", Types.Vector4, NodeMaterialBlockTargets.Vertex);
    this.registerOutput("offset", Types.Vector3, NodeMaterialBlockTargets.Vertex);
    this.registerOutput("height", Types.Float);
    this.registerOutput("normal", Types.Vector3);
    this.registerOutput("time", Types.Float);
    this.registerOutput("crestFoam", Types.Float, NodeMaterialBlockTargets.Fragment);
    this.registerOutput("subsurface", Types.Float, NodeMaterialBlockTargets.Fragment);
  }
  /** The undisplaced world position of the vertex (the rest point), Vector 4. */
  get worldPosition() { return this._inputs[0]!; }
  /** The world normal passed through where the mesh is not water displaced by this block; Up when unconnected. */
  get worldNormal() { return this._inputs[1]!; }
  /** The displaced world position. */
  get position() { return this._outputs[0]!; }
  /** The displaced position less the rest position: the grid's recentring and the waves, for World Position Offset. */
  get offset() { return this._outputs[1]!; }
  /** Vertical displacement in metres. */
  get height() { return this._outputs[2]!; }
  /** World normal of the displaced surface. */
  get normal() { return this._outputs[3]!; }
  /** Simulation time in seconds. */
  get time() { return this._outputs[4]!; }
  /** Whitecap coverage (0-1). */
  get crestFoam() { return this._outputs[5]!; }
  /** Light scattered through the crests toward a viewer facing the sun, times the asset's Subsurface (built-in water adds Shallow Color times it). */
  get subsurface() { return this._outputs[6]!; }
  override getClassName(): string { return "WaterWavesBlock"; }
  override prepareDefines(defines: NodeMaterialDefines, _material: NodeMaterial, mesh?: AbstractMesh): void {
    // The water mesh uploads its base normals with the data and flow it is recognised by, and only it registers waves.
    const surface = isWaterSurfaceMesh(mesh), waves = surface ? meshVertexWaves(mesh) : null;
    defines.setValue(WATER_SURFACE_DEFINE, surface, true);
    defines.setValue(WATER_GPU_WAVES_DEFINE, waves !== null, true);
    defines.setValue(WATER_BLEND_DEFINE, waves !== null && mesh!.isVerticesDataPresent("slateWaterBlend"), true);
    defines.setValue(WATER_FFT_DEFINE, waves ? waves.cascades(mesh!.getScene()) : 1, true);
  }
  /** Binds the waves, the spectrum and the clock of the mesh being drawn, every draw: surfaces sharing a material have their own. */
  override bind(effect: Effect, material: NodeMaterial, mesh?: Mesh): void {
    meshVertexWaves(mesh)?.bind(effect, material.getScene(), mesh!);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state.sharedData.blocksWithDefines.push(this);
    state.sharedData.forcedBindableBlocks.push(this);
    if (state.target === NodeMaterialBlockTargets.Fragment) this.buildFragment(state);
    else this.buildVertex(state);
    return this;
  }
  /** The displacement and the vertex's own height, normal and time. */
  private buildVertex(state: NodeMaterialBuildState): void {
    const wgsl = state.shaderLanguage === ShaderLanguage.WGSL, v3 = wgsl ? "vec3f" : "vec3";
    this.declareVertexInputs(state);
    const rest = this.worldPosition.associatedVariableName, normal = this.worldNormal.isConnected ? this.worldNormal.associatedVariableName : `${v3}(0.0, 1.0, 0.0)`;
    const [position, offset, height, outNormal, time] = this._outputs.map((output) => output.associatedVariableName) as [string, string, string, string, string];
    state.compilationString += [
      `${state._declareOutput(this.position)} = ${rest};`,
      `${state._declareOutput(this.offset)} = ${v3}(0.0);`,
      `${state._declareOutput(this.height)} = 0.0;`,
      `${state._declareOutput(this.normal)} = ${normal};`,
      `${state._declareOutput(this.time)} = 0.0;`,
      `#ifdef ${WATER_GPU_WAVES_DEFINE}`,
      "{",
      // The waves' own `worldPos`: the rest point in, the displaced point out.
      wgsl ? `var worldPos: vec4f = ${rest};` : `vec4 worldPos = ${rest};`,
      waterWaveBlockSource(state.shaderLanguage),
      `${position} = worldPos;`,
      `${offset} = worldPos.xyz - ${rest}.xyz;`,
      `${height} = swvH;`,
      `${outNormal} = swvNormal;`,
      `${time} = ${wgsl ? "uniforms." : ""}${WATER_CLOCK_UNIFORM}.x;`,
      "}",
      "#endif",
      "",
    ].join("\n");
  }
  /** Attributes, uniforms and the spectrum's sampler of the vertex stage (the displacement and the fragment's varying). */
  private declareVertexInputs(state: NodeMaterialBuildState): void {
    declareWaterAttributes(state, WATER_SURFACE_DEFINE, [["slateWaterData", 4], ["slateWaterBaseNormal", 3]]);
    declareWaterAttributes(state, WATER_BLEND_DEFINE, [["slateWaterBlend", 4]]);
    for (const name of [...WATER_VERTEX_WAVE_UNIFORMS, WATER_CLOCK_UNIFORM, WATER_EYE_UNIFORM]) state._emitUniformFromString(name, Types.Vector4);
    declareArraySampler(state, WATER_FFT_SAMPLER);
    state._emitFunction("swFftTapLod", waterWaveNodeSources(state.shaderLanguage).vertexHelpers, "");
  }
  /**
   * The fragment's per-pixel normal, height, crest foam and subsurface light. The vertex stage hands over the bank and blend shares through
   * `WATER_NODE_VARYING` (written into the vertex program from here, so a graph that reads only fragment outputs still
   * gets it); the rest point and the base normal arrive as the inputs' own varyings.
   */
  private buildFragment(state: NodeMaterialBuildState): void {
    const wgsl = state.shaderLanguage === ShaderLanguage.WGSL, v3 = wgsl ? "vec3f" : "vec3", sources = waterWaveNodeSources(state.shaderLanguage);
    const vertex = state._vertexState;
    this.declareVertexInputs(vertex);
    if (vertex._emitVaryingFromString(WATER_NODE_VARYING, Types.Vector4, WATER_GPU_WAVES_DEFINE)) {
      vertex.compilationString += `${sources.varying(`${wgsl ? "vertexOutputs." : ""}${WATER_NODE_VARYING}`)}\n`;
    }
    state._emitVaryingFromString(WATER_NODE_VARYING, Types.Vector4, WATER_GPU_WAVES_DEFINE);
    for (const name of [...WATER_VERTEX_WAVE_UNIFORMS, WATER_CLOCK_UNIFORM, WATER_EYE_UNIFORM, WATER_NODE_FOAM_UNIFORM, WATER_NODE_SUN_UNIFORM]) state._emitUniformFromString(name, Types.Vector4);
    declareArraySampler(state, WATER_FFT_SAMPLER);
    declareArraySampler(state, WATER_FOAM_SAMPLER);
    state._emitFunction("swSpecTap", sources.fragmentHelpers, "");
    // Babylon adds no varying for a vertex-and-fragment block's inputs: the vertex stage hands over the rest point and the
    // world normal itself (its inputs are vertex values, in scope at the end of the vertex program).
    const into = wgsl ? "vertexOutputs." : "", from = wgsl ? "fragmentInputs." : "";
    if (vertex._emitVaryingFromString(WATER_NODE_REST_VARYING, Types.Vector4)) {
      vertex.compilationString += `${into}${WATER_NODE_REST_VARYING} = ${this.worldPosition.associatedVariableName};\n`;
    }
    state._emitVaryingFromString(WATER_NODE_REST_VARYING, Types.Vector4);
    const rest = `${from}${WATER_NODE_REST_VARYING}`;
    let worldNormal = `${v3}(0.0, 1.0, 0.0)`;
    if (this.worldNormal.isConnected) {
      if (vertex._emitVaryingFromString(WATER_NODE_NORMAL_VARYING, Types.Vector3)) {
        vertex.compilationString += `${into}${WATER_NODE_NORMAL_VARYING} = ${this.worldNormal.associatedVariableName};\n`;
      }
      state._emitVaryingFromString(WATER_NODE_NORMAL_VARYING, Types.Vector3);
      worldNormal = `${from}${WATER_NODE_NORMAL_VARYING}`;
    }
    const base = this.worldNormal.isConnected ? `normalize(${worldNormal})` : worldNormal;
    const declare = (output: (typeof this._outputs)[number], value: string) => output.hasEndpoints ? `${state._declareOutput(output)} = ${value};\n` : "";
    const local = (name: string, type: string, value: string) => wgsl ? `var ${name}: ${type} = ${value};\n` : `${type} ${name} = ${value};\n`;
    state.compilationString += local("swnNormal", v3, worldNormal)
      + local("swnHeight", wgsl ? "f32" : "float", "0.0") + local("swnFoam", wgsl ? "f32" : "float", "0.0") + local("swnSubsurface", wgsl ? "f32" : "float", "0.0")
      + `${sources.fragment(rest, base, `${from}${WATER_NODE_VARYING}`)}\n`
      + declare(this.height, "swnHeight") + declare(this.normal, "swnNormal") + declare(this.crestFoam, "swnFoam") + declare(this.subsurface, "swnSubsurface")
      + declare(this.time, `${wgsl ? "uniforms." : ""}${WATER_CLOCK_UNIFORM}.x`);
  }
}
RegisterClass("BABYLON.WaterWavesBlock", WaterWavesBlock);

/**
 * Whether a material's compiled graph holds a Water Waves node, which puts its water mesh on the GPU path. Only a built
 * material says so: its blocks are attached when it builds.
 */
export function materialHasWaterWaves(material: Material | null | undefined): boolean {
  return material instanceof NodeMaterial && material.attachedBlocks.some((block) => block instanceof WaterWavesBlock);
}
