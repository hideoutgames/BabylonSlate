import { describe, expect, it } from "vitest";
import { createActor } from "@haptic/core";
import { Actor } from "@haptic/object-model";
import type { GraphEdge, GraphNode, LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { ScriptHost, type CompiledScript, type ScriptHostServices } from "./script-host";
import { DISPATCHER_MAX_DEPTH } from "./script-dispatchers";
import { compileClassScript, graphNode, startGraphScenario, wire } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();

const ON_DAMAGED = {
  name: "On Damaged",
  classId: "Hero",
  implicitSelf: true,
  pins: [
    { name: "Damage", typeId: "float", direction: "in" },
    { name: "Source", typeId: "string", direction: "in" },
  ],
};

/** A custom event taking a Float and a String, logging both under its own category. */
function listener(id: string, name: string, params: [string, string]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  return {
    nodes: [
      graphNode(registry, id, "flow.event.custom", {
        name,
        pins: [
          { name: params[0], typeId: "float", direction: "out" },
          { name: params[1], typeId: "string", direction: "out" },
        ],
      }),
      graphNode(registry, `${id}-amount`, "debug.log", { category: name }),
      graphNode(registry, `${id}-source`, "debug.log", { category: name }),
    ],
    edges: [
      wire(id, "execOut", `${id}-amount`, "execIn"),
      wire(`${id}-amount`, "execOut", `${id}-source`, "execIn"),
      wire(id, params[0], `${id}-amount`, "message"),
      wire(id, params[1], `${id}-source`, "message"),
    ],
  };
}

type Step =
  | { action: "bind" | "unbind"; listener: string }
  | { action: "unbindAll" }
  | { action: "call"; damage: number; source: string };

const STEP_TYPES = {
  bind: "flow.dispatcher.bind",
  unbind: "flow.dispatcher.unbind",
  unbindAll: "flow.dispatcher.unbindAll",
  call: "flow.dispatcher.call",
} as const;

/** Begin Play runs `steps` in order on the Hero's own On Damaged; First and Second listen. */
function dispatcherGraph(steps: readonly Step[]): LogicGraph {
  const first = listener("first", "First", ["Amount", "From"]);
  const second = listener("second", "Second", ["Value", "Origin"]);
  const nodes: GraphNode[] = [graphNode(registry, "begin", "flow.event.beginPlay"), ...first.nodes, ...second.nodes];
  const edges: GraphEdge[] = [...first.edges, ...second.edges];
  let previous = "begin";
  steps.forEach((step, index) => {
    const id = `step${index}`;
    const properties: Record<string, unknown> = { ...ON_DAMAGED };
    if (step.action === "call") {
      properties["default:Damage"] = step.damage;
      properties["default:Source"] = step.source;
    }
    nodes.push(graphNode(registry, id, STEP_TYPES[step.action], properties));
    edges.push(wire(previous, "execOut", id, "execIn"));
    if (step.action === "bind" || step.action === "unbind") {
      edges.push(wire(step.listener, "OutputDelegate", id, "event"));
    }
    previous = id;
  });
  return { id: "event-graph", kind: "event", nodes, edges };
}

async function run(steps: readonly Step[]) {
  const scenario = await startGraphScenario({
    scripts: [compileClassScript({ registry, classId: "Hero", graph: dispatcherGraph(steps) })],
    actors: [createActor("hero", "Hero", { classId: "Hero" })],
  });
  scenario.stop();
  return scenario.commands.flatMap((command) =>
    command.type === "log" && (command.category === "First" || command.category === "Second")
      ? [`${command.category}: ${command.message}`]
      : []);
}

describe("Event Dispatcher nodes", () => {
  it("runs every bound event in bind order, passing the Call's values by position", async () => {
    expect(await run([
      { action: "bind", listener: "second" },
      { action: "bind", listener: "first" },
      { action: "call", damage: 5, source: "Trap" },
    ])).toEqual(["Second: 5", "Second: Trap", "First: 5", "First: Trap"]);
  });

  it("keeps one binding when the same event is bound twice", async () => {
    expect(await run([
      { action: "bind", listener: "first" },
      { action: "bind", listener: "first" },
      { action: "call", damage: 2, source: "Fall" },
    ])).toEqual(["First: 2", "First: Fall"]);
  });

  it("stops running an unbound event and runs none after Unbind All", async () => {
    expect(await run([
      { action: "bind", listener: "first" },
      { action: "bind", listener: "second" },
      { action: "unbind", listener: "first" },
      { action: "call", damage: 1, source: "A" },
      { action: "unbindAll" },
      { action: "call", damage: 9, source: "B" },
    ])).toEqual(["Second: 1", "Second: A"]);
  });

  it("does nothing when nothing is bound", async () => {
    expect(await run([{ action: "call", damage: 3, source: "C" }])).toEqual([]);
  });
});

function services(log: string[], extras: Partial<ScriptHostServices> = {}): ScriptHostServices {
  return {
    log: (_severity, category, message) => { log.push(`${category}: ${message}`); },
    print: () => {},
    destroyActor: () => {},
    executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {},
    reportError: () => {},
    ...extras,
  };
}

/** A hand-written class module whose `events` are entry points, as compiled custom events are. */
function script(classId: string, source: string, events: readonly string[] = []): CompiledScript {
  return {
    assetGuid: `${classId}-asset`, classId, source, anchors: [],
    entryPoints: events.map((name) => ({ name, event: name, isAsync: false })),
  };
}

describe("Event Dispatcher bindings", () => {
  it("runs a function bound through Create Event with the Call's values under its parameter names", async () => {
    const log: string[] = [];
    const host = new ScriptHost(services(log));
    await host.load(script("Hero", [
      "export function Heal(ctx) { ctx.log('log', 'Heal', `${ctx.args.Amount} from ${ctx.args.Healer}`); }",
    ].join("\n")));
    const hero = new Actor({ classId: "Hero", guid: "hero" });
    const ctx = host.createContext(hero, 0, 0);

    ctx.bindDispatcher(hero, "On_Healed", ctx.eventDelegate(hero, "Heal", "function", ["Amount", "Healer"]));
    ctx.callDispatcher(hero, "On_Healed", [4, "Medic"]);

    expect(log).toEqual(["Heal: 4 from Medic"]);
  });

  it("skips and drops a destroyed listener, and unbinds by object and member", async () => {
    const log: string[] = [];
    const host = new ScriptHost(services(log));
    await host.load(script("Bar", "export function Seen(ctx) { ctx.log('log', 'Seen', ctx.self.guid); }", ["Seen"]));
    const owner = new Actor({ classId: "Enemy", guid: "enemy" });
    const kept = new Actor({ classId: "Bar", guid: "kept" });
    const gone = new Actor({ classId: "Bar", guid: "gone" });
    const ctx = host.createContext(owner, 0, 0);

    ctx.bindDispatcher(owner, "On_Died", ctx.eventDelegate(gone, "Seen", "event", []));
    ctx.bindDispatcher(owner, "On_Died", ctx.eventDelegate(kept, "Seen", "event", []));
    gone.destroyed = true;
    ctx.callDispatcher(owner, "On_Died", []);
    gone.destroyed = false;
    ctx.callDispatcher(owner, "On_Died", []);
    // A second delegate value for the same object and member unbinds the first.
    ctx.unbindDispatcher(owner, "On_Died", ctx.eventDelegate(kept, "Seen", "event", []));
    ctx.callDispatcher(owner, "On_Died", []);

    expect(log).toEqual(["Seen: kept", "Seen: kept"]);
  });

  it("finishes a Call over the bindings it started with, skipping ones removed meanwhile", async () => {
    const log: string[] = [];
    const host = new ScriptHost(services(log));
    await host.load(script("Bar", [
      "export function First(ctx) {",
      "  ctx.log('log', 'Run', 'first');",
      "  const owner = ctx.getVariable('owner');",
      "  ctx.unbindDispatcher(owner, 'Ping', ctx.eventDelegate(ctx.self, 'Second', 'event', []));",
      "  ctx.bindDispatcher(owner, 'Ping', ctx.eventDelegate(ctx.self, 'Third', 'event', []));",
      "}",
      "export function Second(ctx) { ctx.log('log', 'Run', 'second'); }",
      "export function Third(ctx) { ctx.log('log', 'Run', 'third'); }",
    ].join("\n"), ["First", "Second", "Third"]));
    const owner = new Actor({ classId: "Enemy", guid: "enemy" });
    const bar = new Actor({ classId: "Bar", guid: "bar" });
    bar.setVariable("owner", owner);
    const ctx = host.createContext(owner, 0, 0);
    for (const name of ["First", "Second"]) {
      ctx.bindDispatcher(owner, "Ping", ctx.eventDelegate(bar, name, "event", []));
    }

    ctx.callDispatcher(owner, "Ping", []);
    ctx.callDispatcher(owner, "Ping", []);

    expect(log).toEqual(["Run: first", "Run: first", "Run: third"]);
  });

  it("skips a Call nested deeper than the limit inside its own listeners and reports it", async () => {
    const log: string[] = [];
    const host = new ScriptHost(services(log));
    await host.load(script("Echo", [
      "export function Again(ctx) {",
      "  ctx.setVariable('depth', (ctx.getVariable('depth') ?? 0) + 1);",
      "  ctx.callDispatcher(ctx.self, 'Echo', []);",
      "}",
    ].join("\n"), ["Again"]));
    const echo = new Actor({ classId: "Echo", guid: "echo" });
    const ctx = host.createContext(echo, 0, 0);
    ctx.bindDispatcher(echo, "Echo", ctx.eventDelegate(echo, "Again", "event", []));

    ctx.callDispatcher(echo, "Echo", []);

    expect(echo.getVariable("depth")).toBe(DISPATCHER_MAX_DEPTH);
    expect(log).toEqual([
      `Script: Event Dispatcher "Echo" was called inside its own listeners more than ${DISPATCHER_MAX_DEPTH} times; the deeper Calls were skipped.`,
    ]);
  });

  it("forgets a destroyed owner's bindings after its last event", async () => {
    const log: string[] = [];
    const host = new ScriptHost(services(log));
    await host.load(script("Bar", "export function Seen(ctx) { ctx.log('log', 'Seen', ctx.self.guid); }", ["Seen"]));
    await host.load(script("Enemy", "export function onDestroyed(ctx) { ctx.callDispatcher(ctx.self, 'On_Died', []); }", ["onDestroyed"]));
    const enemy = new Actor({ classId: "Enemy", guid: "enemy" });
    const bar = new Actor({ classId: "Bar", guid: "bar" });
    const ctx = host.createContext(enemy, 0, 0);
    ctx.bindDispatcher(enemy, "On_Died", ctx.eventDelegate(bar, "Seen", "event", []));

    host.hooksFor("Enemy")!.onDestroyed!(enemy);
    ctx.callDispatcher(enemy, "On_Died", []);

    expect(log).toEqual(["Seen: bar"]);
  });
});
