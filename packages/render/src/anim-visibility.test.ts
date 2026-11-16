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
  return { gate, applied, state, place, meshes };
}

describe("AnimVisibilityGate", () => {
  it("poses a When Visible actor in view at once and holds one out of view until it comes into view", () => {
    const { gate, applied, state, place, meshes } = setup(false);
    place(1, new Vector3(0, 0, 10));
    place(2, new Vector3(0, 0, -10));
    gate.offer(state(1, "walk"));
    gate.offer(state(2, "walk"));
    gate.offer(state(2, "run"));
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

  it("poses an Always actor wherever it is, and a held actor when something reads its pose", () => {
    const { gate, applied, state, place } = setup(false);
    place(1, new Vector3(0, 0, -10));
    gate.offer(state(1, "idle", false));
    expect(applied).toEqual(["1:idle"]);
    gate.offer(state(1, "walk"));
    expect(applied).toEqual(["1:idle"]);
    gate.flushSlot(1);
    expect(applied).toEqual(["1:idle", "1:walk"]);
    gate.flushSlot(1);
    expect(applied).toHaveLength(2);
  });

  it("counts a shadow caster near the view as seen, so its shadow keeps moving", () => {
    const quiet = setup(false);
    // Just outside the left edge of the view, beside the frustum.
    quiet.place(1, new Vector3(-9, 0, 5));
    quiet.gate.offer(quiet.state(1, "walk"));
    expect(quiet.applied).toEqual([]);
    const caster = setup(true);
    caster.place(2, new Vector3(-9, 0, 5));
    caster.gate.offer(caster.state(2, "walk"));
    expect(caster.applied).toEqual(["2:walk"]);
  });

  it("treats an actor without bounds yet (a model still loading) as seen", () => {
    const { gate, applied, state, meshes } = setup(false);
    const root = new Mesh("loading", scene);
    root.position.set(0, 0, -10);
    meshes.set(1, root);
    gate.offer(state(1, "walk"));
    expect(applied).toEqual(["1:walk"]);
  });
});
