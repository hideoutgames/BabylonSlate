import { describe, expect, it } from "vitest";
import type { CommandMessage } from "@babylonslate/bridge";
import {
  createActor,
  createDefaultSceneSettings,
  type SerializedScene,
} from "@babylonslate/core";
import {
  compileGraph,
  type GraphNode,
  type LogicGraph,
  type NodeRegistry,
} from "@babylonslate/scripting";
import { createDefaultNodeRegistry } from "@babylonslate/scripting-nodes";
import { createInProcessRuntime } from "./driver";
import type { CompiledScript } from "./script-host";

function sceneOf(actors: SerializedScene["actors"]): SerializedScene {
  return {
    name: "Inheritance",
    viewportMode: "3d",
    settings: createDefaultSceneSettings(),
    folders: [],
    actors,
  };
}

function classScript(
  classId: string,
  parentClassId: string,
  source: string,
  events: readonly string[] = [],
  extra: Partial<CompiledScript> = {},
): CompiledScript {
  return {
    assetGuid: `${classId}-script`,
    classId,
    parentClassId,
    source,
    anchors: [],
    entryPoints: events.map((event) => ({ name: event, event, isAsync: false })),
    ...extra,
  };
}

function node(
  registry: NodeRegistry,
  id: string,
  typeId: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const def = registry.get(typeId);
  if (!def) throw new Error(`missing node definition ${typeId}`);
  return { id, typeId, position: { x: 0, y: 0 }, pins: def.pins(properties), properties };
}

function scriptLogs(commands: readonly CommandMessage[]): string[] {
  return commands.flatMap((command) =>
    command.type === "log" && command.category === "Script" ? [command.message] : [],
  );
}

const trace = `const trace = (ctx, what) => ctx.log("log", "Script", what + "@" + ctx.self.classId);`;

/** Parent : Actor implements every export kind the children inherit. */
const parentScript = classScript("Parent", "Actor", `${trace}
  export function onBeginPlay(ctx) { trace(ctx, "Parent.beginPlay"); }
  export function onTick(ctx) { trace(ctx, "Parent.tick"); }
  export function Ping(ctx) { trace(ctx, "Parent.ping"); }
  export function Greet(ctx) { return { text: "Parent.greet@" + ctx.self.classId }; }
  export function Name() { return { text: "Parent" }; }
`, ["onBeginPlay", "onTick", "Ping"], {
  implementedInterfaces: ["iface-greeter"],
  interfaceImplementations: [
    { interfaceGuid: "iface-greeter", method: "Greet", exportName: "Greet" },
    { interfaceGuid: "iface-greeter", method: "Name", exportName: "Name" },
  ],
});

/** Child : Parent only overrides the `Name` function. */
const childScript = classScript("Child", "Parent", `
  export function Name() { return { text: "Child" }; }
`);

/** Override : Parent replaces Begin Play and Ping without calling the parent. */
const overrideScript = classScript("Override", "Parent", `
  export function onBeginPlay(ctx) { ctx.log("log", "Script", "Override.beginPlay"); }
  export function Ping(ctx) { ctx.log("log", "Script", "Override.ping"); }
`, ["onBeginPlay", "Ping"]);

/** Compiled from a real graph: Begin Play → Log → Call Parent. */
function callParentScript(
  registry: NodeRegistry,
  classId: string,
  parentClassId: string,
): CompiledScript {
  const graph: LogicGraph = {
    id: "event-graph",
    kind: "event",
    nodes: [
      node(registry, "begin", "flow.event.beginPlay"),
      node(registry, "log", "debug.log", { message: `${classId}.beginPlay` }),
      node(registry, "parent", "flow.event.callParent", {
        parentClassId,
        eventType: "flow.event.beginPlay",
      }),
    ],
    edges: [
      { id: "e1", sourceNodeId: "begin", sourcePinId: "execOut", targetNodeId: "log", targetPinId: "execIn" },
      { id: "e2", sourceNodeId: "log", sourcePinId: "execOut", targetNodeId: "parent", targetPinId: "execIn" },
    ],
  };
  const assetGuid = `${classId}-script`;
  const compiled = compileGraph(graph, { assetGuid, registry });
  return {
    assetGuid,
    classId,
    parentClassId,
    source: compiled.source,
    anchors: compiled.anchors,
    entryPoints: compiled.entryPoints,
  };
}

