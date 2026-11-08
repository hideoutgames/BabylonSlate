import { describe, expect, it } from "vitest";
import { createActor, createMeshComponent, rotatorToQuat, type SerializedComponent } from "@haptic/core";
import { ActorComponent } from "@haptic/object-model";
import type { CommandMessage } from "@haptic/bridge";
import type { GraphEdge, GraphNode, LogicGraph } from "@haptic/scripting";
import { createDefaultNodeRegistry } from "@haptic/scripting-nodes";
import { compileClassScript, graphNode, startGraphScenario, wire } from "./testing/graph-scenario";

const registry = createDefaultNodeRegistry();
/** Enemy (1) with child Enemy.Boss (2), and Friend (3). */
const TAG_REGISTRY = { tags: [{ id: 1, path: "Enemy", parentId: 0 }, { id: 2, path: "Enemy.Boss", parentId: 1 }, { id: 3, path: "Friend", parentId: 0 }], nextId: 4 };

type Step = { node: GraphNode; execIn?: string; execOut?: string } | { print: [nodeId: string, pinId: string] };

/** Begin Play → each step in order: an exec node, or a Print of a source output. */
function beginPlay(steps: Step[], sources: GraphNode[] = [], extra: GraphEdge[] = []): LogicGraph {
  const nodes: GraphNode[] = [graphNode(registry, "begin", "flow.event.beginPlay"), ...sources];
  const edges: GraphEdge[] = [...extra];
  let previous = "begin";
  steps.forEach((step, index) => {
    const node = "node" in step ? step.node : graphNode(registry, `print${index}`, "debug.print");
    nodes.push(node);
    edges.push(wire(previous, "execOut", node.id, "node" in step ? step.execIn ?? "execIn" : "execIn"));
    if ("print" in step) edges.push(wire(step.print[0], step.print[1], node.id, "value"));
    previous = node.id;
  });
  return { id: "event-graph", kind: "event", nodes, edges };
}

function component(id: string, position: [number, number, number], parentId: string | null = null): SerializedComponent {
  return { ...createMeshComponent(id, "box"), parentId, transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] } };
}

async function play(graph: LogicGraph, actors: ReturnType<typeof createActor>[]) {
  const scenario = await startGraphScenario({
    scripts: [compileClassScript({ registry, classId: "Probe", graph, compile: { tagRegistry: TAG_REGISTRY } })],
    actors,
  });
  await scenario.tick();
  return scenario;
}

function printed(commands: readonly CommandMessage[]): string[] {
  return commands.flatMap((command) => command.type === "print" ? [command.message] : []);
}

const meshOf = (id: string) => graphNode(registry, id, "component.get", { "default:classId": "MeshComponent" });

describe("Visibility nodes", () => {
  it("hide an actor, and hide a component's drawing while it keeps its place and its light", async () => {
    const graph = beginPlay([
      { node: graphNode(registry, "hide", "actor.setHiddenInGame") },
      { print: ["hidden", "hidden"] },
      { node: graphNode(registry, "show", "actor.setHiddenInGame", { "default:hidden": false }) },
      { print: ["hidden", "hidden"] },
      { node: graphNode(registry, "invisible", "component.setVisibility") },
      { print: ["visible", "visible"] },
    ], [graphNode(registry, "hidden", "actor.isHiddenInGame"), meshOf("mesh"), graphNode(registry, "visible", "component.isVisible")],
    [wire("mesh", "out", "invisible", "target"), wire("mesh", "out", "visible", "target")]);
    const scenario = await play(graph, [createActor("probe", "Probe", { classId: "Probe", components: [component("body", [0, 0, 0]), component("hat", [0, 1, 0], "body")] })]);
    scenario.stop();

    expect(scenario.diagnostics()).toEqual([]);
    expect(printed(scenario.commands)).toEqual(["true", "false", "false"]);
    const assignments = scenario.commands.filter((command): command is Extract<CommandMessage, { type: "assignMesh" }> => command.type === "assignMesh");
    const parts = assignments.at(-1)?.parts ?? [];
    // Only the body is hidden; the hat attached to it still draws, at the body's place.
    expect(parts.map((part) => [part.componentId, part.hidden === true, part.parentId ?? null]))
      .toEqual([["body", true, null], ["hat", false, "body"]]);
  });
});

