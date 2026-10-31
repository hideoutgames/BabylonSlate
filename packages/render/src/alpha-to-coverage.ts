import { Constants, Material, type AbstractEngine, type AbstractMesh, type Effect, type NodeMaterial } from "@babylonjs/core";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import { NodeMaterialBlockConnectionPointTypes as Types } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets as Targets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import { RegisterEnginesExtensionsEngineAlphaToCoverage } from "@babylonjs/core/Engines/Extensions/engine.alphaToCoverage.pure";
import { RegisterEnginesWebGPUExtensionsEngineAlphaToCoverage } from "@babylonjs/core/Engines/WebGPU/Extensions/engine.alphaToCoverage.pure";

/**
 * Alpha-to-coverage for alpha-tested surfaces under MSAA. A colour draw of a registered Material
 * (`registerAlphaToCoverage`) into a multisampled target turns the engine's alpha-to-coverage on, and its shader writes a
 * coverage alpha instead of discarding at the cutoff: the clip value sharpened to about one pixel around the cutoff
 * (`(value − cutoff) / fwidth(value) + 0.5`), so each sample keeps the surface where it lies inside the cutoff and
 * edges are smoothed like geometric ones. Every other draw (any other Material, a single-sample target, a blended
 * draw, a full-screen pass after an objects pass) runs with it off and discards below the cutoff as before.
 *
 * The shader picks by the uniform `hapticAlphaCoverage` (1 under MSAA), so turning MSAA on or off compiles nothing.
 */

/** Uniform the coverage clip reads: x 1 while the draw writes coverage. */
export const ALPHA_COVERAGE_UNIFORM = "hapticAlphaCoverage";

type CoverageEngine = AbstractEngine & {
  setAlphaToCoverage?(enable: boolean): void;
  getAlphaToCoverage?(): boolean;
  readonly currentSampleCount?: number;
};

/** Registered Materials, each with which of its meshes alpha-test (every mesh when omitted). */
const coverageMaterials = new WeakMap<Material, ((mesh: AbstractMesh) => boolean) | null>();
let installed = false;

/**
 * Whether this draw, of `mesh` with `material` into the bound target, writes coverage: a registered Material, for a
 * mesh it alpha-tests, into a multisampled target.
 */
export function drawsAlphaCoverage(engine: AbstractEngine, material: Material | null | undefined, mesh?: AbstractMesh): boolean {
  if (!material) return false;
  const accepts = coverageMaterials.get(material);
  if (accepts === undefined || (accepts && (!mesh || !accepts(mesh)))) return false;
  return ((engine as CoverageEngine).currentSampleCount ?? 1) > 1;
}

function install(): void {
  if (installed) return;
  installed = true;
  RegisterEnginesExtensionsEngineAlphaToCoverage();
  RegisterEnginesWebGPUExtensionsEngineAlphaToCoverage();
  // Every Material's bind ends here, once per draw: each draw sets the state its own Material needs.
  type AfterBind = (this: Material, mesh?: AbstractMesh, effect?: Effect | null, subMesh?: unknown) => void;
  const prototype = Material.prototype as unknown as { _afterBind: AfterBind };
  const afterBind = prototype._afterBind;
  prototype._afterBind = function (this: Material, mesh, effect, subMesh) {
    const engine = this.getScene().getEngine() as CoverageEngine;
    engine.setAlphaToCoverage?.(drawsAlphaCoverage(engine, this, mesh));
    afterBind.call(this, mesh, effect, subMesh);
  };
}

/**
 * Lets `material`'s colour draws use alpha-to-coverage under MSAA, for the meshes `accepts` (all when omitted); its
 * graph writes the coverage (`CoverageClipBlock`, or the unlit surface's own clip).
 */
export function registerAlphaToCoverage(material: Material, accepts?: (mesh: AbstractMesh) => boolean): void {
  install();
  coverageMaterials.set(material, accepts ?? null);
}

