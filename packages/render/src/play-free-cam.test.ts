import { describe, expect, it } from "vitest";
import { UniversalCamera, Vector3 } from "@babylonjs/core";
import { createTestEngine } from "./create-null-engine";
import {
  PLAY_FREE_CAM_NAME,
  applyPlayFreeCamCommand,
  attachPlayFreeCamInput,
  createPlayFreeCamController,
  disablePlayFreeCam,
} from "./play-free-cam";
import {
  applyPossessCamera,
  createSnapshotSceneBinding,
} from "./snapshot-apply";
import { setupDefaultViewport } from "./viewport";
import { DEFAULT_FLY_SPEED } from "./viewport-fly-keys";

type Listener = (event: Event) => void;

class FakeTarget {
  readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Record<string, unknown>): void {
    const payload = { preventDefault: () => {}, ...event } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(payload);
    }
  }
}

class FakeCanvas extends FakeTarget {
  clientWidth = 800;
  capturedPointers: number[] = [];

  setPointerCapture(pointerId: number): void {
    this.capturedPointers.push(pointerId);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
}

describe("createPlayFreeCamController", () => {
  it("attaches a detached fly camera from the active pose and restores on off", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const binding = createSnapshotSceneBinding();
    const source = scene.activeCamera!;
    const sourcePos = source.globalPosition.clone();
    const freeCam = createPlayFreeCamController(scene, { binding, mode: "3d" });
    freeCam.setEnabled(true);
    expect(freeCam.enabled()).toBe(true);
    expect(scene.activeCamera?.name).toBe(PLAY_FREE_CAM_NAME);
    expect(scene.activeCamera).toBeInstanceOf(UniversalCamera);
    expect(scene.activeCamera?.globalPosition.x).toBeCloseTo(sourcePos.x);
    expect(scene.getCameraByName("camera")).toBe(source);
    freeCam.fly(1, 0);
    expect(scene.activeCamera!.globalPosition.equalsWithEpsilon(sourcePos, 1e-4)).toBe(
      false,
    );
    freeCam.setEnabled(false);
    expect(freeCam.enabled()).toBe(false);
    expect(scene.activeCamera).toBe(source);
    expect(scene.getCameraByName(PLAY_FREE_CAM_NAME)).toBeNull();
    freeCam.dispose();
    engine.dispose();
  });

  it("pans on XY in 2D and ignores look", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const binding = createSnapshotSceneBinding();
    const freeCam = createPlayFreeCamController(scene, { binding, mode: "2d" });
    freeCam.setEnabled(true);
    const start = scene.activeCamera!.position.clone();
    freeCam.look(0.4, 0.2);
    expect(scene.activeCamera!.position.equalsWithEpsilon(start, 1e-4)).toBe(true);
    freeCam.fly(2, 3);
    expect(scene.activeCamera!.position.x).toBeCloseTo(start.x + 3);
    expect(scene.activeCamera!.position.y).toBeCloseTo(start.y + 2);
    freeCam.dispose();
    engine.dispose();
  });

  it("keeps game cameras live and restores possessed camera after off", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const binding = createSnapshotSceneBinding();
    const gameCam = new UniversalCamera("authoredCamera:1", new Vector3(1, 2, 3), scene);
    binding.cameras.set(1, gameCam);
    binding.possessedCameraSlotId = 1;
    applyPossessCamera(scene, binding, 1);
    expect(scene.activeCamera).toBe(gameCam);
    const freeCam = createPlayFreeCamController(scene, { binding, mode: "3d" });
    freeCam.setEnabled(true);
    expect(scene.activeCamera?.name).toBe(PLAY_FREE_CAM_NAME);
    expect(binding.cameras.get(1)).toBe(gameCam);
    freeCam.setEnabled(false);
    expect(scene.activeCamera).toBe(gameCam);
    freeCam.dispose();
    engine.dispose();
  });
});

describe("applyPlayFreeCamCommand", () => {
  it("enables from setFreeCam and disables on possessCamera without consuming it", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const binding = createSnapshotSceneBinding();
    const freeCam = createPlayFreeCamController(scene, { binding, mode: "3d" });
    expect(
      applyPlayFreeCamCommand(freeCam, { type: "setFreeCam", enabled: true }),
    ).toBe(true);
    expect(freeCam.enabled()).toBe(true);
    expect(
      applyPlayFreeCamCommand(freeCam, { type: "possessCamera", slotId: 1 }),
    ).toBe(false);
    expect(freeCam.enabled()).toBe(false);
    disablePlayFreeCam(freeCam);
    expect(freeCam.enabled()).toBe(false);
    freeCam.dispose();
    engine.dispose();
  });
});

