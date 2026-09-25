import { Mesh, Quaternion, Vector3, type UniversalCamera } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  parseSpringArmProperties,
  type SerializedComponent,
  type SerializedScene,
} from "@babylonslate/core";
import type { ActorSlot } from "@babylonslate/bridge";
import { createTestEngine } from "./create-null-engine";
import {
  actorVisualFingerprint,
  applySceneToBabylonScene,
  editorComponentMeshName,
} from "./scene-loader";
import {
  applyAssignMesh,
  applySnapshotToScene,
  createSnapshotSceneBinding,
  retirePlaySlot,
  type AssignMeshPart,
} from "./snapshot-apply";
import { SPRING_ARM_DEBUG_PREFIX } from "./spring-arm";

const YAW_90: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

function springArm(properties: Record<string, unknown>, rotation = [0, 0, 0, 1]): SerializedComponent {
  return {
    id: "arm",
    classId: "SpringArmComponent",
    properties: { ...parseSpringArmProperties(properties) },
    transform: { position: [0, 0, 0], rotation: rotation as typeof YAW_90, scale: [1, 1, 1] },
  };
}

function expectVector(actual: Vector3, expected: [number, number, number]): void {
  expect(actual.x).toBeCloseTo(expected[0], 5);
  expect(actual.y).toBeCloseTo(expected[1], 5);
  expect(actual.z).toBeCloseTo(expected[2], 5);
}

describe("spring arm", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  function createHandle() {
    const handle = createTestEngine();
    handles.push(handle);
    return handle;
  }

  it("attaches editor child components at the end of the rotated arm", () => {
    const { scene } = createHandle();
    const child = { ...createMeshComponent("box", "box"), parentId: "arm" };
    const sceneData: SerializedScene = {
      ...createDefaultScene(),
      actors: [
        createActor("boom", "Boom", {
          components: [springArm({ armLength: 3 }, YAW_90), child],
        }),
      ],
    };
    applySceneToBabylonScene(scene, sceneData);
    const mesh = scene.getMeshByName(editorComponentMeshName("boom", "box"))!;
    expectVector(mesh.computeWorldMatrix(true).getTranslation(), [-3, 0, 0]);

    const longer = {
      ...sceneData.actors[0]!,
      components: [springArm({ armLength: 5 }, YAW_90), child],
    };
    expect(actorVisualFingerprint(longer)).not.toBe(actorVisualFingerprint(sceneData.actors[0]!));
  });

  describe("Play", () => {
    function assign(
      scene: ReturnType<typeof createHandle>["scene"],
      binding: ReturnType<typeof createSnapshotSceneBinding>,
      arm: Partial<AssignMeshPart>,
    ): void {
      applyAssignMesh(scene, binding, {
        type: "assignMesh",
        slotId: 0,
        meshAssetGuid: null,
        meshKind: "springarm",
        camera: { projectionMode: "perspective", isDefault: true },
        parts: [
          {
            componentId: "arm",
            meshKind: "springarm",
            meshAssetGuid: null,
            parentId: null,
            position: [0, 1, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
            ...arm,
          },
          {
            componentId: "cam",
            meshKind: "camera",
            meshAssetGuid: null,
            parentId: "arm",
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        ],
      });
    }

    function snapshot(
      scene: ReturnType<typeof createHandle>["scene"],
      binding: ReturnType<typeof createSnapshotSceneBinding>,
      nowMs: number,
      pose: Partial<Pick<ActorSlot, "position" | "rotation">>,
    ): UniversalCamera {
      vi.spyOn(performance, "now").mockReturnValue(nowMs);
      applySnapshotToScene(scene, binding, {
        frameId: nowMs,
        tickIndex: nowMs,
        alpha: 1,
        actorCount: 1,
        actors: [
          {
            slotId: 0,
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            scale: { x: 1, y: 1, z: 1 },
            flags: 1,
            ...pose,
          },
        ],
      });
      return binding.cameras.get(0) as UniversalCamera;
    }

    it("poses the slot camera at the socket and rotates it with the actor", () => {
      const { scene } = createHandle();
      const binding = createSnapshotSceneBinding();
      assign(scene, binding, { springArm: parseSpringArmProperties({ armLength: 4 }) });
      const camera = snapshot(scene, binding, 1000, {
        rotation: { x: YAW_90[0], y: YAW_90[1], z: YAW_90[2], w: YAW_90[3] },
      });
      expectVector(camera.position, [-4, 1, 0]);
      const yaw = Quaternion.FromArray(YAW_90);
      expect(Math.abs(Quaternion.Dot(camera.rotationQuaternion!, yaw))).toBeCloseTo(1, 5);
      expect(scene.activeCamera).toBe(camera);
    });

    it("rotates children with the arm component's own rotation", () => {
      const { scene } = createHandle();
      const binding = createSnapshotSceneBinding();
      assign(scene, binding, { rotation: YAW_90, springArm: parseSpringArmProperties({ armLength: 2 }) });
      expectVector(snapshot(scene, binding, 1000, {}).position, [-2, 1, 0]);
    });

    it("lags the camera behind a moving actor, frame-rate independently", () => {
      const { scene } = createHandle();
      const binding = createSnapshotSceneBinding();
      assign(scene, binding, {
        springArm: parseSpringArmProperties({ armLength: 4, enableLocationLag: true, locationLagSpeed: 10 }),
      });
      expectVector(snapshot(scene, binding, 1000, {}).position, [0, 1, -4]);
      const moved = { position: { x: 10, y: 0, z: 0 } };
      const lagged = 10 * (1 - Math.exp(-10 * 0.05));
      expectVector(snapshot(scene, binding, 1050, moved).position, [lagged, 1, -4]);

      const halfSteps = createSnapshotSceneBinding();
      assign(scene, halfSteps, {
        springArm: parseSpringArmProperties({ armLength: 4, enableLocationLag: true, locationLagSpeed: 10 }),
      });
      snapshot(scene, halfSteps, 1000, {});
      snapshot(scene, halfSteps, 1025, moved);
      expectVector(snapshot(scene, halfSteps, 1050, moved).position, [lagged, 1, -4]);
    });

    it("keeps the lag across a property rebuild and draws debug lines until retired", () => {
      const { scene } = createHandle();
      const binding = createSnapshotSceneBinding();
      const lag = { armLength: 4, enableLocationLag: true, locationLagSpeed: 10 };
      assign(scene, binding, { springArm: parseSpringArmProperties(lag) });
      snapshot(scene, binding, 1000, {});
      assign(scene, binding, { springArm: parseSpringArmProperties({ ...lag, drawDebugLag: true }) });
      const camera = snapshot(scene, binding, 1050, { position: { x: 10, y: 0, z: 0 } });
      expect(camera.position.x).toBeCloseTo(10 * (1 - Math.exp(-0.5)), 5);

      const debug = scene.getMeshByName(`${SPRING_ARM_DEBUG_PREFIX}0|arm`) as Mesh | null;
      expect(debug).not.toBeNull();
      expect(debug!.isPickable).toBe(false);
      const positions = debug!.getVerticesData("position")!;
      // Line 0 is the target arm: authored pivot to its socket.
      expect(Array.from(positions.slice(0, 6))).toEqual([10, 1, 0, 10, 1, -4].map((value) => expect.closeTo(value, 5)));

      retirePlaySlot(binding, 0);
      expect(debug!.isDisposed()).toBe(true);
    });
  });
});
