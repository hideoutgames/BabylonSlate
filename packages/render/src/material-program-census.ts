import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";

/**
 * The Material compiler's builds on one Engine against the GPU programs they need: how much program sharing
 * (`shareCompiledProgram`) saves, and what still compiles twice. A program here is a build id (one vertex and fragment
 * source); each one is further multiplied by the mesh defines it draws with (`ProgramInventory.mostVariants`).
 */
export type MaterialProgramCensus = {
  /** Live NodeMaterials the Material compiler built: Materials, Instances and private copies, surface and water variants. */
  builds: number;
  /** Distinct programs (build ids) among them. */
  programs: number;
  /** Builds, since the Engine's first, that adopted an earlier build's program instead of compiling their own. */
  adopted: number;
  /** Rebuilds (a texture arriving) whose shader text was the same as the build before: each a program compiled again. */
  sameShaderRebuilds: number;
};

type Census = { builds: Set<NodeMaterial>; adopted: number; sameShaderRebuilds: number };

const censuses = new WeakMap<AbstractEngine, Census>();

function censusOf(engine: AbstractEngine): Census {
  let census = censuses.get(engine);
  if (!census) censuses.set(engine, (census = { builds: new Set(), adopted: 0, sameShaderRebuilds: 0 }));
  return census;
}

/** Counts `material`, a compiled build, until it is disposed. */
export function noteMaterialBuild(material: NodeMaterial): void {
  const census = censusOf(material.getScene().getEngine());
  census.builds.add(material);
  material.onDisposeObservable.addOnce(() => census.builds.delete(material));
}

/** A build took an earlier build's program. */
export function noteAdoptedProgram(engine: AbstractEngine): void {
  censusOf(engine).adopted += 1;
}

/** A rebuild produced the shader text its material already had, under a new build id. */
export function noteSameShaderRebuild(engine: AbstractEngine): void {
  censusOf(engine).sameShaderRebuilds += 1;
}

export function materialProgramCensus(engine: AbstractEngine): MaterialProgramCensus {
  const census = censuses.get(engine);
  if (!census) return { builds: 0, programs: 0, adopted: 0, sameShaderRebuilds: 0 };
  const programs = new Set<number>();
  for (const material of census.builds) programs.add(material.buildId);
  return { builds: census.builds.size, programs: programs.size, adopted: census.adopted, sameShaderRebuilds: census.sameShaderRebuilds };
}
