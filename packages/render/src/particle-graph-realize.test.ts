import { GPUParticleSystem, MeshBuilder, ParticleSystem, UpdateSizeBlock, type Mesh, type Scene } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARTICLE_UPDATE_SPEED, type ParticleSpace } from "@haptic/core";
import {
  PARTICLE_CATALOG,
  createDefaultParticleGraphDocument,
  lowerParticleGraphDocument,
  newParticleNodeProperties,
  particleNodeDefinitionFor,
  resizeParticleValue,
  type ParticleBuildPlan,
  type ParticleGraphDocument,
  type ParticleGraphNode,
  type ParticleGraphSettings,
  type ParticleNumericType,
} from "@haptic/particle-graph";
import { createTestEngine } from "./create-null-engine";
import { PARTICLE_BLOCK_ADAPTERS, type ParticleBlockAdapter } from "./particle-graph-blocks";
import { realizeParticleGraph, type RealizeParticleGraphResult } from "./particle-graph-realize";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function host(): { scene: Scene; emitter: Mesh } {
  const handle = createTestEngine();
  cleanups.push(() => { handle.scene.dispose(); handle.engine.dispose(); });
  return { scene: handle.scene, emitter: MeshBuilder.CreateBox("emitter", { size: 0.01 }, handle.scene) };
}

function node(id: string, type: string, properties: Record<string, unknown> = {}): ParticleGraphNode {
  return { id, type, position: { x: 0, y: 0 }, properties: { ...newParticleNodeProperties(type), ...properties } };
}

function edge(sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string) {
  return { id: `${sourceNodeId}.${sourcePinId}->${targetNodeId}.${targetPinId}`, sourceNodeId, sourcePinId, targetNodeId, targetPinId };
}

/** The default graph with `nodes` spliced into the spine after Apply Velocity and `edges` added. */
function withSpine(spine: ParticleGraphNode[], extra: ParticleGraphNode[] = [], edges: ReturnType<typeof edge>[] = []): ParticleGraphDocument {
  const doc = createDefaultParticleGraphDocument();
  doc.edges = doc.edges.filter((entry) => entry.id !== "e-velocity-color");
  let previous = "velocity";
  for (const entry of spine) {
    doc.edges.push(edge(previous, "out", entry.id, "particle"));
    previous = entry.id;
  }
  doc.edges.push(edge(previous, "out", "updateColor", "particle"), ...edges);
  doc.nodes.push(...spine, ...extra);
  return doc;
}

function planOf(doc: ParticleGraphDocument, settings: Partial<ParticleGraphSettings> = {}): ParticleBuildPlan {
  const lowered = lowerParticleGraphDocument({ ...doc, settings: { ...doc.settings, ...settings } });
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  return lowered.plan;
}

function realize(plan: ParticleBuildPlan, space: ParticleSpace = "world", adapters?: Record<string, ParticleBlockAdapter>) {
  const { scene, emitter } = host();
  const result = realizeParticleGraph(plan, { scene, name: "graph", emitter, space, adapters });
  return { scene, emitter, result };
}

function built(result: RealizeParticleGraphResult) {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  cleanups.push(() => result.set.dispose());
  return result;
}

/** One 1/60 s CPU step (NullEngine's readiness texture never becomes ready, so render never simulates). */
function step(system: ParticleSystem, frames = 1): void {
  for (let i = 0; i < frames; i += 1) system.animate(true);
}