/** The coverage clip (GLSL or WGSL): `value` against `cutoff`, writing the coverage alpha last while the uniform says so. */
export function coverageClip(state: NodeMaterialBuildState, value: string, cutoff: string): void {
  state._emitUniformFromString(ALPHA_COVERAGE_UNIFORM, Types.Float);
  const wgsl = state.shaderLanguage === 1;
  const u = wgsl ? "uniforms." : "";
  const coverage = state._getFreeVariableName("hapticCoverage");
  // Derivatives first: WGSL takes them in uniform control flow.
  state.compilationString += `${state._declareLocalVar(coverage, Types.Float)} = clamp((${value} - ${cutoff}) / max(fwidth(${value}), 0.0001) + 0.5, 0.0, 1.0);\n`
    + `if (${u}${ALPHA_COVERAGE_UNIFORM} > 0.5) { if (${coverage} <= 0.0) { discard; } } else if (${value} < ${cutoff}) { discard; }\n`;
  // The geometry pass draws the Material too, into its own attachments (`PREPASS`), single-sample.
  state._injectAtEnd += `#ifndef PREPASS\nif (${u}${ALPHA_COVERAGE_UNIFORM} > 0.5) { ${wgsl ? "fragmentOutputs.color" : "gl_FragColor"}.a = ${coverage}; }\n#endif\n`;
}

/**
 * Turns alpha-to-coverage off on `engine`: after an objects pass (full-screen passes bind no Material) and before a
 * blended draw that binds none (sprites, particles), which set their own alpha mode.
 */
export function endAlphaToCoverage(engine: AbstractEngine): void {
  (engine as CoverageEngine).setAlphaToCoverage?.(false);
}

/** Ends alpha-to-coverage whenever `engine` starts blending: a blended draw never also writes coverage. */
export function guardAlphaToCoverageBlending(engine: AbstractEngine): void {
  const guarded = engine as AbstractEngine & { hapticCoverageGuard?: true };
  if (guarded.hapticCoverageGuard) return;
  guarded.hapticCoverageGuard = true;
  const setAlphaMode = engine.setAlphaMode.bind(engine);
  engine.setAlphaMode = (mode, ...rest) => {
    if (mode !== Constants.ALPHA_DISABLE) endAlphaToCoverage(engine);
    return setAlphaMode(mode, ...rest);
  };
}

/**
 * Fragment: an alpha clip. Below the cutoff it discards; in a colour variant (`coverage`) a draw that writes coverage
 * instead discards only outside the sharpened edge and writes the coverage alpha to the colour output last.
 */
export class CoverageClipBlock extends NodeMaterialBlock {
  /** Build-time: the colour variant, whose output alpha becomes the coverage. Pass variants only discard. */
  coverage = false;
  constructor(name: string) {
    super(name, Targets.Fragment, true);
    this.registerInput("value", Types.Float, true);
    this.registerInput("cutoff", Types.Float, true);
  }
  get value() { return this._inputs[0]!; }
  get cutoff() { return this._inputs[1]!; }
  override getClassName(): string { return "CoverageClipBlock"; }
  override bind(effect: Effect, nodeMaterial: NodeMaterial): void {
    if (this.coverage) effect.setFloat(ALPHA_COVERAGE_UNIFORM, drawsAlphaCoverage(nodeMaterial.getScene().getEngine(), nodeMaterial) ? 1 : 0);
  }
  protected override _buildBlock(state: NodeMaterialBuildState): this {
    super._buildBlock(state);
    state.sharedData.hints.needAlphaTesting = true;
    if (!this.cutoff.isConnected || !this.value.isConnected) return this;
    const value = this.value.associatedVariableName, cutoff = this.cutoff.associatedVariableName;
    if (!this.coverage) {
      state.compilationString += `if (${value} < ${cutoff}) { discard; }\n`;
      return this;
    }
    state.sharedData.forcedBindableBlocks.push(this);
    coverageClip(state, value, cutoff);
    return this;
  }
}
RegisterClass("BABYLON.CoverageClipBlock", CoverageClipBlock);