const probeScript = classScript("Probe", "Actor", `
  export function Run(ctx) {
    const { kid, rebel } = ctx.args;
    ctx.log("log", "Script", "greet:" + ctx.invokeFunction(kid, "Greet", {}).text);
    ctx.log("log", "Script", "name:" + ctx.invokeFunction(kid, "Name", {}).text);
    ctx.invokeCustomEvent(kid, "Ping", {});
    ctx.invokeCustomEvent(rebel, "Ping", {});
    ctx.log("log", "Script", "iface-greet:" + ctx.callInterface(kid, "iface-greeter", "Greet", {}).text);
    ctx.log("log", "Script", "iface-name:" + ctx.callInterface(kid, "iface-greeter", "Name", {}).text);
  }
`, ["Run"]);

describe("user class inheritance at runtime", () => {
  it("runs inherited lifecycle events once and lets Call Parent reach the nearest implementation", async () => {
    const registry = createDefaultNodeRegistry();
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneOf([
        createActor("kid", "Kid", { classId: "Child" }),
        createActor("rebel", "Rebel", { classId: "Override" }),
        createActor("loyal", "Loyal", { classId: "Loyal" }),
        createActor("heir", "Heir", { classId: "Heir" }),
      ]),
      onCommand: (command) => commands.push(command),
    });
    try {
      await runtime.loadScripts([
        parentScript,
        childScript,
        overrideScript,
        // Loyal : Parent calls the parent that implements Begin Play.
        callParentScript(registry, "Loyal", "Parent"),
        // Heir : Child calls Child, which inherits Begin Play from Parent.
        callParentScript(registry, "Heir", "Child"),
      ]);
      runtime.realizePlayWorld();
      runtime.start();
      runtime.tick();
      expect(scriptLogs(commands)).toEqual([
        "Parent.beginPlay@Child",
        "Override.beginPlay",
        "Loyal.beginPlay",
        "Parent.beginPlay@Loyal",
        "Heir.beginPlay",
        "Parent.beginPlay@Heir",
        "Parent.tick@Child",
        "Parent.tick@Override",
        "Parent.tick@Loyal",
        "Parent.tick@Heir",
      ]);
    } finally {
      runtime.stop();
    }
  });

  it("resolves inherited functions, custom events and interface handlers on a child instance", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      playScene: sceneOf([
        createActor("kid", "Kid", { classId: "Child" }),
        createActor("rebel", "Rebel", { classId: "Override" }),
        createActor("probe", "Probe", { classId: "Probe" }),
      ]),
      onCommand: (command) => commands.push(command),
    });
    try {
      await runtime.loadScripts([parentScript, childScript, overrideScript, probeScript]);
      runtime.realizePlayWorld();
      runtime.start();
      const world = runtime.getWorld();
      commands.length = 0;
      runtime.invokeScriptEvent("Probe", "Run", world.findActor("probe"), {
        kid: world.findActor("kid"),
        rebel: world.findActor("rebel"),
      });
      expect(scriptLogs(commands)).toEqual([
        "greet:Parent.greet@Child",
        "name:Child",
        "Parent.ping@Child",
        "Override.ping",
        "iface-greet:Parent.greet@Child",
        "iface-name:Child",
      ]);
    } finally {
      runtime.stop();
    }
  });

  it("keeps user parent ancestry when child scripts load before their parents", async () => {
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({
      seed: 1,
      seedDemoActors: false,
      preferSoftwarePhysics: true,
      gameInstanceClass: "LeafGI",
      playScene: sceneOf([]),
      onCommand: (command) => commands.push(command),
    });
    try {
      await runtime.loadScripts([
        classScript("LeafGI", "MidGI", `
          export function onInit(ctx) { ctx.log("log", "Script", "LeafGI.init"); }
        `, ["onInit"]),
        classScript("MidGI", "BaseGI", ""),
        classScript("BaseGI", "GameInstance", ""),
      ]);
      runtime.realizePlayWorld();
      expect(scriptLogs(commands)).toEqual(["LeafGI.init"]);
      expect(runtime.getWorld().classRegistry.ancestry("LeafGI")).toEqual([
        "LeafGI", "MidGI", "BaseGI", "GameInstance", "BObject",
      ]);
    } finally {
      runtime.stop();
    }
  });

  it("registers every class of a parent cycle without looping", async () => {
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true });
    try {
      await runtime.loadScripts([
        classScript("Loop", "Knot", ""),
        classScript("Knot", "Loop", ""),
      ]);
      const classes = runtime.getWorld().classRegistry;
      for (const classId of ["Loop", "Knot"]) {
        expect(classes.has(classId)).toBe(true);
        expect(classes.ancestry(classId).slice(-2)).toEqual(["Actor", "BObject"]);
      }
    } finally {
      runtime.stop();
    }
  });
});
