import "./babylon-registrations";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { lowerParticleGraphDocument, type ParticleGraphDocument } from "@haptic/particle-graph";
import { createHeadlessEngine } from "./large-world";
import { realizeParticleGraph } from "./particle-graph-realize";
import { recordingParticleUpdateKernels } from "./particle-update-compiler";

/**
 * Every Particle Graph update kernel a game can build from `documents`, by key (`particleUpdateKernelKey`), for its
 * static scripts module. Each graph is realized as the player realizes it (its lowered plan, in World and Local space:
 * a Particle System picks either, and spawned systems use World) on a headless Engine, recording each kernel's source.
 * Editor-only (`@haptic/render/particle-kernel-export`).
 */
export function collectParticleUpdateKernels(documents: Iterable<ParticleGraphDocument>): Map<string, string> {
  const sources = new Map<string, string>();
  const updateKernels = recordingParticleUpdateKernels(sources);
  const engine = createHeadlessEngine();
  const scene = new Scene(engine);
  try {
    const emitter = new Mesh("particle-kernel-export", scene);
    for (const document of documents) {
      const lowered = lowerParticleGraphDocument(document);
      if (!lowered.ok) continue;
      for (const space of ["world", "local"] as const) {
        const realized = realizeParticleGraph(lowered.plan, { scene, name: "particle-kernel-export", emitter, space, updateKernels });
        if (realized.ok) realized.set.dispose();
      }
    }
  } finally {
    scene.dispose();
    engine.dispose();
  }
  return sources;
}