describe("realizeParticleGraph", () => {
  it("builds the default graph into a CPU system in seconds that owns its readiness texture", async () => {
    const { emitter, result } = realize(planOf(createDefaultParticleGraphDocument()));
    const { system } = built(result);
    expect(system).toBeInstanceOf(ParticleSystem);
    expect(system).not.toBeInstanceOf(GPUParticleSystem);
    expect(system.updateSpeed).toBe(PARTICLE_UPDATE_SPEED);
    expect(system.emitter).toBe(emitter);
    expect(system.particleTexture?.name).toBe("slate:particleReadiness");
    expect(system.isReady()).toBe(false);
    // The readiness texture is the only thing NullEngine keeps from becoming ready.
    system.particleTexture!.isReady = () => true;
    await vi.waitFor(() => expect(system.isReady()).toBe(true));
    // Default emit rate 30 /s: half a second of simulation spawns about 15 particles.
    system.start(0);
    step(system, 30);
    expect(system.getActiveCount()).toBeGreaterThanOrEqual(13);
    expect(system.getActiveCount()).toBeLessThanOrEqual(15);
  });

  it("fades the default graph from Create Particle's Color instead of white", () => {
    const doc = createDefaultParticleGraphDocument();
    doc.nodes = doc.nodes.map((entry) => entry.id === "create"
      ? { ...entry, properties: { ...entry.properties, "default:color": [0, 0, 1, 1] } } : entry);
    const { system } = built(realize(planOf(doc)).result);
    system.start(0);
    step(system, 10);
    // The oldest particle is about a tenth through its 1.5 s life: blue scaled by the white-to-black Gradient.
    const [red, green, blue, alpha] = system.particles[0]!.color.asArray();
    expect([red, green]).toEqual([0, 0]);
    expect(blue).toBeGreaterThan(0.8);
    expect(blue).toBeLessThan(1);
    expect(alpha).toBeCloseTo(blue!, 6);
  });

  it("adds exactly its own readiness texture and releases every system and texture with the set", () => {
    const { scene, emitter } = host();
    const baseline = { textures: scene.textures.length, systems: scene.particleSystems.length };
    const result = realizeParticleGraph(planOf(createDefaultParticleGraphDocument()), { scene, name: "graph", emitter, space: "world" });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    // The empty texture source block created no texture of its own.
    expect(scene.textures.slice(baseline.textures)).toEqual([result.system.particleTexture]);
    expect(scene.particleSystems.length).toBe(baseline.systems + 1);
    result.set.dispose();
    expect(scene.textures.length).toBe(baseline.textures);
    expect(scene.particleSystems.length).toBe(baseline.systems);
  });

  it("maps blend, billboard, loop, pre warm and capacity onto Babylon's named constants", () => {
    const doc = createDefaultParticleGraphDocument();
    const once = built(realize(planOf(doc, { blendMode: "subtract", billboard: "stretched", loop: "once", duration: 1.5, prewarm: 2, capacity: 1000 })).result).system;
    expect(once.blendMode).toBe(ParticleSystem.BLENDMODE_SUBTRACT);
    expect(once.billboardMode).toBe(ParticleSystem.BILLBOARDMODE_STRETCHED);
    expect(once.isBillboardBased).toBe(true);
    expect(once.targetStopDuration).toBe(1.5);
    // Pre Warm applies to Infinite emitters only; graph capacity is not capped at 512.
    expect(once.preWarmCycles).toBe(0);
    expect(once.getCapacity()).toBe(1000);
    const looping = built(realize(planOf(doc, { blendMode: "standard", billboard: "y", prewarm: 1 })).result).system;
    expect(looping.blendMode).toBe(ParticleSystem.BLENDMODE_STANDARD);
    expect(looping.billboardMode).toBe(ParticleSystem.BILLBOARDMODE_Y);
    expect(looping.targetStopDuration).toBe(0);
    expect(looping.preWarmCycles * looping.preWarmStepOffset * looping.updateSpeed).toBeCloseTo(1);
  });

  it("builds a value node shared by two consumers once", () => {
    const doc = withSpine([node("size", "update.size")], [node("random", "random.range", { "default:min": [0.2], "default:max": [0.4] })],
      [edge("random", "out", "size", "size"), edge("random", "out", "create", "size")]);
    let builds = 0;
    const counting: ParticleBlockAdapter = (context) => {
      const realization = PARTICLE_BLOCK_ADAPTERS["random.range"]!(context);
      realization.blocks[0]!.onBuildObservable.add(() => { builds += 1; });
      return realization;
    };
    built(realize(planOf(doc), "world", { "random.range": counting }).result);
    expect(builds).toBe(1);
  });

  it("anchors a failed block build to its node and leaves no system or texture behind", () => {
    const doc = withSpine([node("size", "update.size", { "default:size": [0.5] })]);
    class RejectingSizeBlock extends UpdateSizeBlock {
      override _build(): void {
        // Babylon throws plain strings.
        throw "size block rejected the build";
      }
    }
    const rejecting: ParticleBlockAdapter = ({ name }) => {
      const block = new RejectingSizeBlock(name);
      return { blocks: [block], inputs: { particle: block.particle, size: block.size }, outputs: { out: block.output } };
    };
    const { scene, emitter } = host();
    const baseline = { textures: scene.textures.length, systems: scene.particleSystems.length };
    const result = realizeParticleGraph(planOf(doc), { scene, name: "graph", emitter, space: "world", adapters: { "update.size": rejecting } });
    expect(result).toEqual({ ok: false, diagnostics: [
      { code: "particle.compile.buildFailed", nodeId: "size", message: "size block rejected the build" },
    ] });
    // Create Particle had already added its system when the Size block threw.
    expect(scene.particleSystems.length).toBe(baseline.systems);
    expect(scene.textures.length).toBe(baseline.textures);
  });

  it("reports a connection Babylon rejects at the node and pin without building", () => {
    const plan = planOf(createDefaultParticleGraphDocument());
    // The IR never emits this: Normalized Age (Float) straight into Update Color's Color4 port.
    const operations = plan.operations.map((operation) => operation.id !== "updateColor" ? operation : {
      ...operation, inputs: { ...operation.inputs, color: { kind: "operation" as const, operationId: "normalizedAge", pinId: "out" } },
    });
    const { scene, result } = realize({ ...plan, operations });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostics).toEqual([
      expect.objectContaining({ code: "particle.compile.typeMismatch", nodeId: "updateColor", pinId: "color" }),
    ]);
    expect(scene.particleSystems).toHaveLength(0);
  });

  it("splats a Float into Color and vector inputs the way Babylon adapts it", () => {
    const doc = withSpine([node("steer", "update.direction")], [
      node("gray", "const.float", { value: [0.25] }),
      node("vector", "const.vec3", { value: [1, 2, 3] }),
      node("mix", "math.lerp", { "default:alpha": [0.5] }),
    ], [
      edge("gray", "out", "mix", "a"), edge("vector", "out", "mix", "b"), edge("mix", "out", "steer", "direction"),
    ]);
    // Float straight into Update Color's Color, in place of the default Initial Color × Gradient.
    doc.edges = [
      ...doc.edges.filter((entry) => entry.targetNodeId !== "updateColor" || entry.targetPinId !== "color"),
      edge("gray", "out", "updateColor", "color"),
    ];
    const { system } = built(realize(planOf(doc)).result);
    system.start(0);
    step(system, 10);
    const particle = system.particles[0]!;
    // Babylon's `adapt` splats into every channel, alpha included.
    expect(particle.color.asArray()).toEqual([0.25, 0.25, 0.25, 0.25]);
    const direction = particle.direction.asArray();
    [0.625, 1.125, 1.625].forEach((value, index) => expect(direction[index]).toBeCloseTo(value, 6));
  });

  it.each([["local", 5], ["world", 0]] as const)("moves %s-space particles by %d when the emitter moves 5 along X", (space, shift) => {
    const doc = createDefaultParticleGraphDocument();
    // Motionless particles that live longer than the test.
    doc.nodes = doc.nodes.map((entry) => entry.id === "create" ? { ...entry, properties: { ...entry.properties, "default:lifetime": [10], "default:emitPower": [0] } } : entry);
    const { emitter, result } = realize(planOf(doc), space);
    const { system } = built(result);
    system.start(0);
    step(system, 20);
    const before = system.particles.map((particle) => particle.position.x);
    expect(before.length).toBeGreaterThan(0);
    emitter.position.x = 5;
    emitter.computeWorldMatrix(true);
    step(system, 1);
    // The particles spawned before the move follow the emitter only in Local space.
    before.forEach((x, index) => expect(system.particles[index]!.position.x - x).toBeCloseTo(shift, 3));
  });

  it.each([
    ["math.sinDegrees", 90, 1],
    ["math.cosDegrees", 60, 0.5],
    ["math.tanDegrees", 45, 1],
    ["math.asinDegrees", 0.5, 30],
    ["math.acosDegrees", 0.5, 60],
    ["math.atanDegrees", 1, 45],
    ["math.sin", Math.PI / 2, 1],
  ] as const)("%s of %s sizes particles %s", (type, input, expected) => {
    const doc = withSpine([node("size", "update.size")], [node("trig", type, { "default:value": [input] })],
      [edge("trig", "out", "size", "size")]);
    const { system } = built(realize(planOf(doc)).result);
    system.start(0);
    step(system, 5);
    expect(system.particles.length).toBeGreaterThan(0);
    expect(system.particles[0]!.size).toBeCloseTo(expected, 6);
  });

  it("turns particles by degree-unit angles and reads their angle back in degrees", () => {
    const doc = withSpine([node("turn", "update.angleDegrees", { "default:angle": [90] }), node("size", "update.size")],
      [node("angle", "input.contextual.angleDegrees")], [edge("angle", "out", "size", "size")]);
    // Create Particle's own angle in degrees: 45° at birth, then Update Angle (Degrees) sets 90°.
    doc.nodes = doc.nodes.map((entry) => entry.id === "create"
      ? { ...entry, properties: { ...entry.properties, angleUnit: "degrees", "default:angle": [45] } } : entry);
    const { system } = built(realize(planOf(doc)).result);
    system.start(0);
    step(system, 5);
    const particle = system.particles[0]!;
    expect(particle.angle).toBeCloseTo(Math.PI / 2, 6);
    // Size reads Angle (Degrees) after the update.
    expect(particle.size).toBeCloseTo(90, 4);

    const birth = withSpine([node("size", "update.size")], [node("angle", "input.contextual.angleDegrees")],
      [edge("angle", "out", "size", "size")]);
    birth.nodes = birth.nodes.map((entry) => entry.id === "create"
      ? { ...entry, properties: { ...entry.properties, angleUnit: "degrees", "default:angle": [45] } } : entry);
    const born = built(realize(planOf(birth)).result).system;
    born.start(0);
    step(born, 5);
    expect(born.particles[0]!.angle).toBeCloseTo(Math.PI / 4, 6);
    expect(born.particles[0]!.size).toBeCloseTo(45, 4);
  });

  it("keeps a Local Variable's first read for each particle's life, or one value per frame in Loop scope", () => {
    const graph = (scope: "particle" | "loop") => withSpine([node("size", "update.size")], [
      node("random", "random.range", { valueType: "float", lock: "everyRead", "default:min": [0], "default:max": [1] }),
      node("keep", "utility.localVariable", { scope }),
    ], [edge("random", "out", "keep", "value"), edge("keep", "out", "size", "size")]);
    // Particles born this frame have not run Update yet.
    const sizes = (system: ParticleSystem) => new Map(system.particles.filter((particle) => particle.age > 1 / 30)
      .map((particle) => [particle.id, particle.size]));

    const perParticle = built(realize(planOf(graph("particle"))).result).system;
    perParticle.start(0);
    step(perParticle, 10);
    const before = sizes(perParticle);
    expect(before.size).toBeGreaterThan(2);
    // Distinct per particle, and unchanged frame after frame.
    expect(new Set(before.values()).size).toBeGreaterThan(1);
    step(perParticle, 5);
    for (const [id, size] of sizes(perParticle)) if (before.has(id)) expect(size).toBe(before.get(id));

    const perFrame = built(realize(planOf(graph("loop"))).result).system;
    perFrame.start(0);
    const scene = perFrame.getScene()! as unknown as { _frameId: number };
    const frame = () => { scene._frameId += 1; step(perFrame); };
    for (let index = 0; index < 10; index += 1) frame();
    const shared = new Set(sizes(perFrame).values());
    expect(sizes(perFrame).size).toBeGreaterThan(2);
    expect(shared.size).toBe(1);
    const seen = new Set(shared);
    for (let index = 0; index < 5; index += 1) {
      frame();
      const values = new Set(sizes(perFrame).values());
      expect(values.size).toBe(1);
      seen.add([...values][0]!);
    }
    // A new frame reads a new value.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("blends two directions with Normalized Lerp and returns a unit vector", () => {
    const doc = withSpine([node("size", "update.size")], [
      node("blend", "math.nlerp", { "default:a": [1, 0, 0], "default:b": [0, 1, 0], "default:alpha": [0.5] }),
      node("split", "vector.split"),
    ], [edge("blend", "out", "split", "value"), edge("split", "x", "size", "size")]);
    const { system } = built(realize(planOf(doc)).result);
    system.start(0);
    step(system, 5);
    expect(system.particles.length).toBeGreaterThan(0);
    expect(system.particles[0]!.size).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("pushes particles with the Noise node's pixels every frame, and not at all until it has them", () => {
    const doc = withSpine([node("noise", "update.noise", { "default:strength": [6, 6, 6] })]);
    let pixels: { width: number; height: number; data: Uint8Array } | null = null;
    const { scene, emitter } = host();
    const result = realizeParticleGraph(planOf(doc), { scene, name: "graph", emitter, space: "world",
      noise: (textureGuid) => { expect(textureGuid).toBeNull(); return { pixels: () => pixels }; } });
    const { system } = built(result);
    system.start(0);
    step(system, 5);
    const particle = system.particles[0]!;
    const before = particle.direction.clone();
    step(system, 1);
    // No pixels yet: the direction is untouched.
    expect(particle.direction.equalsWithEpsilon(before, 1e-9)).toBe(true);
    // All red: every axis gets the full Strength, scaled by this frame's seconds.
    pixels = { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) };
    step(system, 1);
    const pushed = particle.direction.subtract(before);
    expect(pushed.x).toBeCloseTo(6 / 60, 6);
    expect(pushed.y).toBeCloseTo(6 / 60, 6);
    expect(pushed.z).toBeCloseTo(6 / 60, 6);
  });

  it("spawns Mesh Shape particles on the source's triangles, along the normal and in its colour, and at the emitter without one", () => {
    // One triangle at height 2, facing up, coloured red.
    const triangle = { positions: [0, 2, 0, 1, 2, 0, 0, 2, 1], indices: [0, 1, 2], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0],
      colors: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1] };
    let geometry: typeof triangle | null = null;
    const doc = withSpine([], [], []);
    const shape = doc.nodes.find((entry) => entry.id === "shape")!;
    shape.type = "shape.mesh";
    shape.properties = { source: "ownerMesh", modelGuid: null, useMeshNormals: true, useMeshColor: true };
    const { scene, emitter } = host();
    const result = realizeParticleGraph(planOf(doc), { scene, name: "graph", emitter, space: "world",
      meshShape: (properties) => { expect(properties.source).toBe("ownerMesh"); return { geometry: () => geometry }; } });
    const { system } = built(result);
    system.start(0);
    step(system, 3);
    // Without geometry, at the emitter.
    const early = system.particles[0]!;
    expect(early.position.length()).toBeLessThan(0.5);
    geometry = triangle;
    step(system, 10);
    const late = system.particles.filter((particle) => particle.age < 0.1);
    expect(late.length).toBeGreaterThan(0);
    for (const particle of late) {
      // The default graph's Update Color scales the Initial Color by a gradient.
      expect(particle.initialColor.r).toBeCloseTo(1, 6);
      expect(particle.initialColor.g).toBeCloseTo(0, 6);
      expect(particle.direction.normalizeToNew().y).toBeCloseTo(1, 6);
      expect(particle.position.x).toBeGreaterThanOrEqual(-1e-6);
      expect(particle.position.z).toBeGreaterThanOrEqual(-1e-6);
      expect(particle.position.x + particle.position.z).toBeLessThanOrEqual(1 + 0.5);
    }
  });

  it("returns each parameter's blocks, whose value the running system reads without a rebuild, downstream math and Emit Rate included", () => {
    const doc = withSpine([node("size", "update.size")], [
      { id: "scale", type: "input.parameter", position: { x: 0, y: 0 }, properties: { parameterId: "p-scale", valueType: "float" } },
      { id: "rate", type: "input.parameter", position: { x: 0, y: 0 }, properties: { parameterId: "p-rate", valueType: "float" } },
      node("double", "math.multiply", { "default:b": [2] }),
    ], [edge("scale", "out", "double", "a"), edge("double", "out", "size", "size"), edge("rate", "out", "output", "emitRate")]);
    doc.parameters = [
      { id: "p-scale", name: "Scale", type: "float", defaultValue: [0.25] },
      { id: "p-rate", name: "Rate", type: "float", defaultValue: [0] },
    ];
    const { result } = realize(planOf(doc));
    const { system, parameterBlocks } = built(result) as Extract<RealizeParticleGraphResult, { ok: true }>;
    expect([...parameterBlocks.keys()].sort()).toEqual(["p-rate", "p-scale"]);
    system.start(0);
    step(system, 30);
    // Emit Rate 0: nothing yet.
    expect(system.getActiveCount()).toBe(0);
    parameterBlocks.get("p-rate")![0]!.value = 60;
    step(system, 30);
    expect(system.getActiveCount()).toBeGreaterThan(20);
    expect(system.particles[0]!.size).toBeCloseTo(0.5, 6);
    // A new value reaches particles through Multiply on the next frame.
    parameterBlocks.get("p-scale")![0]!.value = 1.5;
    step(system, 1);
    expect(system.particles[0]!.size).toBeCloseTo(3, 6);
  });

  it("emits fractional and computed Emit Rates", () => {
    const slow = createDefaultParticleGraphDocument();
    slow.nodes = slow.nodes.map((entry) => entry.id === "output" ? { ...entry, properties: { "default:emitRate": [0.5] } }
      : entry.id === "create" ? { ...entry, properties: { ...entry.properties, "default:lifetime": [10] } } : entry);
    const fractional = built(realize(planOf(slow)).result).system;
    fractional.start(0);
    // 0.5 /s for about 4 s; Babylon carries the fraction between frames.
    step(fractional, 246);
    expect(fractional.getActiveCount()).toBeGreaterThanOrEqual(1);
    expect(fractional.getActiveCount()).toBeLessThanOrEqual(2);

    const computed = createDefaultParticleGraphDocument();
    computed.nodes.push(node("time", "input.system.time"), node("rate", "math.multiply", { "default:b": [60] }));
    computed.edges.push(edge("time", "out", "rate", "a"), edge("rate", "out", "output", "emitRate"));
    const ramp = built(realize(planOf(computed)).result).system;
    ramp.start(0);
    step(ramp, 60);
    // Rate 60 × Time over the first second: about 30 particles.
    expect(ramp.getActiveCount()).toBeGreaterThan(20);
    expect(ramp.getActiveCount()).toBeLessThan(40);
  });
});

