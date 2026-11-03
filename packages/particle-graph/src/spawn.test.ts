import { describe, expect, it } from "vitest";
import { createDefaultParticleGraphDocument, newParticleNodeProperties, normalizeParticleGraphDocument, type ParticleGraphNode } from "./document";
import { lowerParticleGraphDocument } from "./lower";
import { particleGraphSpawnEmitters, particleSpawnSettings, withParticleSpawnPreset } from "./spawn";
import { validateParticleGraphDocument } from "./validate";

const spawnNode = (id: string, properties: Record<string, unknown> = {}): ParticleGraphNode =>
  ({ id, type: "trigger.spawn", position: { x: 600, y: 0 }, properties: { ...newParticleNodeProperties("trigger.spawn"), ...properties } });

/** The default graph with a Spawn Emitter spliced into its spine before Update Color. */
function withSpawn(properties: Record<string, unknown> = {}) {
  const doc = createDefaultParticleGraphDocument();
  doc.materialGuid = "mat";
  doc.nodes.push(spawnNode("spawn", properties));
  doc.edges = doc.edges.filter((edge) => edge.id !== "e-velocity-color").concat(
    { id: "v-s", sourceNodeId: "velocity", sourcePinId: "out", targetNodeId: "spawn", targetPinId: "particle" },
    { id: "s-c", sourceNodeId: "spawn", sourcePinId: "out", targetNodeId: "updateColor", targetPinId: "particle" },
  );
  return doc;
}

describe("Spawn Emitter", () => {
  it("normalizes its settings and lists the emitters a graph spawns", () => {
    expect(newParticleNodeProperties("trigger.spawn")).toEqual({ emitterGuid: null, limit: 8, minInterval: 0, inheritVelocity: false });
    expect(particleSpawnSettings({ emitterGuid: "  ", limit: 0.4, minInterval: -1, inheritVelocity: "yes" }))
      .toEqual({ emitterGuid: null, limit: 1, minInterval: 0, inheritVelocity: false });
    expect(particleSpawnSettings({ emitterGuid: "a", limit: 900, minInterval: 99, inheritVelocity: true }))
      .toEqual({ emitterGuid: "a", limit: 64, minInterval: 60, inheritVelocity: true });
    const doc = normalizeParticleGraphDocument({ nodes: [spawnNode("x", { emitterGuid: "b", limit: 3.6 }), spawnNode("y", { emitterGuid: "a" }), spawnNode("z")] });
    expect(doc.nodes.find((node) => node.id === "x")!.properties.limit).toBe(4);
    expect(particleGraphSpawnEmitters(doc.nodes)).toEqual(["a", "b"]);
  });

  it("wires On Death and On Spawn into Condition, replacing what fed it, and lowers", () => {
    const base = withSpawn({ emitterGuid: "spark" });
    base.nodes.push({ id: "one", type: "const.float", position: { x: 0, y: 0 }, properties: { value: [1] } });
    base.edges.push({ id: "one-c", sourceNodeId: "one", sourcePinId: "out", targetNodeId: "spawn", targetPinId: "condition" });
    const death = withParticleSpawnPreset(base, "spawn", "death");
    const into = death.edges.filter((edge) => edge.targetNodeId === "spawn" && edge.targetPinId === "condition");
    expect(into).toHaveLength(1);
    const condition = death.nodes.find((node) => node.id === into[0]!.sourceNodeId)!;
    expect(condition).toMatchObject({ type: "logic.condition", properties: { test: "greaterOrEqual", "default:b": [1] } });
    const a = death.edges.find((edge) => edge.targetNodeId === condition.id && edge.targetPinId === "a")!;
    expect(death.nodes.find((node) => node.id === a.sourceNodeId)!.type).toBe("input.contextual.normalizedAge");
    expect(lowerParticleGraphDocument(death).ok).toBe(true);

    const spawn = withParticleSpawnPreset(death, "spawn", "spawn");
    const test = spawn.nodes.find((node) => node.id === spawn.edges.find((edge) => edge.targetNodeId === "spawn" && edge.targetPinId === "condition")!.sourceNodeId)!;
    expect(test.properties.test).toBe("lessOrEqual");
    const inputs = spawn.edges.filter((edge) => edge.targetNodeId === test.id).map((edge) => [edge.targetPinId, spawn.nodes.find((node) => node.id === edge.sourceNodeId)!.type]);
    expect(Object.fromEntries(inputs)).toEqual({ a: "input.contextual.age", b: "input.system.deltaTime" });
    expect(new Set(spawn.nodes.map((node) => node.id)).size).toBe(spawn.nodes.length);
    expect(lowerParticleGraphDocument(spawn).ok).toBe(true);
    expect(withParticleSpawnPreset(spawn, "updateColor", "death")).toBe(spawn);
  });

  it("warns without an Emitter or with one the project lacks, and stops cycles and deep chains", () => {
    const codes = (properties: Record<string, unknown>, context: Parameters<typeof validateParticleGraphDocument>[1] = {}) =>
      validateParticleGraphDocument(withSpawn(properties), context).filter((entry) => entry.nodeId === "spawn").map((entry) => [entry.code, entry.severity]);
    expect(codes({})).toEqual([["particle.spawnEmitterMissing", "warning"]]);
    expect(codes({ emitterGuid: "spark" })).toEqual([]);
    const graphs: Record<string, readonly string[]> = { self: ["me"], chainA: ["chainB"], chainB: ["chainC"], chainC: [], loopA: ["loopB"], loopB: ["loopA"] };
    const context = {
      documentGuid: "me",
      spawnEmitter: (guid: string) => guid === "spark" ? { kind: "basic" as const } : graphs[guid] ? { kind: "graph" as const, spawns: graphs[guid]! } : null,
    };
    expect(codes({ emitterGuid: "spark" }, context)).toEqual([]);
    expect(codes({ emitterGuid: "gone" }, context)).toEqual([["particle.spawnEmitterUnknown", "warning"]]);
    expect(codes({ emitterGuid: "me" }, context)).toEqual([["particle.spawnCycle", "error"]]);
    expect(codes({ emitterGuid: "self" }, context)).toEqual([["particle.spawnCycle", "error"]]);
    expect(codes({ emitterGuid: "loopA" }, context)).toEqual([["particle.spawnCycle", "error"]]);
    expect(codes({ emitterGuid: "chainB" }, context)).toEqual([]);
    expect(codes({ emitterGuid: "chainA" }, context)).toEqual([["particle.spawnDepth", "warning"]]);
  });
});