describe("attachPlayFreeCamInput", () => {
  it("flies with WASD and looks with pointer drag only while enabled", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const binding = createSnapshotSceneBinding();
    const freeCam = createPlayFreeCamController(scene, { binding, mode: "3d" });
    const canvas = new FakeCanvas();
    const keys = new FakeTarget();
    const frames: FrameRequestCallback[] = [];
    const input = attachPlayFreeCamInput(
      canvas as unknown as HTMLCanvasElement,
      freeCam,
      {
        mode: "3d",
        keyTarget: keys as unknown as EventTarget,
        requestFrame: (callback) => {
          frames.push(callback);
          return frames.length;
        },
        cancelFrame: () => {},
      },
    );
    keys.emit("keydown", { code: "KeyW", target: { tagName: "BODY" } });
    frames[0]?.(0);
    frames[1]?.(1000);
    expect(scene.activeCamera?.name).not.toBe(PLAY_FREE_CAM_NAME);

    freeCam.setEnabled(true);
    const start = scene.activeCamera!.position.clone();
    keys.emit("keydown", { code: "KeyW", target: { tagName: "BODY" } });
    const afterEnable = frames.length;
    frames[afterEnable - 1]?.(0);
    frames[afterEnable]?.(50);
    expect(scene.activeCamera!.position.equalsWithEpsilon(start, 1e-4)).toBe(
      false,
    );
    expect(
      Vector3.Distance(scene.activeCamera!.position, start),
    ).toBeCloseTo(DEFAULT_FLY_SPEED * 0.05, 3);

    const beforeLook = (scene.activeCamera as UniversalCamera).rotationQuaternion?.clone();
    canvas.emit("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
    canvas.emit("pointermove", { pointerId: 1, clientX: 160, clientY: 80 });
    expect(
      (scene.activeCamera as UniversalCamera).rotationQuaternion?.equalsWithEpsilon(
        beforeLook!,
        1e-6,
      ),
    ).toBe(false);

    freeCam.setEnabled(false);
    const restored = scene.activeCamera!.position.clone();
    keys.emit("keydown", { code: "KeyW", target: { tagName: "BODY" } });
    frames.at(-1)?.(0);
    frames.at(-1)?.(1000);
    expect(scene.activeCamera!.position.equalsWithEpsilon(restored, 1e-4)).toBe(
      true,
    );
    input.dispose();
    freeCam.dispose();
    engine.dispose();
  });

  it("looks right on pointer drag right and up on pointer drag up", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const binding = createSnapshotSceneBinding();
    const freeCam = createPlayFreeCamController(scene, { binding, mode: "3d" });
    const canvas = new FakeCanvas();
    freeCam.setEnabled(true);
    const input = attachPlayFreeCamInput(
      canvas as unknown as HTMLCanvasElement,
      freeCam,
      { mode: "3d", orbitScale: 0.01 },
    );
    const camera = scene.activeCamera as UniversalCamera;
    camera.computeWorldMatrix();
    const right = camera.getDirection(Vector3.Right()).clone();
    const up = camera.getDirection(Vector3.Up()).clone();
    const forwardBefore = camera.getDirection(Vector3.Forward()).clone();

    canvas.emit("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
    canvas.emit("pointermove", { pointerId: 1, clientX: 180, clientY: 100 });
    camera.computeWorldMatrix();
    const afterYaw = camera.getDirection(Vector3.Forward());
    expect(
      Vector3.Dot(afterYaw.subtract(forwardBefore), right),
    ).toBeGreaterThan(0);

    canvas.emit("pointermove", { pointerId: 1, clientX: 180, clientY: 40 });
    camera.computeWorldMatrix();
    const afterPitch = camera.getDirection(Vector3.Forward());
    expect(Vector3.Dot(afterPitch.subtract(afterYaw), up)).toBeGreaterThan(0);

    input.dispose();
    freeCam.dispose();
    engine.dispose();
  });

  it("pans XY from pointer drag in 2D", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const binding = createSnapshotSceneBinding();
    const freeCam = createPlayFreeCamController(scene, { binding, mode: "2d" });
    const canvas = new FakeCanvas();
    freeCam.setEnabled(true);
    const start = scene.activeCamera!.position.clone();
    const input = attachPlayFreeCamInput(
      canvas as unknown as HTMLCanvasElement,
      freeCam,
      { mode: "2d", panScale: 0.01 },
    );
    canvas.emit("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
    canvas.emit("pointermove", { pointerId: 1, clientX: 200, clientY: 50 });
    expect(scene.activeCamera!.position.x).toBeCloseTo(start.x - 1);
    expect(scene.activeCamera!.position.y).toBeCloseTo(start.y + 0.5);
    input.dispose();
    freeCam.dispose();
    engine.dispose();
  });

  it("pinch-zooms 2D ortho and does not pan while two pointers are down", () => {
    const { engine, scene } = createTestEngine();
    setupDefaultViewport(scene);
    const binding = createSnapshotSceneBinding();
    const freeCam = createPlayFreeCamController(scene, { binding, mode: "2d" });
    const canvas = new FakeCanvas();
    freeCam.setEnabled(true);
    const camera = scene.activeCamera as UniversalCamera;
    const start = camera.position.clone();
    const startTop = camera.orthoTop ?? 5;
    const input = attachPlayFreeCamInput(
      canvas as unknown as HTMLCanvasElement,
      freeCam,
      { mode: "2d", panScale: 0.01 },
    );
    canvas.emit("pointerdown", { pointerId: 1, clientX: 100, clientY: 100 });
    canvas.emit("pointerdown", { pointerId: 2, clientX: 200, clientY: 100 });
    canvas.emit("pointermove", { pointerId: 1, clientX: 50, clientY: 100 });
    canvas.emit("pointermove", { pointerId: 2, clientX: 250, clientY: 100 });
    expect(camera.orthoTop).toBeCloseTo(startTop / 2);
    expect(camera.position.equalsWithEpsilon(start, 1e-4)).toBe(true);
    input.dispose();
    freeCam.dispose();
    engine.dispose();
  });
});
