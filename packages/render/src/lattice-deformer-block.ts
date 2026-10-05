import { NodeMaterialBlock, NodeMaterialBlockTargets, NodeMaterialBlockConnectionPointTypes as Types, NormalizeBlock, SubtractBlock, TransformBlock, VectorSplitterBlock, type AbstractMesh, type Effect, type Mesh, type NodeMaterial, type NodeMaterialDefines, type Scene } from "@babylonjs/core";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import type { MaterialPlumbing } from "./material-block-registry";
import { bindMeshLatticeDeformer, hasMeshLatticeDeformer } from "./lattice-deformer-binding";
import { LATTICE_UNIFORMS, latticeShaderDeclarations, latticeShaderFunctions } from "./lattice-deformer-shader";

export class LatticeDeformerBlock extends NodeMaterialBlock {
  constructor(name: string, private scene?: Scene) {
    super(name, NodeMaterialBlockTargets.Vertex);
    this.registerInput("position", Types.Vector4);
    this.registerInput("normal", Types.Vector4);
    this.registerInput("tangent", Types.Vector4, true);
    this.registerOutput("positionOut", Types.Vector4);
    this.registerOutput("normalOut", Types.Vector4);
    this.registerOutput("tangentOut", Types.Vector4);
  }
  get position() { return this._inputs[0]!; }
  get normal() { return this._inputs[1]!; }
  get tangent() { return this._inputs[2]!; }
  get positionOut() { return this._outputs[0]!; }
  get normalOut() { return this._outputs[1]!; }
  get tangentOut() { return this._outputs[2]!; }
  override getClassName(): string { return "LatticeDeformerBlock"; }
  override _deserialize(data: unknown, scene: Scene, rootUrl: string): void { super._deserialize(data, scene, rootUrl); this.scene = scene; }
  override prepareDefines(defines: NodeMaterialDefines, _material: NodeMaterial, mesh?: AbstractMesh): void {
    defines.setValue("SLATE_LATTICE", hasMeshLatticeDeformer(mesh), true);
  }
  override bind(effect: Effect, _material: NodeMaterial, mesh?: Mesh): void { bindMeshLatticeDeformer(effect, mesh); }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state.sharedData.blocksWithDefines.push(this);
    state.sharedData.forcedBindableBlocks.push(this);
    const scene = this.scene ?? state.sharedData.nodeMaterial.getScene();
    if (!scene) throw new Error("Lattice block requires its material scene.");
    for (const name of LATTICE_UNIFORMS) if (!state.uniforms.includes(name)) state.uniforms.push(name);
    if (!state.samplers.includes("latticeData")) {
      state.samplers.push("latticeData");
      state._samplerDeclaration += latticeShaderDeclarations(state.shaderLanguage);
    }
    state._emitFunction("slateLattice", latticeShaderFunctions(scene, state.shaderLanguage), "");
    const wgsl = state.shaderLanguage === 1, v4 = wgsl ? "vec4f" : "vec4";
    const position = this.position.associatedVariableName, normal = this.normal.associatedVariableName;
    const result = state._getFreeVariableName("slateLatticeResult");
    const outPosition = this.positionOut.associatedVariableName, outNormal = this.normalOut.associatedVariableName;
    state.compilationString += `${state._declareOutput(this.positionOut)} = ${position};\n${state._declareOutput(this.normalOut)} = ${normal};\n`;
    if (this.tangent.isConnected) state.compilationString += `${state._declareOutput(this.tangentOut)} = ${this.tangent.associatedVariableName};\n`;
    state.compilationString += `#ifdef SLATE_LATTICE\n${wgsl ? `var ${result}: SlateLatticeResult` : `SlateLatticeResult ${result}`} = slateLattice(${position}.xyz);\n${outPosition} = ${v4}(${result}.position,${position}.w);\n${outNormal} = ${v4}(slateLatticeNormal(${result}.jacobian,${normal}.xyz),${normal}.w);\n`;
    if (this.tangent.isConnected) state.compilationString += `${this.tangentOut.associatedVariableName} = ${v4}(slateLatticeTangent(${result}.jacobian,${this.tangent.associatedVariableName}.xyz,${outNormal}.xyz),${this.tangent.associatedVariableName}.w);\n`;
    state.compilationString += "#endif\n";
    return this;
  }
}
RegisterClass("BABYLON.LatticeDeformerBlock", LatticeDeformerBlock);

/** Called once after authored WPO; later graph taps see final geometry. */
export function applyLatticeDeformerPlumbing(name: string, created: NodeMaterialBlock[], plumbing: MaterialPlumbing, scene: Scene, includeTangent = false): void {
  if (!plumbing.worldPosition || !plumbing.worldNormal4) return;
  const block = new LatticeDeformerBlock(`${name}_lattice`, scene);
  plumbing.worldPosition.connectTo(block.position); plumbing.worldNormal4.connectTo(block.normal);
  if (includeTangent && plumbing.localTangent && plumbing.world) {
    const tangent = new TransformBlock(`${name}_latticeTangent`); tangent.complementW = 0;
    const source = new VectorSplitterBlock(`${name}_latticeLocalTangent`);
    plumbing.localTangent.connectTo(source.xyzw); source.xyzOut.connectTo(tangent.vector); plumbing.world.connectTo(tangent.transform);
    tangent.output.connectTo(block.tangent); created.push(source, tangent);
    const split = new VectorSplitterBlock(`${name}_latticeTangentSplit`);
    block.tangentOut.connectTo(split.xyzw); plumbing.worldTangent = split.xyzOut; created.push(split);
  }
  const normal = new VectorSplitterBlock(`${name}_latticeNormal`);
  block.normalOut.connectTo(normal.xyzw);
  plumbing.worldPosition = block.positionOut; plumbing.worldNormal4 = block.normalOut; plumbing.worldNormal = normal.xyzOut;
  created.push(block, normal);
  if (plumbing.cameraPosition) {
    const position = new VectorSplitterBlock(`${name}_latticePosition`);
    const difference = new SubtractBlock(`${name}_latticeViewDifference`), direction = new NormalizeBlock(`${name}_latticeViewDirection`);
    block.positionOut.connectTo(position.xyzw); plumbing.cameraPosition.connectTo(difference.left); position.xyzOut.connectTo(difference.right);
    difference.output.connectTo(direction.input); plumbing.viewDirection = direction.output;
    created.push(position, difference, direction);
  }
}
