import { afterEach, describe, expect, it } from "vitest";
import { createActor, createDefaultSceneSettings, type SerializedScene } from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import { createInProcessRuntime } from "./driver";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire, type GraphScenario } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();
const target = { variableName: "Target", typeId: "object", typeClassId: "Victim", implicitSelf: true };
const log = (id: string, message: string) =>
  graphNode(registry, id, "debug.log", { category: "Scenario", "default:message": message });

/**
 * Begin Play stores the Victim in Target and destroys it. Each Tick then asks
 * Is Valid, Validated Get, Cast and Get Actor Name about the stored reference.
 */
const hero = compileClassScript({
  registry,
  classId: "Hero",
  graph: {
    id: "event-graph",
    kind: "event",
    nodes: [
      graphNode(registry, "begin", "flow.event.beginPlay"),
      graphNode(registry, "find", "actor.getOfClass", { "default:classId": "Victim" }),
      graphNode(registry, "store", "variables.set", target),
      graphNode(registry, "destroy", "actor.destroy"),
      graphNode(registry, "tick", "flow.event.tick"),
      graphNode(registry, "read1", "variables.get", target),
      graphNode(registry, "isValid", "actor.isValid"),
      graphNode(registry, "branch", "flow.branch"),
      log("valid", "valid"),
      log("invalid", "invalid"),
      graphNode(registry, "validated", "variables.getValidated", target),
      log("validatedYes", "validated"),
      log("validatedNo", "not validated"),
      graphNode(registry, "read2", "variables.get", target),
      graphNode(registry, "cast", "casting.cast", { "default:class": "Victim" }),
      graphNode(registry, "castBranch", "flow.branch"),
      log("castYes", "cast"),
      log("castNo", "cast failed"),
      graphNode(registry, "read3", "variables.get", target),
      graphNode(registry, "name", "actor.getName"),
      graphNode(registry, "nameLog", "debug.log", { category: "Name" }),
    ],
    edges: [
      wire("begin", "execOut", "store", "execIn"),
      wire("find", "out", "store", "value"),
      wire("store", "execOut", "destroy", "execIn"),
      wire("find", "out", "destroy", "target"),
      wire("tick", "execOut", "branch", "execIn"),
      wire("read1", "value", "isValid", "target"),
      wire("isValid", "out", "branch", "condition"),
      wire("branch", "true", "valid", "execIn"),
      wire("branch", "false", "invalid", "execIn"),
      wire("valid", "execOut", "validated", "execIn"),
      wire("invalid", "execOut", "validated", "execIn"),
      wire("validated", "isValid", "validatedYes", "execIn"),
      wire("validated", "notValid", "validatedNo", "execIn"),
      wire("validatedYes", "execOut", "cast", "execIn"),
      wire("validatedNo", "execOut", "cast", "execIn"),
      wire("read2", "value", "cast", "object"),
      wire("cast", "execOut", "castBranch", "execIn"),
      wire("cast", "success", "castBranch", "condition"),
      wire("castBranch", "true", "castYes", "execIn"),
      wire("castBranch", "false", "castNo", "execIn"),
      wire("castYes", "execOut", "nameLog", "execIn"),
      wire("castNo", "execOut", "nameLog", "execIn"),
      wire("read3", "value", "name", "target"),
      wire("name", "out", "nameLog", "message"),
    ],
  },
});
const victim = compileClassScript({
  registry,
  classId: "Victim",
  graph: { id: "event-graph", kind: "event", nodes: [], edges: [] },
});

let scenario: GraphScenario | null = null;
afterEach(() => scenario?.stop());

describe("a stored reference to a destroyed actor", () => {
  it("reads as not valid to Is Valid, Validated Get and Cast, and guarded nodes skip it with an error", async () => {
    scenario = await startGraphScenario({
      scripts: [hero, victim],
      actors: [createActor("hero-1", "Hero", { classId: "Hero" }), createActor("victim-1", "Rook", { classId: "Victim" })],
    });
    // Begin Play's Destroy Actor commits when the next tick starts, before actors tick.
    await scenario.tick();
    expect(scenario.runtime.getWorld().findActor("victim-1")).toBeUndefined();
    expect(scenario.logs("Scenario")).toEqual(["invalid", "not validated", "cast failed"]);
    // Get Actor Name skipped the destroyed actor: its output is the empty default, not "Rook".
    expect(scenario.logs("Name")).toEqual([""]);
    // Is Valid, Validated Get and Cast report nothing; only the node that used the object does, at its node.
    expect(scenario.logs("Script")).toEqual(['Tried to call "Get Actor Name" on null of type "Victim"']);
    expect(scenario.diagnostics()).toEqual([expect.objectContaining({
      code: "runtime.destroyedAccess", severity: "error", message: 'Tried to call "Get Actor Name" on null of type "Victim"',
      assetGuid: hero.assetGuid, graphId: "event-graph", nodeId: "name",
    })]);
    // The same access every tick reports once.
    await scenario.tick(3);
    expect(scenario.logs("Name")).toEqual(["", "", "", ""]);
    expect(scenario.diagnostics()).toHaveLength(1);
  });
});

/**
 * Begin Play stores the Victim and destroys it. Each Tick reads, writes and calls the stored reference through
 * hand-written script calls, which find the node on the stack.
 */
