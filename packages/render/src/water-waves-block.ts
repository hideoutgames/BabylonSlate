import { NodeMaterial, NodeMaterialBlock, NodeMaterialBlockTargets, NodeMaterialBlockConnectionPointTypes as Types, type AbstractMesh, type Effect, type Material, type Mesh, type NodeMaterialDefines } from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { meshVertexWaves, WATER_BLEND_DEFINE, WATER_CLOCK_UNIFORM, WATER_GPU_WAVES_DEFINE, WATER_SWELL_UNIFORMS, waterWaveBlockSource } from "./water-material";
import { declareWaterAttributes, isWaterSurfaceMesh, WATER_SURFACE_DEFINE } from "./water-surface-block";

/**
 * Gerstner waves for Custom Material water on the GPU, the counterpart of built-in shading's vertex swell
 * (`SLATE_WATER_GPU_WAVES`): a water mesh whose material holds this block keeps a static rest grid and uploads no vertex
 * data per frame, because this block's vertex code evaluates the same swell (`waterWaveBlockSource`) from the same uniforms
 * (`bindWaterSwellUniforms`). The graph applies it: Offset feeds World Position Offset, so every pass that compiles the
 * graph (depth pre-pass, shadows, outlines, captures) displaces identically, and Normal feeds the surface's normal, which
 * the rest grid does not carry. Meshes that are not such a water surface (a material preview, a mesh without the water
 * vertex data) get no displacement, Height and Simulation Time 0, and the world normal they came with.
 */
export class WaterWavesBlock extends NodeMaterialBlock {
  constructor(name: string) {
    super(name, NodeMaterialBlockTargets.Vertex);
    this.registerInput("worldPosition", Types.Vector4);
    this.registerInput("worldNormal", Types.Vector3, true);
    this.registerOutput("position", Types.Vector4);
    this.registerOutput("offset", Types.Vector3);
    this.registerOutput("height", Types.Float);
    this.registerOutput("normal", Types.Vector3);
    this.registerOutput("time", Types.Float);
  }
  /** The undisplaced world position of the vertex (the rest point), Vector 4. */
  get worldPosition() { return this._inputs[0]!; }
  /** The world normal passed through where the mesh is not water displaced by this block; Up when unconnected. */
  get worldNormal() { return this._inputs[1]!; }
  /** The displaced world position. */
  get position() { return this._outputs[0]!; }
  /** The displaced position less the rest position: the grid's recentring and the waves, for World Position Offset. */
  get offset() { return this._outputs[1]!; }
  /** Vertical displacement in metres, as the CPU mesh's `slateWaterData.x`. */
  get height() { return this._outputs[2]!; }
  /** World normal of the displaced surface. */
  get normal() { return this._outputs[3]!; }
  /** Simulation time in seconds, as the CPU mesh's `slateWaterData.w`. */
  get time() { return this._outputs[4]!; }
  override getClassName(): string { return "WaterWavesBlock"; }
  override prepareDefines(defines: NodeMaterialDefines, _material: NodeMaterial, mesh?: AbstractMesh): void {
    // The water mesh uploads its base normals with the data and flow it is recognised by, and only it registers a swell.
    const surface = isWaterSurfaceMesh(mesh), waves = surface && meshVertexWaves(mesh) !== null;
    defines.setValue(WATER_SURFACE_DEFINE, surface, true);
    defines.setValue(WATER_GPU_WAVES_DEFINE, waves, true);
    defines.setValue(WATER_BLEND_DEFINE, waves && mesh!.isVerticesDataPresent("slateWaterBlend"), true);
  }
  /** Binds the swell and the clock of the mesh being drawn, every draw: surfaces sharing a material have their own. */
  override bind(effect: Effect, material: NodeMaterial, mesh?: Mesh): void {
    meshVertexWaves(mesh)?.bind(effect, material.getScene(), mesh!);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state.sharedData.blocksWithDefines.push(this);
    state.sharedData.forcedBindableBlocks.push(this);
    const wgsl = state.shaderLanguage === 1, v3 = wgsl ? "vec3f" : "vec3";
    declareWaterAttributes(state, WATER_SURFACE_DEFINE, [["slateWaterData", 4], ["slateWaterBaseNormal", 3]]);
    declareWaterAttributes(state, WATER_BLEND_DEFINE, [["slateWaterBlend", 4]]);
    for (const name of [...WATER_SWELL_UNIFORMS, WATER_CLOCK_UNIFORM]) state._emitUniformFromString(name, Types.Vector4);
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
      // The swell's own `worldPos`: the rest point in, the displaced point out.
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
    return this;
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
