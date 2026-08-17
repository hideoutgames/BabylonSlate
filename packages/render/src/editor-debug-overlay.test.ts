import { afterEach, describe, expect, it } from "vitest";
import {
  FreeCamera,
  MeshBuilder,
  Quaternion,
  TransformNode,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  eulerDegreesToQuaternion,
  identitySerializedTransform,
  type SerializedScene,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorDebugOverlay } from "./editor-debug-overlay";
import { editorMeshName } from "./scene-loader";

function sceneWith(
  actors: SerializedScene["actors"],
): SerializedScene {
  return { ...createDefaultScene(), actors };
}

function cameraActor(options?: {
  actorRotation?: [number, number, number, number];
  componentRotation?: [number, number, number, number];
  componentPosition?: [number, number, number];
  properties?: Record<string, unknown>;
}) {
  return createActor("cam", "Camera", {
    transform: {
      position: [0, 0, 0],
      rotation: options?.actorRotation ?? [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    components: [
      {
        id: "camera",
        classId: "CameraComponent",
        parentId: null,
        transform: {
          ...identitySerializedTransform(),
          position: options?.componentPosition ?? [0, 0, 0],
          rotation: options?.componentRotation ?? [0, 0, 0, 1],
        },
        properties: {
          fieldOfView: 60,
          orthographicSize: 5,
          projectionMode: "perspective",
          nearClip: 0.1,
          farClip: 1000,
          ...options?.properties,
        },
      },
    ],
  });
}

function frustumWorldPoints(root: TransformNode): Vector3[] {
  root.computeWorldMatrix(true);
  const points: Vector3[] = [];
  for (const mesh of root.getChildMeshes()) {
    mesh.computeWorldMatrix(true);
    const data = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!data) continue;
    const world = mesh.getWorldMatrix();
    for (let i = 0; i < data.length; i += 3) {
      points.push(
        Vector3.TransformCoordinates(
          new Vector3(data[i]!, data[i + 1]!, data[i + 2]!),
          world,
        ),
      );
    }
  }
  return points;
}

function maxAbs(points: readonly Vector3[], axis: "x" | "y" | "z"): number {
  return points.reduce((max, point) => Math.max(max, Math.abs(point[axis])), 0);
}

describe("EditorDebugOverlay", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
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

  it("creates frustum lines and a 1Hz preview RTT when a camera actor is selected", () => {
    const { scene } = createHandle();
    let now = 0;
    const overlay = new EditorDebugOverlay(scene, { now: () => now });
    const sceneData = sceneWith([
      createActor("cam", "Camera", {
        components: [
          {
            id: "camera",
            classId: "CameraComponent",
            properties: { fieldOfView: 60, orthographicSize: 5 },
          },
        ],
      }),
    ]);
    overlay.sync({ sceneData, selectedActorIds: ["cam"] });
    expect(overlay.frustumMesh).not.toBeNull();
    expect(overlay.previewTexture).not.toBeNull();
    expect(overlay.previewRenderCount).toBe(1);

    now = 500;
    overlay.tick();
    expect(overlay.previewRenderCount).toBe(1);

    now = 1000;
    overlay.tick();
    expect(overlay.previewRenderCount).toBe(2);

    overlay.sync({ sceneData, selectedActorIds: [] });
    expect(overlay.frustumMesh).toBeNull();
    expect(overlay.previewTexture).toBeNull();
    overlay.dispose();
  });

  it("builds dashed influence lines for a selected point light and disposes on deselect", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const sceneData = sceneWith([
      createActor("lamp", "Lamp", {
        components: [
          {
            id: "light",
            classId: "LightComponent",
            properties: { lightKind: "point", range: 8, intensity: 1 },
          },
        ],
      }),
    ]);
    overlay.sync({ sceneData, selectedActorIds: ["lamp"] });
    expect(overlay.lightDebugMesh).not.toBeNull();
    expect(overlay.lightDebugKind).toBe("point");
    overlay.sync({ sceneData, selectedActorIds: [] });
    expect(overlay.lightDebugMesh).toBeNull();
    overlay.dispose();
  });

  it("builds a dashed cone for a selected spot light and an arrow for directional", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const spotScene = sceneWith([
      createActor("spot", "Spot", {
        components: [
          {
            id: "light",
            classId: "LightComponent",
            properties: { lightKind: "spot", range: 10, outerAngle: 45 },
          },
        ],
      }),
    ]);
    overlay.sync({ sceneData: spotScene, selectedActorIds: ["spot"] });
    expect(overlay.lightDebugKind).toBe("spot");

    const dirScene = sceneWith([
      createActor("sun", "Sun", {
        components: [
          {
            id: "light",
            classId: "LightComponent",
            properties: { lightKind: "directional" },
          },
        ],
      }),
    ]);
    overlay.sync({ sceneData: dirScene, selectedActorIds: ["sun"] });
    expect(overlay.lightDebugKind).toBe("directional");
    overlay.dispose();
  });

  it("uses a selected CameraComponent on the prefab root", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const sceneData = sceneWith([
      createActor("prefab-root", "Prefab", {
        components: [
          {
            id: "camera",
            classId: "CameraComponent",
            properties: { fieldOfView: 50 },
          },
        ],
      }),
    ]);
    overlay.sync({
      sceneData,
      selectedActorIds: ["prefab-root"],
      selectedComponentIds: ["camera"],
    });
    expect(overlay.frustumMesh).not.toBeNull();
    expect(overlay.previewTexture).not.toBeNull();
    overlay.dispose();
  });

  it("yaws far-plane corners off the Z axis using composed component rotation", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const sceneData = sceneWith([
      cameraActor({
        componentRotation: eulerDegreesToQuaternion([0, 90, 0]),
        properties: { fieldOfView: 20 },
      }),
    ]);
    overlay.sync({ sceneData, selectedActorIds: ["cam"] });
    const points = frustumWorldPoints(overlay.frustumMesh as TransformNode);
    expect(maxAbs(points, "x")).toBeGreaterThan(6);
    expect(maxAbs(points, "z")).toBeLessThan(4);
    overlay.dispose();
  });

  it("sizes the frustum from field of view and clip planes, not a hardcoded volume", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const wideScene = sceneWith([
      cameraActor({
        properties: {
          fieldOfView: 90,
          orthographicSize: 5,
          projectionMode: "perspective",
          nearClip: 1,
          farClip: 20,
        },
      }),
    ]);
    overlay.sync({ sceneData: wideScene, selectedActorIds: ["cam"] });
    const wide = frustumWorldPoints(overlay.frustumMesh as TransformNode);
    overlay.sync({
      sceneData: sceneWith([
        cameraActor({
          properties: {
            fieldOfView: 30,
            orthographicSize: 5,
            projectionMode: "perspective",
            nearClip: 1,
            farClip: 20,
          },
        }),
      ]),
      selectedActorIds: ["cam"],
    });
    const narrow = frustumWorldPoints(overlay.frustumMesh as TransformNode);
    expect(maxAbs(wide, "z")).toBeCloseTo(20, 0);
    expect(maxAbs(wide, "x")).toBeGreaterThan(maxAbs(narrow, "x") * 1.5);
    overlay.dispose();
  });

  it("parents the frustum to the editor origin so it follows the actor mesh", () => {
    const { scene } = createHandle();
    const origin = MeshBuilder.CreateBox(editorMeshName("cam"), { size: 0.01 }, scene);
    const overlay = new EditorDebugOverlay(scene);
    overlay.sync({
      sceneData: sceneWith([cameraActor()]),
      selectedActorIds: ["cam"],
    });
    expect(overlay.frustumMesh?.parent).toBe(origin);
    overlay.dispose();
  });

  it("aims the preview camera with the composed quaternion and zeros Euler", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const actorRotation = eulerDegreesToQuaternion([0, 45, 0]);
    const componentRotation = eulerDegreesToQuaternion([20, 0, 0]);
    overlay.sync({
      sceneData: sceneWith([
        cameraActor({
          actorRotation,
          componentRotation,
          componentPosition: [1, 2, 3],
        }),
      ]),
      selectedActorIds: ["cam"],
    });
    const preview = scene.getCameraByName(
      "debugPreviewCam:cam",
    ) as FreeCamera | null;
    expect(preview).toBeTruthy();
    const expected = new Quaternion(
      actorRotation[0],
      actorRotation[1],
      actorRotation[2],
      actorRotation[3],
    ).multiply(
      new Quaternion(
        componentRotation[0],
        componentRotation[1],
        componentRotation[2],
        componentRotation[3],
      ),
    );
    expect(preview!.rotationQuaternion).toBeTruthy();
    expect(preview!.rotationQuaternion!.x).toBeCloseTo(expected.x, 5);
    expect(preview!.rotationQuaternion!.y).toBeCloseTo(expected.y, 5);
    expect(preview!.rotationQuaternion!.z).toBeCloseTo(expected.z, 5);
    expect(preview!.rotationQuaternion!.w).toBeCloseTo(expected.w, 5);
    expect(preview!.rotation.asArray()).toEqual([0, 0, 0]);
    const expectedPosition = new Vector3(1, 2, 3).applyRotationQuaternion(
      new Quaternion(
        actorRotation[0],
        actorRotation[1],
        actorRotation[2],
        actorRotation[3],
      ),
    );
    expect(preview!.position.x).toBeCloseTo(expectedPosition.x, 5);
    expect(preview!.position.y).toBeCloseTo(expectedPosition.y, 5);
    expect(preview!.position.z).toBeCloseTo(expectedPosition.z, 5);
    overlay.dispose();
  });
});
