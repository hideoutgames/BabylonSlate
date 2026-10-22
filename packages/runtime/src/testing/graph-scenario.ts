import type { CommandMessage } from "@babylonslate/bridge";
import { createDefaultScene, type SerializedScene } from "@babylonslate/core";
import {
  compileGraph,
  type CompileOptions,
  type GraphEdge,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createInProcessRuntime, type RuntimeDriver, type RuntimeDriverOptions } from "../driver";
import type { CompiledScript } from "../script-host";

type DiagnosticCommand = Extract<CommandMessage, { type: "diagnostic" }>;

/**
 * Microtask turns that settle latent work after a tick: a Delay that resolves in the tick,
 * its continuation and the commands it sends. The worker drains them between pumps.
 */
const SETTLE_TURNS = 12;

/** A node as the editor authors it: pins from the catalog. Literal inputs go in `default:<pinId>`. */
export function graphNode(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const definition = registry.get(typeId);
  if (!definition) throw new Error(`Unknown node type ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: definition.pins(properties), properties };
}

/** An edge from `sourceNodeId.sourcePinId` to `targetNodeId.targetPinId`, named after its ends. */
export function wire(sourceNodeId: string, sourcePinId: string, targetNodeId: string, targetPinId: string): GraphEdge {
  return {
    id: `${sourceNodeId}.${sourcePinId}->${targetNodeId}.${targetPinId}`,
    sourceNodeId, sourcePinId, targetNodeId, targetPinId,
  };
}

export type ClassScriptOptions = {
  registry: NodeRegistry;
  classId: string;
  /** Defaults to Actor. */
  parentClassId?: string;
  graph: LogicGraph;
  variables?: CompiledScript["variables"];
  /** Passed to the compiler as given, for example `stripDevelopmentOnly` for a release export. */
  compile?: Omit<CompileOptions, "assetGuid" | "registry">;
};

/** One event graph compiled into the script entry the editor ships for a Class (asset `<classId>.class`). */
export function compileClassScript(options: ClassScriptOptions): CompiledScript {
  const assetGuid = `${options.classId}.class`;
  const compiled = compileGraph(options.graph, {
    className: options.classId,
    ...options.compile,
    assetGuid,
    registry: options.registry,
  });
  return {
    assetGuid,
    classId: options.classId,
    parentClassId: options.parentClassId ?? "Actor",
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
    ...(options.variables ? { variables: options.variables } : {}),
  };
}

export type GraphScenarioOptions = {
  scripts: CompiledScript[];
  /** Placed in a default scene. */
  actors?: SerializedScene["actors"];
  seed?: number;
  dt?: number;
  /** Anything else the session needs, such as `includeDebugCommands` or loop detection. */
  runtime?: Omit<RuntimeDriverOptions, "seed" | "dt" | "playScene" | "onCommand">;
};

export type GraphScenario = {
  runtime: RuntimeDriver;
  /** Every command the runtime sent, in order. */
  commands: CommandMessage[];
  /** Runs `count` ticks, settling latent work after each one as the worker does. */
  tick(count?: number): Promise<void>;
  /** Log messages, optionally of one category, in the order they were logged. */
  logs(category?: string): string[];
  diagnostics(): DiagnosticCommand[];
  stop(): void;
};

async function settle(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn++) await Promise.resolve();
}

/**
 * An in-process Play session running `scripts` over `actors`: scripts load, the scene is
 * realized and the session starts, as editor Play does, before this resolves.
 */
export async function startGraphScenario(options: GraphScenarioOptions): Promise<GraphScenario> {
  const commands: CommandMessage[] = [];
  const runtime = createInProcessRuntime({
    seedDemoActors: false,
    preferSoftwarePhysics: true,
    playSceneGuid: "scenario-scene",
    ...options.runtime,
    seed: options.seed ?? 1,
    ...(options.dt === undefined ? {} : { dt: options.dt }),
    playScene: { ...createDefaultScene(), actors: options.actors ?? [] },
    onCommand: (command) => commands.push(command),
  });
  await runtime.loadScripts(options.scripts);
  await runtime.realizePlayWorld();
  runtime.start();
  await settle();
  return {
    runtime,
    commands,
    async tick(count = 1) {
      for (let index = 0; index < count; index++) {
        runtime.tick();
        await settle();
      }
    },
    logs(category) {
      return commands.flatMap((command) =>
        command.type === "log" && (category === undefined || command.category === category)
          ? [command.message]
          : []);
    },
    diagnostics() {
      return commands.filter((command): command is DiagnosticCommand => command.type === "diagnostic");
    },
    stop() {
      runtime.stop();
    },
  };
}
