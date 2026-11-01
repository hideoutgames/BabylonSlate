import { afterEach, describe, expect, it } from "vitest";
import { createActor } from "@haptic/core";
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
    expect(scenario.logs("Script")).toEqual(["Hero: Get Actor Name (Target) tried to access a destroyed object."]);
  });
});
