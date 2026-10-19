import { Mesh, NullEngine, Quaternion, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createGameCameraPilot, type GameCameraPilotTarget } from "./game-camera-pilot";

describe("createGameCameraPilot", () => {
  let engine: NullEngine;
  let scene: Scene;

  afterEach(() => {
    scene.dispose();
    engine.dispose();
  });

  const setup = (enabled = { value: true }) => {
    engine = new NullEngine();
    scene = new Scene(engine);
    const mesh = new Mesh("camera-actor", scene);
    const camera = new UniversalCamera("game-camera", Vector3.Zero(), scene);
    camera.rotationQuaternion = Quaternion.Identity();
    const follow = () => {
      camera.position.copyFrom(mesh.position);
      camera.rotationQuaternion!.copyFrom(mesh.rotationQuaternion ?? Quaternion.Identity());
    };
    const timers: Array<() => void> = [];
    const commits: Array<{ position: Vector3; forward: Vector3 }> = [];
    const target: GameCameraPilotTarget = { actorId: "cam", mesh, camera };
    const pilot = createGameCameraPilot({
      target: () => (enabled.value ? target : null),
      onMove: follow,
      onCommit: () =>
        commits.push({ position: mesh.position.clone(), forward: camera.getDirection(Vector3.Forward()) }),
      setTimer: (callback) => timers.push(callback),
      clearTimer: () => timers.pop(),
    });
    return { mesh, camera, pilot, timers, commits };
  };

  it("turns and flies the camera actor like the editor camera and commits once input pauses", () => {
    const { pilot, timers, commits } = setup();
    // Gestures pass negative deltas for a drag right.
    pilot.look(-Math.PI / 2, 0);
    pilot.fly(2, 0);
    expect(commits).toHaveLength(0);
    timers.pop()!();
    expect(commits).toHaveLength(1);
    expect(commits[0]!.forward.x).toBeCloseTo(1);
    expect(commits[0]!.position.x).toBeCloseTo(2);
    expect(commits[0]!.position.z).toBeCloseTo(0);
  });

  it("pitches down for a drag down and keeps the horizon level when it then turns", () => {
    const { pilot, camera } = setup();
    pilot.look(0, -Math.PI / 4);
    pilot.look(-Math.PI / 2, 0);
    const forward = camera.getDirection(Vector3.Forward());
    expect(forward.y).toBeCloseTo(-Math.SQRT1_2);
    expect(forward.x).toBeCloseTo(Math.SQRT1_2);
    expect(camera.getDirection(Vector3.Right()).y).toBeCloseTo(0);
  });

  it("makes pinch zoom absolute from the pose at pinch start", () => {
    const { pilot, mesh } = setup();
    const framing = pilot.captureFraming()!;
    pilot.zoom(1.5);
    pilot.restoreFraming(framing);
    pilot.zoom(2);
    expect(mesh.position.z).toBeCloseTo(Math.log(2) * 4);
  });

  it("leaves everything alone without a camera actor to steer", () => {
    const { pilot, mesh, timers, commits } = setup({ value: false });
    pilot.fly(1, 1);
    pilot.look(1, 1);
    expect(pilot.active()).toBe(false);
    expect(mesh.position.equals(Vector3.Zero())).toBe(true);
    expect(timers).toHaveLength(0);
    expect(commits).toHaveLength(0);
  });
});
