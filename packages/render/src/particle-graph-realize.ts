import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { GlobalParameterValueSource } from "./global-parameter-values";
import type { IParticleSystem } from "@babylonjs/core/Particles/IParticleSystem";
import { ParticleInputBlock } from "@babylonjs/core/Particles/Node/Blocks/particleInputBlock";
import type { NodeParticleBlock } from "@babylonjs/core/Particles/Node/nodeParticleBlock";
import type { NodeParticleConnectionPoint } from "@babylonjs/core/Particles/Node/nodeParticleBlockConnectionPoint";
import { NodeParticleBuildState } from "@babylonjs/core/Particles/Node/nodeParticleBuildState";
import { NodeParticleSystemSet } from "@babylonjs/core/Particles/Node/nodeParticleSystemSet";
import type { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import type { Scene } from "@babylonjs/core/scene";
import type { ParticleSpace } from "@haptic/core";
import {
  particleNodeDefinitionFor,
  type ParticleBuildPlan,
  type ParticleOperation,
} from "@haptic/particle-graph";
import {
  configureParticleSystemBlock,
  particleBlockAdapterFor,
  particleConstantBlock,
  particleSplatBlocks,
  type ParticleBlockAdapter,
  type ParticleBlockRealization,
  type SlateSystemBlock,
} from "./particle-graph-blocks";
import { createParticleReadinessTexture } from "./particle-system-factory";
import type { ParticleMeshShapeSource } from "./particle-mesh-shape";
import type { ParticleSpawnSink } from "./particle-spawn";
import type { ParticleNoiseSource } from "./particle-noise";

/** Render-side Particle Graph build problems, anchored to the graph node (and pin) when known. */
export type ParticleGraphCompileCode =
  | "particle.compile.unsupportedNode"
  | "particle.compile.typeMismatch"
  | "particle.compile.connectionFailed"
  | "particle.compile.buildFailed";

export interface ParticleGraphCompileDiagnostic {
  code: ParticleGraphCompileCode;
  message: string;
  nodeId?: string;
  pinId?: string;
}

export interface RealizeParticleGraphOptions {
  /** Host scene; the built system joins its `particleSystems`. */
  scene: Scene;
  /** Becomes `system.name` and prefixes every block name. */
  name: string;
  /** Service-owned emitter node, set on the SystemBlock before the build. */
  emitter: AbstractMesh;
  /** The Particle System's Space. */
  space: ParticleSpace;
  /** Extra or replacement adapters by node type (tests inject failing blocks). */
  adapters?: Readonly<Record<string, ParticleBlockAdapter>>;
  /** Noise node pixels by Texture (null: the built-in noise); defaults to the built-in noise for every node. */
  noise?: (textureGuid: string | null) => ParticleNoiseSource;
  /** Mesh Shape geometry by node properties; without it Mesh Shape spawns at the emitter. */
  meshShape?: (properties: Readonly<Record<string, unknown>>) => ParticleMeshShapeSource;
  /** Spawn Emitter requests, for a node's properties. Without it Spawn Emitter spawns nothing. */
  spawn?: (properties: Readonly<Record<string, unknown>>) => ParticleSpawnSink | null;
  /** What Global Parameter nodes read; the editor's defaults when omitted. */
  globalParameters?: GlobalParameterValueSource;
}

export type RealizeParticleGraphResult =
  | {
      ok: true;
      /** Owns every block; `set.dispose()` disposes the system and its readiness texture. */
      set: NodeParticleSystemSet;
      system: ParticleSystem;
      /** Babylon's build promises (none for the v1 catalog). */
      buildReady: Promise<void>;
      /** Each declared parameter's input blocks by parameter id; writing their value updates the running system. */
      parameterBlocks: Map<string, ParticleInputBlock[]>;
    }
  | { ok: false; diagnostics: ParticleGraphCompileDiagnostic[] };

/** Babylon throws plain strings; keep their text. */
export function describeParticleThrow(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  if (typeof thrown === "string" && thrown.trim()) return thrown.trim();
  return "Particle preparation failed.";
}

let nextParticleBuildId = 0;

type Buildable = { _build(state: NodeParticleBuildState): unknown };

function nodeTitle(operation: ParticleOperation): string {
  return particleNodeDefinitionFor({ type: operation.nodeType, properties: operation.properties })?.title ?? operation.nodeType;
}

function pinName(operation: ParticleOperation, pinId: string): string {
  const definition = particleNodeDefinitionFor({ type: operation.nodeType, properties: operation.properties });
  return definition?.inputs.find((pin) => pin.id === pinId)?.name ?? pinId;
}

/**
 * Builds one Particle Graph plan into a fresh `NodeParticleSystemSet` and CPU
 * `ParticleSystem`, synchronously (`createSystem` + `emitErrors`, never `buildAsync`).
 * Every problem is returned as a node-anchored diagnostic; on failure nothing it
 * created stays in the scene.
 */
export function realizeParticleGraph(plan: ParticleBuildPlan, options: RealizeParticleGraphOptions): RealizeParticleGraphResult {
  const { scene } = options;
  const set = new NodeParticleSystemSet(options.name);
  const owner = new Map<NodeParticleBlock, ParticleOperation>();
  const realized = new Map<string, ParticleBlockRealization>();
  const diagnostics: ParticleGraphCompileDiagnostic[] = [];
  let systemBlock: SlateSystemBlock | undefined;
  const parameters = new Map((plan.parameters ?? []).map((parameter) => [parameter.id, parameter]));
  const parameterBlocks = new Map<string, ParticleInputBlock[]>();
  const track = (operation: ParticleOperation, blocks: readonly NodeParticleBlock[]) => {
    for (const block of blocks) {
      owner.set(block, operation);
      set.attachedBlocks.push(block);
    }
  };

  for (const operation of plan.operations) {
    const name = `${options.name}/${operation.id}`;
    const adapter = options.adapters?.[operation.nodeType] ?? particleBlockAdapterFor(operation.nodeType);
    if (!adapter) {
      diagnostics.push({ code: "particle.compile.unsupportedNode", nodeId: operation.id,
        message: `"${nodeTitle(operation)}" cannot be built by this version of the engine` });
      continue;
    }
    let realization: ParticleBlockRealization;
    try {
      realization = adapter({ operation, name, space: options.space, parameters, ...(options.noise ? { noise: options.noise } : {}),
        ...(options.meshShape ? { meshShape: options.meshShape } : {}),
        ...(options.spawn ? { spawn: options.spawn } : {}),
        ...(options.globalParameters ? { globalParameters: options.globalParameters } : {}) });
    } catch (thrown) {
      diagnostics.push({ code: "particle.compile.buildFailed", nodeId: operation.id, message: describeParticleThrow(thrown) });
      continue;
    }
    track(operation, realization.blocks);
    if (realization.system) systemBlock = realization.system;
    if (operation.nodeType === "input.parameter") {
      const block = realization.outputs.out?.ownerBlock;
      const id = String(operation.properties.parameterId ?? "");
      if (block instanceof ParticleInputBlock) parameterBlocks.set(id, [...(parameterBlocks.get(id) ?? []), block]);
    }
    // Producers are wired before consumers: Babylon resolves AutoDetect and
    // BasedOnInput port types from what is already connected.
    for (const [pinId, operand] of Object.entries(operation.inputs)) {
      const target = realization.inputs[pinId];
      if (!target) {
        diagnostics.push({ code: "particle.compile.buildFailed", nodeId: operation.id, pinId,
          message: `"${nodeTitle(operation)}" has no engine input for "${pinName(operation, pinId)}"` });
        continue;
      }
      let source: NodeParticleConnectionPoint;
      if (operand.kind === "constant") {
        const constant = particleConstantBlock(`${name}/${pinId}`, operand.type, operand.value);
        track(operation, [constant]);
        source = constant.output;
      } else {
        const producer = realized.get(operand.operationId)?.outputs[operand.pinId];
        // A producer that failed has its own diagnostic.
        if (!producer) continue;
        source = producer;
        if (operand.conversion && !realization.nativeSplat?.has(pinId)) {
          const splat = particleSplatBlocks(`${name}/${pinId}`, producer, operand.conversion.to);
          track(operation, splat.blocks);
          source = splat.output;
        }
      }
      if (realization.coerce?.has(pinId)) {
        source.connectTo(target, true);
        continue;
      }
      if (source.checkCompatibilityState(target) !== 0) {
        diagnostics.push({ code: "particle.compile.typeMismatch", nodeId: operation.id, pinId,
          message: `The engine rejects this connection into "${pinName(operation, pinId)}" on "${nodeTitle(operation)}"` });
        continue;
      }
      try {
        source.connectTo(target);
      } catch (thrown) {
        diagnostics.push({ code: "particle.compile.connectionFailed", nodeId: operation.id, pinId,
          message: `Could not connect "${pinName(operation, pinId)}" on "${nodeTitle(operation)}": ${describeParticleThrow(thrown)}` });
      }
    }
    realized.set(operation.id, realization);
  }

  // Babylon's own check names only blocks; this one names the graph node.
  if (!diagnostics.length) {
    for (const block of set.attachedBlocks) {
      for (const input of block.inputs) {
        if (input.isOptional || input.isConnected) continue;
        const operation = owner.get(block)!;
        const pinId = Object.entries(realized.get(operation.id)?.inputs ?? {}).find(([, port]) => port === input)?.[0];
        diagnostics.push({ code: "particle.compile.buildFailed", nodeId: operation.id, ...(pinId ? { pinId } : {}),
          message: `"${nodeTitle(operation)}" needs a connection on "${pinId ? pinName(operation, pinId) : input.name.trim()}"` });
      }
    }
  }
  if (!systemBlock && !diagnostics.length) {
    diagnostics.push({ code: "particle.compile.buildFailed", message: "Particle Graph has no Emitter Output" });
  }
  if (diagnostics.length || !systemBlock) {
    set.dispose();
    return { ok: false, diagnostics };
  }

  configureParticleSystemBlock(systemBlock, plan.settings, options);
  const before = new Set<IParticleSystem>(scene.particleSystems);
  const state = new NodeParticleBuildState();
  state.scene = scene;
  state.verbose = false;
  // Babylon's build throws carry no block reference: remember which block was building.
  const trace: { building: NodeParticleBlock | null } = { building: null };
  const traced: Buildable[] = [];
  for (const block of set.attachedBlocks) {
    const buildable = block as unknown as Buildable;
    const build = buildable._build.bind(block);
    buildable._build = (buildState) => {
      trace.building = block;
      return build(buildState);
    };
    traced.push(buildable);
  }
  try {
    systemBlock.seedBuildId(++nextParticleBuildId);
    const system = systemBlock.createSystem(state);
    trace.building = null;
    state.emitErrors();
    // Created only after a successful build, so a failed build never leaks it; the
    // system's default dispose (through the SystemBlock hook) releases it.
    system.particleTexture = createParticleReadinessTexture(scene);
    return { ok: true, set, system, buildReady: state.waitForBuildPromisesAsync(), parameterBlocks };
  } catch (thrown) {
    const failed = trace.building ?? state.notConnectedNonOptionalInputs[0]?.ownerBlock ?? null;
    const anchor = failed ? owner.get(failed) : undefined;
    set.dispose();
    // CreateParticleBlock adds its system to the scene before the SystemBlock registers
    // the dispose hook, so a throw in between leaves a system only the scene knows.
    for (const system of [...scene.particleSystems]) if (!before.has(system)) system.dispose();
    return { ok: false, diagnostics: [{ code: "particle.compile.buildFailed", message: describeParticleThrow(thrown),
      ...(anchor ? { nodeId: anchor.id } : {}) }] };
  } finally {
    for (const buildable of traced) Reflect.deleteProperty(buildable, "_build");
  }
}
