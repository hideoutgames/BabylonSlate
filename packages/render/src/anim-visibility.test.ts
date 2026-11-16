import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import type { CommandMessage } from "@haptic/bridge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnimVisibilityGate } from "./anim-visibility";

type AnimStateCommand = Extract<CommandMessage, { type: "animState" }>;

let engine: NullEngine;
let scene: Scene;

beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  // Looks down +Z from the origin.
  const camera = new FreeCamera("camera", new Vector3(0, 0, 0), scene);
  camera.setTarget(new Vector3(0, 0, 10));
  scene.activeCamera = camera;
});

afterEach(() => {
  scene.dispose();
  engine.dispose();
});

/** An actor root (an empty mesh, as a model's) holding a 1 m body. */
function actorAt(name: string, position: Vector3): AbstractMesh {
  const root = new Mesh(name, scene);
  const body = MeshBuilder.CreateBox(`${name}-body`, { size: 1 }, scene);
  body.parent = root;
  root.position.copyFrom(position);
  root.computeWorldMatrix(true);
  body.computeWorldMatrix(true);
  return root;
}

function setup(castShadows: boolean) {
  const meshes = new Map<number, AbstractMesh>();
  const pendingAnimState = new Map<number, AnimStateCommand>();
  const meshSorting = new Map<number, { castShadows?: boolean }>();
  const applied: string[] = [];
  const gate = new AnimVisibilityGate(scene, { meshes, pendingAnimState, meshSorting }, (command) => applied.push(`${command.slotId}:${command.stateId}`));
  const state = (slotId: number, stateId: string, whenVisible = true): AnimStateCommand => {
    const command: AnimStateCommand = { type: "animState", slotId, stateId, normalisedTime: 0, blendWeights: {}, ...(whenVisible ? { whenVisible } : {}) };
    pendingAnimState.set(slotId, command);
    return command;
  };
  const place = (slotId: number, position: Vector3) => {
    meshes.set(slotId, actorAt(`actor-${slotId}`, position));
    meshSorting.set(slotId, { castShadows });
  };
  return { gate, applied, state, place, meshes, pendingAnimState };
}

describe("AnimVisibilityGate", () => {
  it("poses a slot once per flush, from its latest state, however many states arrived since", () => {
    const { gate, applied, state, place } = setup(false);
    place(1, new Vector3(0, 0, 10));
    place(2, new Vector3(0, 0, 10));
    // Four catch-up ticks arrive in one advance: nothing is posed as they arrive.
    for (const stateId of ["a", "b", "c", "d"]) {
      gate.offer(state(1, stateId, false));
      gate.offer(state(2, stateId));
    }
    expect(applied).toEqual([]);
    gate.flush();
    expect(applied).toEqual(["1:d", "2:d"]);
    // Posed: a second flush (before the render that follows the snapshot) poses nothing again.
    gate.flush();
    expect(applied).toEqual(["1:d", "2:d"]);
    gate.offer(state(1, "e", false));
    gate.flush();
    expect(applied).toEqual(["1:d", "2:d", "1:e"]);
  });

  it("poses every state that steps on each pose as it arrives, and none of the states it replaced", () => {
    const { gate, applied, state, place } = setup(false);
    place(1, new Vector3(0, 0, 10));
    place(2, new Vector3(0, 0, -10));
    const springs = (slotId: number, stateId: string, whenVisible: boolean): AnimStateCommand => {
      const command = state(slotId, stateId, whenVisible);
      command.boneModifiers = [{ kind: "springBones" } as NonNullable<AnimStateCommand["boneModifiers"]>[number]];
      return command;
    };
    // Spring Bones advance by each command's time step: each is posed, in order, on arrival.
    gate.offer(state(1, "plain", false));
    gate.offer(springs(1, "s1", false));
    gate.offer(springs(1, "s2", false));
    expect(applied).toEqual(["1:s1", "1:s2"]);
    // The plain state before them was replaced, and what arrived is posed: a flush adds nothing.
    gate.flush();
    expect(applied).toEqual(["1:s1", "1:s2"]);
    // Out of view, a When Visible one is still held, and posed once from its latest when seen.
    gate.offer(springs(2, "s1", true));
    gate.offer(springs(2, "s2", true));
    gate.flush();
    expect(applied).toEqual(["1:s1", "1:s2"]);
    expect(gate.isHeld(2)).toBe(true);
    gate.flushSlot(2);
    expect(applied).toEqual(["1:s1", "1:s2", "2:s2"]);
  });

  it("drops a waiting state whose slot is gone", () => {
    const { gate, applied, state, place, pendingAnimState } = setup(false);
    place(1, new Vector3(0, 0, 10));
    gate.offer(state(1, "walk", false));
    pendingAnimState.delete(1);
    gate.flush();
    gate.flushSlot(1);
    expect(applied).toEqual([]);
    expect(gate.isHeld(1)).toBe(false);
  });

  it("poses a When Visible actor in view at the next flush and holds one out of view until it comes into view", () => {
    const { gate, applied, state, place, meshes } = setup(false);
    place(1, new Vector3(0, 0, 10));
    place(2, new Vector3(0, 0, -10));
    gate.offer(state(1, "walk"));
    gate.offer(state(2, "walk"));
    gate.offer(state(2, "run"));
    gate.flush();
    expect(applied).toEqual(["1:walk"]);
    expect(gate.isHeld(2)).toBe(true);
    gate.flush();
    expect(applied).toEqual(["1:walk"]);
    // Behind the camera, then in front: the latest state is posed once.
    const root = meshes.get(2)!;
    root.position.set(0, 0, 12);
    root.computeWorldMatrix(true);
    gate.flush();
    expect(applied).toEqual(["1:walk", "2:run"]);
    expect(gate.isHeld(2)).toBe(false);
  });

  it("poses an Always actor wherever it is, and a waiting actor at once when something reads its pose", () => {
    const { gate, applied, state, place } = setup(false);
    place(1, new Vector3(0, 0, -10));
    gate.offer(state(1, "idle", false));
    gate.flush();
    expect(applied).toEqual(["1:idle"]);
    gate.offer(state(1, "walk"));
    gate.flush();
    expect(applied).toEqual(["1:idle"]);
    gate.flushSlot(1);
    expect(applied).toEqual(["1:idle", "1:walk"]);
    gate.flushSlot(1);
    expect(applied).toHaveLength(2);
    // A ragdoll capture between a state's arrival and the next flush reads that state's pose, posed once.
    gate.offer(state(1, "fall", false));
    gate.flushSlot(1);
    expect(applied).toEqual(["1:idle", "1:walk", "1:fall"]);
    gate.flush();
    expect(applied).toHaveLength(3);
  });

  it("counts a shadow caster near the view as seen, so its shadow keeps moving", () => {
    const quiet = setup(false);
    // Just outside the left edge of the view, beside the frustum.
    quiet.place(1, new Vector3(-9, 0, 5));
    quiet.gate.offer(quiet.state(1, "walk"));
    quiet.gate.flush();
    expect(quiet.applied).toEqual([]);
    const caster = setup(true);
    caster.place(2, new Vector3(-9, 0, 5));
    caster.gate.offer(caster.state(2, "walk"));
    caster.gate.flush();
    expect(caster.applied).toEqual(["2:walk"]);
  });

  it("treats an actor without bounds yet (a model still loading) as seen", () => {
    const { gate, applied, state, meshes } = setup(false);
    const root = new Mesh("loading", scene);
    root.position.set(0, 0, -10);
    meshes.set(1, root);
    gate.offer(state(1, "walk"));
    gate.flush();
    expect(applied).toEqual(["1:walk"]);
  });
});