const toucher = (source: string) => compileClassScript({
  registry,
  classId: "Toucher",
  graph: {
    id: "event-graph",
    kind: "event",
    nodes: [
      graphNode(registry, "begin", "flow.event.beginPlay"),
      graphNode(registry, "find", "actor.getOfClass", { "default:classId": "Victim" }),
      graphNode(registry, "store", "variables.set", target),
      graphNode(registry, "destroy", "actor.destroy"),
      graphNode(registry, "tick", "flow.event.tick"),
      graphNode(registry, "touch", "debug.executeJavaScript", { body: source }),
    ],
    edges: [
      wire("begin", "execOut", "store", "execIn"),
      wire("find", "out", "store", "value"),
      wire("store", "execOut", "destroy", "execIn"),
      wire("find", "out", "destroy", "target"),
      wire("tick", "execOut", "touch", "execIn"),
    ],
  },
});

describe("script calls on a destroyed object", () => {
  it("read null, write and call nothing, and report each access once", async () => {
    const victimWithState = compileClassScript({ registry, classId: "Victim", graph: { id: "event-graph", kind: "event", nodes: [], edges: [] } });
    scenario = await startGraphScenario({
      scripts: [victimWithState, toucher(`
        const gone = ctx.getVariable("Target");
        ctx.setVariable("read", ctx.getVariableFrom(gone, "health"));
        ctx.setVariableOn(gone, "health", 5);
        ctx.setVariable("called", ctx.invokeFunction(gone, "Heal", {}));
      `)],
      actors: [createActor("toucher-1", "Toucher", { classId: "Toucher" }), createActor("victim-1", "Rook", { classId: "Victim" })],
    });
    const victimActor = scenario.runtime.getWorld().findActor("victim-1")!;
    victimActor.setVariable("health", 3);
    await scenario.tick(3);
    const toucherActor = scenario.runtime.getWorld().findActor("toucher-1")!;
    expect(victimActor.destroyed).toBe(true);
    // The destroyed actor's state is gone, and nothing wrote it again.
    expect(victimActor.getVariable("health")).toBeUndefined();
    expect(toucherActor.getVariable("read")).toBeNull();
    expect(toucherActor.getVariable("called")).toEqual({});
    expect(scenario.diagnostics().map((diagnostic) => [diagnostic.code, diagnostic.message, diagnostic.nodeId])).toEqual([
      ["runtime.destroyedAccess", 'Tried to access "health" from null of type "Victim"', "touch"],
      ["runtime.destroyedAccess", 'Tried to set "health" on null of type "Victim"', "touch"],
      ["runtime.destroyedAccess", 'Tried to call "Heal" on null of type "Victim"', "touch"],
    ]);
  });
});

describe("an ordinary scene change", () => {
  it("tears down many scripted actors, whose own End still reads their state, without a destroyed-access report", async () => {
    // Each Guard keeps a reference to the next, reads its own variable in its End and ticks a counter.
    const guard = compileClassScript({
      registry,
      classId: "Guard",
      graph: {
        id: "event-graph",
        kind: "event",
        nodes: [
          graphNode(registry, "tick", "flow.event.tick"),
          graphNode(registry, "readCount", "variables.get", { variableName: "Count", typeId: "float", implicitSelf: true }),
          graphNode(registry, "add", "math.add"),
          graphNode(registry, "writeCount", "variables.set", { variableName: "Count", typeId: "float", implicitSelf: true }),
          graphNode(registry, "end", "flow.event.destroyed"),
          graphNode(registry, "readOwn", "variables.get", { variableName: "Count", typeId: "float", implicitSelf: true }),
          graphNode(registry, "endLog", "debug.log", { category: "End" }),
        ],
        edges: [
          wire("tick", "execOut", "writeCount", "execIn"),
          wire("readCount", "value", "add", "a"),
          wire("add", "out", "writeCount", "value"),
          wire("end", "execOut", "endLog", "execIn"),
          wire("readOwn", "value", "endLog", "message"),
        ],
      },
    });
    const scene = (name: string, count: number): SerializedScene => ({
      name, viewportMode: "3d", settings: createDefaultSceneSettings(), folders: [],
      actors: Array.from({ length: count }, (_, index) => createActor(`${name}-${index}`, `Guard ${index}`, { classId: "Guard" })),
    });
    const commands: CommandMessage[] = [];
    const runtime = createInProcessRuntime({ seed: 1, preferSoftwarePhysics: true, playScene: scene("Level1", 200),
      sceneLibrary: { Level2: scene("Level2", 1) }, onCommand: (command) => commands.push(command) });
    try {
      await runtime.loadScripts([guard]);
      runtime.realizePlayWorld();
      runtime.start();
      runtime.tick();
      runtime.tick();
      expect(runtime.executeConsoleCommand("changescene Level2").success).toBe(true);
      runtime.tick();
      expect(runtime.getWorld().getActors()).toHaveLength(1);
      expect(commands.filter((command) => command.type === "log" && command.category === "End")).toHaveLength(200);
      expect(commands.filter((command) => command.type === "diagnostic")).toEqual([]);
    } finally { runtime.stop(); }
  });
});
