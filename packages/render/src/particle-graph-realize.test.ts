import { GPUParticleSystem } from "@babylonjs/core/Particles/gpuParticleSystem";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { UpdateSizeBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updateSizeBlock";
import { NodeParticleConnectionPoint } from "@babylonjs/core/Particles/Node/nodeParticleBlockConnectionPoint";
import type { Particle } from "@babylonjs/core/Particles/particle";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
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
import { createTestEngine } from "./test-support/test-engine";
import { PARTICLE_BLOCK_ADAPTERS, type ParticleBlockAdapter } from "./particle-graph-blocks";
import { realizeParticleGraph, type RealizeParticleGraphResult } from "./particle-graph-realize";
import { GlobalParameterSession, type GlobalParameterValueSource } from "./global-parameter-values";
import { animatedSpriteCell } from "./particle-sprite-sheet";

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

function realize(plan: ParticleBuildPlan, space: ParticleSpace = "world", adapters?: Record<string, ParticleBlockAdapter>,
  globalParameters?: GlobalParameterValueSource, compileUpdate = true) {
  const { scene, emitter } = host();
  const result = realizeParticleGraph(plan, { scene, name: "graph", emitter, space, adapters, compileUpdate,
    ...(globalParameters ? { globalParameters } : {}) });
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

  it("reads a Global Parameter from its source and follows each change without a rebuild", () => {
    const doc = withSpine([node("size", "update.size")], [
      { id: "global", type: "global.parameter", position: { x: 0, y: 0 }, properties: { collectionGuid: "fx", parameterId: "scale", valueType: "float" } },
    ], [edge("global", "out", "size", "size")]);
    const defaults: GlobalParameterValueSource = {
      revision: 0,
      value: (collectionGuid, parameterId) => (collectionGuid === "fx" && parameterId === "scale" ? [0.25] : null),
      subscribe: () => () => undefined,
    };
    const session = new GlobalParameterSession(defaults);
    const { result } = realize(planOf(doc), "world", undefined, session);
    const { system } = built(result);
    system.start(0);
    step(system, 30);
    expect(system.getActiveCount()).toBeGreaterThan(0);
    expect(system.particles[0]!.size).toBeCloseTo(0.25, 6);
    session.set("fx", "scale", [2]);
    step(system, 1);
    expect(system.particles[0]!.size).toBeCloseTo(2, 6);
    // Dropping the session's value returns every particle to the default.
    session.set("fx", "scale", null);
    step(system, 1);
    expect(system.particles[0]!.size).toBeCloseTo(0.25, 6);
  });

  it("turns on Babylon's animation sheet for a Sprite Sheet and steps each particle's cell with Animate Sprite Sheet", () => {
    const settings = { columns: 2, rows: 2, startCell: 1, endCell: 3, framesPerSecond: 10, loop: true, randomStartCell: false };
    const { system } = built(realize(planOf(withSpine([node("sheet", "sprite.setup", settings), node("animate", "update.basicSprite")]))).result);
    expect((system as unknown as { _isAnimationSheetEnabled: boolean })._isAnimationSheetEnabled).toBe(true);
    // Babylon sizes a cell in texels of particleTexture, the 1 × 1 readiness texture.
    expect([system.spriteCellWidth, system.spriteCellHeight]).toEqual([0.5, 0.5]);
    expect(system.particleTexture!.getSize()).toEqual({ width: 1, height: 1 });
    const defines: string[] = [];
    system.fillDefines(defines, system.blendMode, false);
    expect(defines).toContain("#define ANIMATESHEET");
    system.start(0);
    step(system, 40);
    // Born on Start Cell, then 10 cells a second through End Cell and round again.
    const updated = system.particles.filter((particle) => particle.age > 1 / 30);
    expect(updated.length).toBeGreaterThan(5);
    for (const particle of updated) expect(particle.cellIndex).toBe(animatedSpriteCell(settings, 1, particle.age));
    expect(new Set(updated.map((particle) => particle.cellIndex)).size).toBe(3);
    for (const particle of system.particles.filter((entry) => entry.age === 0)) expect(particle.cellIndex).toBe(1);
  });

  it("starts particles on random cells, sets cells from Update Sprite Cell within the sheet, and needs a Sprite Sheet", () => {
    const sheet = (properties: Record<string, unknown>) => node("sheet", "sprite.setup", { columns: 2, rows: 2, startCell: 1, endCell: 3, ...properties });
    const random = built(realize(planOf(withSpine([sheet({ randomStartCell: true, framesPerSecond: 0 }), node("animate", "update.basicSprite")]))).result).system;
    random.start(0);
    step(random, 40);
    const cells = new Set(random.particles.map((particle) => particle.cellIndex));
    expect([...cells].sort()).toEqual([1, 2, 3]);

    const cellOf = (value: number) => {
      const { system } = built(realize(planOf(withSpine([sheet({}), node("cell", "update.spriteCell", { "default:cell": [value] })]))).result);
      system.start(0);
      step(system, 10);
      return [...new Set(system.particles.filter((particle) => particle.age > 1 / 30).map((particle) => particle.cellIndex))];
    };
    expect(cellOf(2.7)).toEqual([2]);
    expect(cellOf(9)).toEqual([3]);
    expect(cellOf(-4)).toEqual([0]);

    // Without a Sprite Sheet the sheet stays off and Animate Sprite Sheet changes nothing.
    const { system: bare } = built(realize(planOf(withSpine([node("animate", "update.basicSprite")]))).result);
    expect((bare as unknown as { _isAnimationSheetEnabled: boolean })._isAnimationSheetEnabled).toBe(false);
    bare.start(0);
    step(bare, 10);
    expect(new Set(bare.particles.map((particle) => particle.cellIndex))).toEqual(new Set([0]));
  });

  it("hands Spawn Emitter's sink the firing particle's world position, velocity and the simulated time", () => {
    const fires: Array<{ position: number[]; velocity: number[]; now: number }> = [];
    const sink = { fire: (position: { asArray(): number[] }, velocity: { asArray(): number[] }, now: number) =>
      fires.push({ position: position.asArray(), velocity: velocity.asArray(), now }) };
    const graph = (wired: boolean, properties: Record<string, unknown> = {}) => withSpine([node("spawn", "trigger.spawn", { emitterGuid: "spark", ...properties })],
      wired ? [node("one", "const.float", { value: [1] })] : [], wired ? [edge("one", "out", "spawn", "condition")] : []);
    const seen: Array<Record<string, unknown>> = [];
    const run = (doc: ParticleGraphDocument, space: ParticleSpace) => {
      const { scene, emitter } = host();
      emitter.position.set(5, 0, 0);
      emitter.computeWorldMatrix(true);
      const result = realizeParticleGraph(planOf(doc), { scene, name: "graph", emitter, space,
        spawn: (properties) => { seen.push(properties); return sink as never; } });
      const { system } = built(result);
      system.start(0);
      step(system, 10);
      return system;
    };
    // Condition 0 (unwired) never fires.
    run(graph(false), "world");
    expect(fires).toEqual([]);
    expect(seen[0]).toMatchObject({ emitterGuid: "spark", limit: 8 });
    // Not 0: every updated particle, every frame, in world space with the system's own clock.
    const world = run(graph(true), "world");
    expect(fires.length).toBeGreaterThan(5);
    expect(fires.at(-1)!.now).toBeCloseTo((world as unknown as { _actualFrame: number })._actualFrame, 9);
    for (const fire of fires) expect(fire.position[0]).toBeGreaterThan(3);
    // Local Space particles are carried to world space.
    fires.length = 0;
    run(graph(true), "local");
    expect(fires.length).toBeGreaterThan(5);
    for (const fire of fires) expect(fire.position[0]).toBeGreaterThan(3);
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
  const subject = node("subject", type, type === "input.parameter" ? { parameterId: "p" }
    : type === "global.parameter" ? { collectionGuid: "fx", parameterId: "p", valueType: "float" } : {});
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
  // A Reroute is collapsed before lowering, so it never reaches a block.
  const types = PARTICLE_CATALOG.filter((definition) => !definition.terminal && definition.role !== "create" && definition.type !== "utility.reroute")
    .map((definition) => definition.type);

  it.each(types)("builds and simulates %s", (type) => {
    const { result } = realize(planOf(graphWith(type)));
    const { system } = built(result);
    system.start(0);
    expect(() => step(system, 20)).not.toThrow();
    expect(system.getActiveCount()).toBeGreaterThan(0);
  });

  it.each(types)("pins %s's port types to what Babylon resolves, and simulates exactly as unpinned ports do", (type) => {
    const resolve = Object.getOwnPropertyDescriptor(NodeParticleConnectionPoint.prototype, "type")!.get!;
    const simulate = (unpin: boolean) => {
      // Babylon's own closures on both sides: they are what read the port types per particle.
      const built_ = built(realize(planOf(graphWith(type)), "world", undefined, undefined, false).result);
      const ports = built_.set.attachedBlocks.flatMap((block) => [...block.inputs, ...block.outputs]);
      for (const port of ports) {
        expect(Object.hasOwn(port, "type")).toBe(true);
        expect(port.type).toBe(resolve.call(port));
        if (unpin) Reflect.deleteProperty(port, "type");
      }
      // The same random sequence for both runs.
      let seed = 12345;
      const random = vi.spyOn(Math, "random").mockImplementation(() => (seed = (seed * 16807) % 2147483647) / 2147483647);
      try {
        built_.system.start(0);
        step(built_.system, 20);
      } finally {
        random.mockRestore();
      }
      const particles = (built_.system as unknown as { _particles: Particle[] })._particles;
      return particles.map((p) => [p.position.asArray(), p.direction.asArray(), p.color.asArray(), p.size, p.angle,
        p.scale.asArray(), p.age, p.lifeTime, p.cellIndex]);
    };
    const pinned = simulate(false);
    expect(pinned.length).toBeGreaterThan(0);
    expect(pinned).toEqual(simulate(true));
  });

  it.each(types)("simulates %s through its particles' deaths exactly as Babylon's own update closures do", (type) => {
    const compiled = seededRun(built(realize(planOf(graphWith(type))).result).system, 150);
    const babylon = seededRun(built(realize(planOf(graphWith(type)), "world", undefined, undefined, false).result).system, 150);
    expect(babylon.deaths).toBeGreaterThan(0);
    expect(compiled.particles.length).toBeGreaterThan(0);
    expect(compiled).toEqual(babylon);
  });
});

/**
 * `frames` seeded 1/60 s steps from a fresh start: every live particle's state, the random generator's final state
 * (a read made more or fewer times than Babylon makes it changes it) and how many particles died.
 */
function seededRun(system: ParticleSystem, frames: number, between?: { at: number; write: () => void }) {
  let seed = 12345;
  let deaths = 0;
  const owner = system as unknown as { recycleParticle: (particle: Particle) => void };
  const recycle = owner.recycleParticle;
  owner.recycleParticle = (particle) => { deaths += 1; recycle(particle); };
  const random = vi.spyOn(Math, "random").mockImplementation(() => (seed = (seed * 16807) % 2147483647) / 2147483647);
  try {
    system.start(0);
    for (let frame = 0; frame < frames; frame++) {
      if (frame === between?.at) between.write();
      step(system);
    }
  } finally {
    random.mockRestore();
  }
  return {
    particles: (system as unknown as { _particles: Particle[] })._particles.map((p) => [p.position.asArray(), p.direction.asArray(),
      p.color.asArray(), p.size, p.angle, p.scale.asArray(), p.age, p.lifeTime, p.cellIndex]),
    seed,
    deaths,
  };
}

const NUMERIC_TYPES: readonly ParticleNumericType[] = ["float", "vec2", "vec3", "color"];

/**
 * Every value node at every type it can take (each type a generic pin group accepts, or its Value Type), with every
 * input wired from a constant of the type it then has: what a typed graph builds, Clamp bounds and Lerp gradients wired.
 */
function typedValueGraphs(): [string, ParticleNumericType][] {
  const cases: [string, ParticleNumericType][] = [];
  for (const definition of PARTICLE_CATALOG) {
    if (definition.terminal || definition.role !== "value" || definition.type.endsWith(".parameter")) continue;
    const properties = newParticleNodeProperties(definition.type);
    const group = definition.inputs.map((pin) => pin.type).find((pinType) => pinType.kind === "generic");
    const accepts = group?.kind === "generic" ? group.accepts ?? NUMERIC_TYPES : null;
    // A group whose fallback is not Float (Normalized Lerp) never takes Float.
    const takesFloat = group?.kind === "generic" && (group.fallback ?? "float") === "float";
    const kinds = "valueType" in properties ? NUMERIC_TYPES
      : accepts ? NUMERIC_TYPES.filter((kind) => (kind === "float" ? takesFloat : accepts.includes(kind))) : [];
    for (const kind of kinds) cases.push([definition.type, kind]);
  }
  return cases;
}

function typedValueGraph(type: string, kind: ParticleNumericType): ParticleGraphDocument {
  const properties = newParticleNodeProperties(type);
  if ("valueType" in properties) properties.valueType = kind;
  if (type === "gradient.sample") {
    properties.stops = [0, 0.6, 1].map((position, index) => ({ position, value: resizeParticleValue([0.2 + 0.35 * index], kind) }));
  }
  const subject = node("subject", type, properties);
  const definition = particleNodeDefinitionFor(subject)!;
  const extra: ParticleGraphNode[] = [subject];
  const edges: ReturnType<typeof edge>[] = [];
  definition.inputs.forEach((pin, index) => {
    if (pin.type.kind === "particle") return;
    const pinKind: ParticleNumericType = pin.type.kind === "generic" ? kind : pin.type.kind;
    const id = `c-${pin.id}`;
    // Distinct values in (0, 1): a valid Lerp gradient, Clamp bounds that bite, no division by zero.
    extra.push(node(id, `const.${pinKind}`, { value: resizeParticleValue([0.15 + 0.2 * (index % 4)], pinKind) }));
    edges.push(edge(id, "out", "subject", pin.id));
  });
  const output = definition.outputs[0]!;
  const outKind: ParticleNumericType = output.type.kind === "generic" ? kind : output.type.kind as ParticleNumericType;
  const consumer = CONSUMERS[outKind];
  return withSpine([node("consumer", consumer.type)], extra, [...edges, edge("subject", output.id, "consumer", consumer.pin)]);
}

describe("Particle Graph update compilation", () => {
  it.each(typedValueGraphs())("simulates %s at %s, every input wired, exactly as Babylon's own update closures do", (type, kind) => {
    const compiled = seededRun(built(realize(planOf(typedValueGraph(type, kind))).result).system, 150);
    const babylon = seededRun(built(realize(planOf(typedValueGraph(type, kind)), "world", undefined, undefined, false).result).system, 150);
    expect(babylon.deaths).toBeGreaterThan(0);
    expect(compiled).toEqual(babylon);
  });

  type Queue = { process: { name: string }; nextItem: Queue | null };
  const processNames = (system: ParticleSystem) => {
    const names: string[] = [];
    for (let item = (system as unknown as { _updateQueueStart: Queue | null })._updateQueueStart; item; item = item.nextItem) names.push(item.process.name);
    return names;
  };

  it("replaces the processes of the update blocks it compiles and keeps Babylon's for the rest", () => {
    // The default graph: Apply Velocity (Babylon's, kept) then Update Color (compiled).
    expect(processNames(built(realize(planOf(createDefaultParticleGraphDocument())).result).system)).toEqual(["processPosition", ""]);
    expect(processNames(built(realize(planOf(createDefaultParticleGraphDocument()), "world", undefined, undefined, false).result).system))
      .toEqual(["processPosition", "processColor"]);
  });

  it("simulates a Local Space graph exactly as Babylon's own update closures do", () => {
    const doc = withSpine([node("gravity", "force.gravity", { "default:acceleration": [0, -2, 0.5] })]);
    const compiled = seededRun(built(realize(planOf(doc), "local").result).system, 150);
    const babylon = seededRun(built(realize(planOf(doc), "local", undefined, undefined, false).result).system, 150);
    expect(babylon.deaths).toBeGreaterThan(0);
    expect(compiled).toEqual(babylon);
  });

  it("applies a parameter written while the system runs on the next step, as Babylon's closures do", () => {
    const doc = withSpine([node("size", "update.size"), node("gravity", "force.gravity")], [
      { id: "scale", type: "input.parameter", position: { x: 0, y: 0 }, properties: { parameterId: "p-scale", valueType: "float" } },
      node("double", "math.multiply", { "default:b": [2] }),
      { id: "lift", type: "input.parameter", position: { x: 0, y: 0 }, properties: { parameterId: "p-lift", valueType: "vec3" } },
    ], [edge("scale", "out", "double", "a"), edge("double", "out", "size", "size"), edge("lift", "out", "gravity", "acceleration")]);
    doc.parameters = [
      { id: "p-scale", name: "Scale", type: "float", defaultValue: [0.25] },
      { id: "p-lift", name: "Lift", type: "vec3", defaultValue: [0, 1, 0] },
    ];
    const run = (compileUpdate: boolean) => {
      const { system, parameterBlocks } = built(realize(planOf(doc), "world", undefined, undefined, compileUpdate).result) as
        Extract<RealizeParticleGraphResult, { ok: true }>;
      return seededRun(system, 41, { at: 40, write: () => {
        parameterBlocks.get("p-scale")![0]!.value = 1.5;
        parameterBlocks.get("p-lift")![0]!.value = new Vector3(0, -3, 1);
      } });
    };
    const compiled = run(true);
    // The particles alive before the write took the new Scale on the step after it (those born on that step have not run
    // the update yet).
    expect(compiled.particles.length).toBeGreaterThan(0);
    expect(compiled.particles.filter((particle) => particle[3] === 3).length).toBeGreaterThan(0);
    expect(compiled).toEqual(run(false));
  });
});