/** Update node consuming a value of `type`, spliced into the spine. */
const CONSUMERS: Readonly<Record<ParticleNumericType, { type: string; pin: string }>> = {
  float: { type: "update.size", pin: "size" },
  vec2: { type: "update.scale", pin: "scale" },
  vec3: { type: "update.direction", pin: "direction" },
  color: { type: "update.color", pin: "color" },
};

/** The default graph plus `type`: spine nodes join the spine, value nodes feed an update node. */
function graphWith(type: string): ParticleGraphDocument {
  const subject = node("subject", type, type === "input.parameter" ? { parameterId: "p" } : {});
  const definition = particleNodeDefinitionFor(subject)!;
  // Required value pins without a wire get an authored default.
  for (const pin of definition.inputs) {
    if (!pin.required || pin.type.kind === "particle") continue;
    const kind: ParticleNumericType = pin.type.kind === "generic" ? pin.type.fallback ?? "float" : pin.type.kind;
    subject.properties[`default:${pin.id}`] = resizeParticleValue([0.5], kind);
  }
  if (definition.role === "shape" || definition.role === "update") return withSpine([subject]);
  const output = definition.outputs[0]!;
  const kind: ParticleNumericType = output.type.kind === "particle" ? "float"
    : output.type.kind === "generic" ? output.type.fallback ?? "float" : output.type.kind;
  const consumer = CONSUMERS[kind];
  const doc = withSpine([node("consumer", consumer.type)], [subject], [edge("subject", output.id, "consumer", consumer.pin)]);
  // A Parameter node needs its parameter declared.
  if (type === "input.parameter") doc.parameters = [{ id: "p", name: "Value", type: "float", defaultValue: [0.5] }];
  return doc;
}

describe("Particle Graph catalog", () => {
  const types = PARTICLE_CATALOG.filter((definition) => !definition.terminal && definition.role !== "create").map((definition) => definition.type);

  it.each(types)("builds and simulates %s", (type) => {
    const { result } = realize(planOf(graphWith(type)));
    const { system } = built(result);
    system.start(0);
    expect(() => step(system, 20)).not.toThrow();
    expect(system.getActiveCount()).toBeGreaterThan(0);
  });
});
