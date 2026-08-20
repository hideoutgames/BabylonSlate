import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FreeCamera,
  MeshBuilder,
  Quaternion,
  RenderTargetTexture,
  TransformNode,
  Vector3,
  VertexBuffer,
  type Camera,
} from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  eulerDegreesToQuaternion,
  identitySerializedTransform,
  type SerializedScene,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import {
  CAMERA_PREVIEW_HEIGHT,
  CAMERA_PREVIEW_WIDTH,
  EditorDebugOverlay,
} from "./editor-debug-overlay";
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

function projectionAspect(camera: Camera): number {
  const m = camera.getProjectionMatrix(true).m;
  return m[5]! / m[0]!;
}

function previewCamera(scene: { cameras: Camera[] }): Camera {
  const camera = scene.cameras.find((entry) =>
    entry.name.startsWith("debugPreviewCam:"),
  );
  if (!camera) throw new Error("preview camera missing");
  return camera;
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

  it("pins the preview camera projection to 320x180 even when the engine canvas is tall", () => {
    const { scene, engine } = createHandle();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(200);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(800);
    const overlay = new EditorDebugOverlay(scene);
    overlay.sync({
      sceneData: sceneWith([cameraActor()]),
      selectedActorIds: ["cam"],
    });
    expect(projectionAspect(previewCamera(scene))).toBeCloseTo(
      CAMERA_PREVIEW_WIDTH / CAMERA_PREVIEW_HEIGHT,
      5,
    );
    overlay.dispose();
  });

  it("sizes the frustum and ortho preview to the 16:9 PIP, not the engine canvas", () => {
    const { scene, engine } = createHandle();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(200);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(800);
    const overlay = new EditorDebugOverlay(scene);
    overlay.sync({
      sceneData: sceneWith([
        cameraActor({
          properties: {
            projectionMode: "orthographic",
            orthographicSize: 5,
            fieldOfView: 60,
            nearClip: 1,
            farClip: 20,
          },
        }),
      ]),
      selectedActorIds: ["cam"],
    });
    const preview = previewCamera(scene);
    expect(preview.orthoRight! / preview.orthoTop!).toBeCloseTo(
      CAMERA_PREVIEW_WIDTH / CAMERA_PREVIEW_HEIGHT,
      5,
    );
    const points = frustumWorldPoints(overlay.frustumMesh as TransformNode);
    expect(maxAbs(points, "x") / maxAbs(points, "y")).toBeCloseTo(
      CAMERA_PREVIEW_WIDTH / CAMERA_PREVIEW_HEIGHT,
      5,
    );
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

  it("copies the live origin pose onto the PIP camera while the mesh moves", () => {
    const { scene } = createHandle();
    const origin = MeshBuilder.CreateBox(editorMeshName("cam"), { size: 0.01 }, scene);
    origin.position.set(4, 1, -2);
    origin.computeWorldMatrix(true);
    const overlay = new EditorDebugOverlay(scene, { now: () => 0 });
    overlay.sync({
      sceneData: sceneWith([cameraActor()]),
      selectedActorIds: ["cam"],
    });
    origin.position.set(9, 3, -5);
    origin.rotationQuaternion = Quaternion.Identity();
    origin.computeWorldMatrix(true);
    overlay.followLivePose();
    const preview = previewCamera(scene);
    expect(preview.position.x).toBeCloseTo(9);
    expect(preview.position.y).toBeCloseTo(3);
    expect(preview.position.z).toBeCloseTo(-5);
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

  it("flips WebGL readPixels so the 2D canvas is not upside down", async () => {
    const ImageDataStub = class {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    };
    const previousImageData = (globalThis as { ImageData?: unknown }).ImageData;
    (globalThis as { ImageData: unknown }).ImageData = ImageDataStub;

    const width = CAMERA_PREVIEW_WIDTH;
    const height = CAMERA_PREVIEW_HEIGHT;
    const row = width * 4;
    const gpu = new Uint8Array(width * height * 4);
    for (let x = 0; x < width; x++) {
      const bottom = x * 4;
      gpu[bottom] = 255;
      gpu[bottom + 3] = 255;
      const top = (height - 1) * row + x * 4;
      gpu[top + 2] = 255;
      gpu[top + 3] = 255;
    }
    const readPixels = vi
      .spyOn(RenderTargetTexture.prototype, "readPixels")
      .mockResolvedValue(gpu);

    try {
      const { scene } = createHandle();
      const overlay = new EditorDebugOverlay(scene);
      const captured: Array<{ data: Uint8ClampedArray }> = [];
      const canvas = {
        hidden: true,
        dataset: {} as Record<string, string>,
        width: 0,
        height: 0,
        getContext: () => ({
          putImageData: (image: { data: Uint8ClampedArray }) => {
            captured.push(image);
          },
        }),
      };
      overlay.setPreviewCanvas(canvas as unknown as HTMLCanvasElement);
      overlay.sync({
        sceneData: sceneWith([cameraActor()]),
        selectedActorIds: ["cam"],
      });
      await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0));
      const image = captured[0]!;
      expect([...image.data.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
      expect([...image.data.subarray((height - 1) * row, (height - 1) * row + 4)]).toEqual([
        255, 0, 0, 255,
      ]);
      overlay.dispose();
    } finally {
      readPixels.mockRestore();
      if (previousImageData) {
        (globalThis as { ImageData: unknown }).ImageData = previousImageData;
      } else {
        delete (globalThis as { ImageData?: unknown }).ImageData;
      }
    }
  });
});
