import { afterEach, expect, it } from "vitest";
import { buildBoxGlbFixture, cookComplexCollisionMesh, normalizeModelPayload } from "@babylonslate/assets";
import type { CommandMessage, ControlMessage } from "@babylonslate/bridge";
import { createInProcessRuntime, type RuntimeDriver } from "./driver";
import { applyRuntimeSourceControl } from "./source-content-control";
import type { CompiledScript } from "./script-host";

/** A Class that exists only to be spawned at runtime; its prefab Mesh uses Complex Collision. */
const prefab = (classId: string, assetGuid: string): CompiledScript => ({
  assetGuid: `${classId}-class`, classId, parentClassId: "Actor", anchors: [], entryPoints: [], source: "",
  components: [{ id: "mesh", classId: "MeshComponent", properties: { assetGuid, collisionMode: "complex" } }],
});
const box = cookComplexCollisionMesh(buildBoxGlbFixture(1))!;
const at = (x: number) => ({ position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } });

let runtime: RuntimeDriver | undefined;
afterEach(() => runtime?.stop());

function start(commands: CommandMessage[]) {
  runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true, onCommand: (command) => commands.push(command) });
  return runtime;
}

/** Host → worker delivery: postMessage structured-clones the control, typed arrays included. */
const deliver = (target: RuntimeDriver, control: ControlMessage) => applyRuntimeSourceControl(target, structuredClone(control));

const overlapping = (target: RuntimeDriver, x: number) =>
  target.getPhysicsSync()!.getBackend().sphereOverlap({ x, y: 0, z: 0 }, 0.2).actorIds;

it("collides a runtime-spawned Class prefab with a typed mesh delivered by loadModels", async () => {
  const commands: CommandMessage[] = [];
  const target = start(commands);
  await target.loadScripts([prefab("Rock", "rock-model")]);
  await deliver(target, {
    type: "loadModels",
    models: [{ guid: "rock-model", document: normalizeModelPayload({}) }],
    complexMeshes: [{ guid: "rock-model", positions: box.positions, indices: box.indices }],
  });
  target.start();
  const rock = target.spawnScriptedActor({ classId: "Rock", transform: at(5) })!;
  target.tick();
  expect(overlapping(target, 5)).toContain(rock.guid);
  expect(commands.some((command) => command.type === "requestComplexCollision")).toBe(false);
});

it("requests a missing mesh once, then builds the collider when the host answers", async () => {
  const commands: CommandMessage[] = [];
  const target = start(commands);
  await target.loadScripts([prefab("Rock", "rock-model"), prefab("Statue", "statue-model")]);
  await deliver(target, { type: "loadModels", models: [{ guid: "rock-model", document: normalizeModelPayload({}) }] });
  target.start();
  const rocks = [target.spawnScriptedActor({ classId: "Rock", transform: at(5) })!, target.spawnScriptedActor({ classId: "Rock", transform: at(-5) })!];
  const statue = target.spawnScriptedActor({ classId: "Statue", transform: at(10) })!;
  for (let tick = 0; tick < 3; tick++) target.tick();
  const requests = () => commands.flatMap((command) => command.type === "requestComplexCollision" ? [command.assetGuid] : []);
  expect(requests().sort()).toEqual(["rock-model", "statue-model"]);
  // Until the answer arrives the Mesh contributes no collider.
  expect(overlapping(target, 5)).toEqual([]);

  await deliver(target, { type: "loadComplexCollision", meshes: [{ guid: "rock-model", positions: box.positions, indices: box.indices }] });
  await deliver(target, { type: "loadComplexCollision", meshes: [], unavailable: ["statue-model"] });
  target.tick();
  expect(overlapping(target, 5)).toContain(rocks[0]!.guid);
  expect(overlapping(target, -5)).toContain(rocks[1]!.guid);
  expect(overlapping(target, 10)).not.toContain(statue.guid);
  // A later loadModels replacement keeps the on-demand mesh instead of asking again.
  await deliver(target, { type: "loadModels", models: [] });
  for (let tick = 0; tick < 3; tick++) target.tick();
  expect(overlapping(target, 5)).toContain(rocks[0]!.guid);
  expect(requests()).toHaveLength(2);
  expect(commands.filter((command) => command.type === "diagnostic" && command.code === "physics.complex_collision_unavailable"))
    .toEqual([expect.objectContaining({ severity: "warning", assetGuid: "statue-model" })]);
});