describe("Component transform nodes", () => {
  it("read and write a component's place relative to its parent and in the world", async () => {
    const actorAt = { position: [10, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [2, 2, 2] as [number, number, number] };
    const graph = beginPlay([
      { print: ["world", "out"] },
      { node: graphNode(registry, "move", "transform.setComponentWorldLocation", { "default:value": { x: 0, y: 0, z: 0 } }) },
      { print: ["relative", "out"] },
      { node: graphNode(registry, "scale", "transform.setComponentRelativeScale", { "default:value": { x: 3, y: 3, z: 3 } }) },
      { print: ["worldScale", "out"] },
    ], [meshOf("mesh"), graphNode(registry, "world", "transform.getComponentWorldLocation"),
      graphNode(registry, "relative", "transform.getComponentRelativeLocation"), graphNode(registry, "worldScale", "transform.getComponentWorldScale")],
    [wire("mesh", "out", "world", "target"), wire("mesh", "out", "move", "target"), wire("mesh", "out", "relative", "target"),
      wire("mesh", "out", "scale", "target"), wire("mesh", "out", "worldScale", "target")]);
    const scenario = await play(graph, [createActor("probe", "Probe", { classId: "Probe", transform: actorAt, components: [component("body", [1, 2, 3])] })]);
    const body = scenario.runtime.getWorld().getActors()[0]!.components.find((entry) => entry instanceof ActorComponent)!;
    scenario.stop();

    expect(scenario.diagnostics()).toEqual([]);
    // The actor's scale of 2 doubles the body's offset; the world origin is (-5, 0, 0) relative to the actor.
    expect(printed(scenario.commands)).toEqual(["{x: 12, y: 4, z: 6}", "{x: -5, y: 0, z: 0}", "{x: 6, y: 6, z: 6}"]);
    expect(body.transform.position).toEqual({ x: -5, y: 0, z: 0 });
    expect(body.transform.scale).toEqual({ x: 3, y: 3, z: 3 });
  });
});

describe("Actor offset, rotation and distance nodes", () => {
  it("move along the actor's own axes, turn it locally and in the world, teleport it and measure between actors", async () => {
    const graph = beginPlay([
      { node: graphNode(registry, "turn", "transform.addWorldRotation", { "default:rotation": { pitch: 0, yaw: 90, roll: 0 } }) },
      { node: graphNode(registry, "offset", "transform.addLocalOffset", { "default:offset": { x: 0, y: 0, z: 1 } }) },
      { print: ["distance", "distance"] },
      { node: graphNode(registry, "teleport", "transform.teleport", { "default:location": { x: 5, y: 0, z: 0 }, "default:rotation": { pitch: 0, yaw: 0, roll: 0 } }) },
      { print: ["distance", "distance"] },
    ], [graphNode(registry, "others", "actor.getAllOfClass", { "default:classId": "Actor" }),
      graphNode(registry, "last", "array.last"), graphNode(registry, "distance", "actor.getDistanceTo")],
    [wire("others", "out", "last", "array"), wire("last", "out", "distance", "other")]);
    const scenario = await play(graph, [
      createActor("probe", "Probe", { classId: "Probe" }),
      createActor("rock", "Rock", { transform: { position: [5, 0, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }),
    ]);
    const probe = scenario.runtime.getWorld().getActors()[0]!;
    scenario.stop();

    expect(scenario.diagnostics()).toEqual([]);
    const turned = rotatorToQuat({ pitch: 0, yaw: 90, roll: 0 });
    // Teleport left the yaw it set (0); before it, one unit along the turned local Z.
    expect(probe.transform.position).toEqual({ x: 5, y: 0, z: 0 });
    expect(probe.transform.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    const [beforeTeleport, afterTeleport] = printed(scenario.commands).map(Number);
    const moved = { x: 2 * (turned.w * turned.y), z: 1 - 2 * turned.y * turned.y };
    expect(beforeTeleport).toBeCloseTo(Math.hypot(5 - moved.x, 3 - moved.z), 6);
    expect(afterTeleport).toBeCloseTo(3, 6);
  });
});

describe("Actor Tags", () => {
  it("start from the Class and the placed actor, change in Play, and find actors by Tag and its children", async () => {
    const enemy = 1;
    const graph = beginPlay([
      { print: ["found", "out"] },
      { node: graphNode(registry, "add", "tags.addActorTag", { "default:tag": enemy }) },
      { print: ["found", "out"] },
      { print: ["has", "out"] },
      { node: graphNode(registry, "remove", "tags.removeActorTag", { "default:tag": enemy }) },
      { print: ["has", "out"] },
    ], [
      graphNode(registry, "all", "tags.getAllActorsWithTag", { "default:tag": enemy }),
      graphNode(registry, "found", "array.length"),
      graphNode(registry, "has", "tags.actorHasTag", { "default:tag": enemy, "default:exact": true }),
    ], [wire("all", "actors", "found", "array")]);
    const scenario = await play(graph, [
      createActor("probe", "Probe", { classId: "Probe" }),
      createActor("boss", "Boss", { properties: { actorTags: { Tags: [2] } } }),
      createActor("ally", "Ally", { properties: { actorTags: { Tags: [3] } } }),
    ]);
    scenario.stop();

    expect(scenario.diagnostics()).toEqual([]);
    // Enemy matches the Boss's Enemy.Boss; Exact Match needs Enemy itself.
    expect(printed(scenario.commands)).toEqual(["1", "2", "true", "false"]);
  });
});

describe("Class nodes", () => {
  it("read an object's Class and name and compare Classes", async () => {
    const graph = beginPlay([
      { print: ["class", "class"] },
      { print: ["child", "out"] },
      { print: ["notChild", "out"] },
      { print: ["name", "name"] },
    ], [
      graphNode(registry, "self", "actor.getSelf"),
      graphNode(registry, "class", "object.getClass"),
      graphNode(registry, "child", "object.classIsChildOf", { "default:testClass": "Probe", "default:parentClass": "Actor" }),
      graphNode(registry, "notChild", "object.classIsChildOf", { "default:testClass": "Actor", "default:parentClass": "Probe" }),
      graphNode(registry, "name", "object.getDisplayName"),
    ], [wire("self", "out", "class", "object"), wire("self", "out", "name", "object")]);
    const scenario = await play(graph, [createActor("probe", "Probe Prime", { classId: "Probe" })]);
    scenario.stop();

    expect(scenario.diagnostics()).toEqual([]);
    expect(printed(scenario.commands)).toEqual(["Probe", "true", "false", "Probe Prime"]);
  });
});
