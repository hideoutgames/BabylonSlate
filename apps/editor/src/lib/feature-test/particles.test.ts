import { afterEach, describe, expect, it, vi } from "vitest";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Particle } from "@babylonjs/core/Particles/particle";
import { lowerParticleGraphDocument, validateParticleGraphDocument, type ParticleGraphDocument } from "@haptic/particle-graph";
import { realizeParticleGraph } from "@haptic/render";
import { createTestEngine } from "@haptic/render/test-engine";
import "@haptic/render/light-block-engine";
import { glowGraph, sheetFlipbookGraph, surfaceSparksGraph } from "./particles";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

/**
 * `graph` built with or without the compiled update, run for `frames` seeded 1/60 s steps: every live particle's state,
 * the random generator's final state and how many particles died.
 */
function seededRun(graph: ParticleGraphDocument, compileUpdate: boolean, frames: number) {
  const { scene, engine } = createTestEngine();
  cleanups.push(() => { scene.dispose(); engine.dispose(); });
  const lowered = lowerParticleGraphDocument(graph);
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const emitter = MeshBuilder.CreateSphere("emitter", { diameter: 1 }, scene);
  const result = realizeParticleGraph(lowered.plan, { scene, name: graph.name, emitter, space: "world", compileUpdate });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  cleanups.push(() => result.set.dispose());
  let seed = 12345;
  let deaths = 0;
  const owner = result.system as unknown as { recycleParticle: (particle: Particle) => void; _particles: Particle[] };
  const recycle = owner.recycleParticle;
  owner.recycleParticle = (particle) => { deaths += 1; recycle(particle); };
  const random = vi.spyOn(Math, "random").mockImplementation(() => (seed = (seed * 16807) % 2147483647) / 2147483647);
  try {
    result.system.start(0);
    // Pre-warm steps: the readiness texture of a headless Engine never loads, so a drawn step never simulates.
    for (let frame = 0; frame < frames; frame++) result.system.animate(true);
  } finally {
    random.mockRestore();
  }
  return {
    particles: owner._particles.map((p) => [p.position.asArray(), p.direction.asArray(), p.color.asArray(), p.size, p.angle,
      p.scale.asArray(), p.age, p.lifeTime, p.cellIndex]),
    seed,
    deaths,
  };
}

describe("Feature Test Particle Graphs", () => {
  it("builds the flipbook and the surface sparks with no validation warnings and every authoring node on the spine", () => {
    const graphs = [sheetFlipbookGraph("FT_FxSheetGraph", "mat-sheet"), surfaceSparksGraph("FT_FxSurfaceSparksGraph", "mat-glow", "em-flash")];
    for (const graph of graphs) {
      expect(validateParticleGraphDocument(graph).map((entry) => `${entry.code} ${entry.nodeId ?? ""}`)).toEqual([]);
      expect(lowerParticleGraphDocument(graph).ok).toBe(true);
    }
    const types = new Set(graphs.flatMap((graph) => graph.nodes.map((node) => node.type)));
    for (const type of ["sprite.setup", "update.basicSprite", "shape.mesh", "update.noise", "math.nlerp", "utility.localVariable",
      "update.angleDegrees", "trigger.spawn"]) expect(types.has(type), type).toBe(true);
    const spawn = graphs[1]!.nodes.find((node) => node.type === "trigger.spawn")!;
    expect(spawn.properties).toMatchObject({ emitterGuid: "em-flash", limit: 4, minInterval: 0.25 });
    // On Death: a Condition node drives Spawn Emitter's Condition.
    const condition = graphs[1]!.edges.find((edge) => edge.targetNodeId === spawn.id && edge.targetPinId === "condition")!;
    expect(graphs[1]!.nodes.find((node) => node.id === condition.sourceNodeId)!.type).toBe("logic.condition");
  });

  it.each([
    ["glow", () => glowGraph("FT_FxGlowGraph", "mat-glow", "ft-globals")],
    ["flipbook", () => sheetFlipbookGraph("FT_FxSheetGraph", "mat-sheet")],
    ["surface sparks", () => surfaceSparksGraph("FT_FxSurfaceSparksGraph", "mat-glow", "em-flash")],
  ])("simulates the %s graph with its compiled update exactly as with Babylon's own closures", (_name, graph) => {
    // Five seconds: longer than every one of their lifetimes, so particles die.
    const compiled = seededRun(graph(), true, 300);
    const babylon = seededRun(graph(), false, 300);
    expect(babylon.deaths).toBeGreaterThan(0);
    expect(compiled.particles.length).toBeGreaterThan(0);
    expect(compiled).toEqual(babylon);
  });
});
