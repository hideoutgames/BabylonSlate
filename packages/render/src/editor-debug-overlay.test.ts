import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FreeCamera,
  MeshBuilder,
  NullEngine,
  PointLight,
  Quaternion,
  RenderTargetTexture,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
  Viewport,
  type Camera,
  type LinesMesh,
} from "@babylonjs/core";
import { FloatingOriginCurrentScene } from "@babylonjs/core/Materials/floatingOriginMatrixOverrides";
import {
  createDefaultAudioPayload,
  createDefaultSoundAttenuationPayload,
} from "@babylonslate/assets";
import {
  createActor,
  createDefaultRenderTargetCaptureProperties,
  createDefaultScene,
  eulerDegreesToQuaternion,
  identitySerializedTransform,
  type RenderTargetPayload,
  type SerializedScene,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import {
  CAMERA_PREVIEW_HEIGHT,
  CAMERA_PREVIEW_WIDTH,
  EditorDebugOverlay,
} from "./editor-debug-overlay";
import { editorComponentMeshName, editorMeshName } from "./scene-loader";
import { sceneRenderTargetCaptures } from "./render-target-capture";
import { isViewportShadingTarget } from "./viewport-shading-mode";
import { createEditorCameraModel } from "./editor-camera-model";

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

function captureActor(properties?: Record<string, unknown>) {
  return createActor("rt", "Render Target Capture", {
    components: [
      {
        id: "capture",
        classId: "RenderTargetCaptureComponent",
        properties: { ...createDefaultRenderTargetCaptureProperties(), ...properties },
      },
    ],
  });
}

function renderTargetMap(
  entries: Record<string, Pick<RenderTargetPayload, "width" | "height">>,
): Map<string, RenderTargetPayload> {
  return new Map(
    Object.entries(entries).map(([guid, size]) => [guid, { mode: "SceneColor", ...size }]),
  );
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

/** The counts whose change makes the frame graph re-run its whole-scene readiness probe. */
function membership(scene: Scene) {
  return {
    meshes: scene.meshes.length,
    transformNodes: scene.transformNodes.length,
    materials: scene.materials.length,
    textures: scene.textures.length,
    cameras: scene.cameras.length,
    lights: scene.lights.length,
  };
}

function lightActor(
  id: string,
  properties: Record<string, unknown>,
  options: { position?: [number, number, number]; rotation?: [number, number, number, number] } = {},
) {
  return createActor(id, id, {
    transform: {
      ...identitySerializedTransform(),
      position: options.position ?? [0, 0, 0],
      rotation: options.rotation ?? [0, 0, 0, 1],
    },
    components: [{ id: "light", classId: "LightComponent", properties }],
  });
}

/** Distance from `from` of the farthest point. */
function reach(points: readonly Vector3[], from = Vector3.Zero()): number {
  return points.reduce((max, point) => Math.max(max, Vector3.Distance(point, from)), 0);
}

function maxAbs(points: readonly Vector3[], axis: "x" | "y" | "z"): number {
  return points.reduce((max, point) => Math.max(max, Math.abs(point[axis])), 0);
}

function projectionAspect(camera: Camera): number {
  const m = camera.getProjectionMatrix(true).m;
  return m[5]! / m[0]!;
}

/** The selected lens' preview camera; it is not in `scene.cameras`. */
function previewCamera(overlay: EditorDebugOverlay): Camera {
  const camera = overlay.previewTexture?.activeCamera;
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
    const helper = createEditorCameraModel(scene, "other-camera-helper");
    const world = MeshBuilder.CreateBox("world", {}, scene);
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
    expect(overlay.previewTexture!.renderList).not.toContain(helper);
    expect(overlay.previewTexture!.renderList).toContain(world);
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
    expect(projectionAspect(previewCamera(overlay))).toBeCloseTo(
      CAMERA_PREVIEW_WIDTH / CAMERA_PREVIEW_HEIGHT,
      5,
    );
    overlay.dispose();
  });

  it("restores the editor and shared render state when a camera preview draw throws", () => {
    const engine = new NullEngine();
    vi.spyOn(engine, "supportsUniformBuffers", "get").mockReturnValue(true);
    vi.spyOn(engine, "getCreationOptions").mockReturnValue({ useLargeWorldRendering: true });
    const scene = new Scene(engine);
    handles.push({ scene, engine });
    const camera = scene.activeCamera = new FreeCamera("editor", new Vector3(2000, 3, -10), scene);
    scene.render();
    const overlay = new EditorDebugOverlay(scene, { now: () => 0 });
    overlay.sync({ sceneData: sceneWith([cameraActor()]), selectedActorIds: ["cam"] });
    const sibling = new Scene(engine);
    sibling.activeCamera = new FreeCamera("sibling", new Vector3(5, 2, -8), sibling);
    sibling.render();
    const previousScene = FloatingOriginCurrentScene.getScene;
    const sceneUbo = scene.getSceneUniformBuffer();
    const view = Array.from(scene.getViewMatrix().asArray());
    const projection = Array.from(scene.getProjectionMatrix().asArray());
    const viewport = new Viewport(0.2, 0.1, 0.5, 0.7);
    engine.setViewport(viewport);
    engine.currentRenderPassId = 42;
    const failure = new Error("preview draw failed");
    overlay.previewTexture!.onBeforeRenderObservable.addOnce(() => {
      expect(scene.activeCamera).not.toBe(camera);
      expect(scene.getSceneUniformBuffer()).not.toBe(sceneUbo);
      throw failure;
    });
    try {
      expect(() => overlay.tick(1000)).toThrow(failure);
      expect(scene.activeCamera).toBe(camera);
      expect(scene.getSceneUniformBuffer()).toBe(sceneUbo);
      expect(Array.from(scene.getViewMatrix().asArray())).toEqual(view);
      expect(Array.from(scene.getProjectionMatrix().asArray())).toEqual(projection);
      expect(engine.currentViewport).toEqual(viewport);
      expect(engine.currentRenderPassId).toBe(42);
      expect(FloatingOriginCurrentScene.getScene).toBe(previousScene);
      expect(() => overlay.tick(2000)).not.toThrow();
      expect(() => scene.render()).not.toThrow();
    } finally {
      overlay.dispose();
      sibling.dispose();
    }
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
    const preview = previewCamera(overlay);
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

  it("draws dashed influence rings for a selected point light and hides them on deselect", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const sceneData = sceneWith([lightActor("lamp", { lightKind: "point", range: 8, intensity: 1 })]);
    overlay.sync({ sceneData, selectedActorIds: ["lamp"] });
    const root = overlay.lightDebugMesh as TransformNode;
    expect(root.isEnabled()).toBe(true);
    expect(overlay.lightDebugKind).toBe("point");
    const rings = frustumWorldPoints(root);
    expect(reach(rings)).toBeGreaterThan(8 * 0.99);
    expect(reach(rings)).toBeLessThanOrEqual(8 + 1e-4);
    overlay.sync({ sceneData, selectedActorIds: [] });
    expect(overlay.lightDebugMesh).toBeNull();
    expect(overlay.lightDebugKind).toBeNull();
    expect(root.isEnabled()).toBe(false);
    expect(root.isDisposed()).toBe(false);
    overlay.dispose();
  });

  it("selects, switches, edits and deselects lights, cameras and captures without changing scene membership", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene, { now: () => 0 });
    const baseline = membership(scene);
    const actors = (range: number, fieldOfView: number) => sceneWith([
      lightActor("lamp", { lightKind: "point", range }),
      lightActor("spot", { lightKind: "spot", range, outerAngle: 30 }, { rotation: eulerDegreesToQuaternion([0, 90, 0]) }),
      lightActor("sun", { lightKind: "directional" }),
      cameraActor({ properties: { fieldOfView } }),
      captureActor({ fieldOfView }),
    ]);
    const selections = [["lamp"], ["spot"], ["sun"], ["cam"], ["rt"], ["spot", "cam"], [], ["lamp"], []];
    for (const selectedActorIds of selections) {
      overlay.sync({ sceneData: actors(8, 60), selectedActorIds });
      expect(membership(scene)).toEqual(baseline);
    }
    // Editing the selected actor reshapes its guide in place.
    for (const [range, fieldOfView] of [[8, 60], [12, 60], [12, 90], [3, 30]] as const) {
      overlay.sync({ sceneData: actors(range, fieldOfView), selectedActorIds: ["spot", "cam"] });
      expect(membership(scene)).toEqual(baseline);
    }
    overlay.dispose();
  });

  it("releases every guide, the preview camera and the preview RTT on dispose", () => {
    const { scene } = createHandle();
    const before = membership(scene);
    const overlay = new EditorDebugOverlay(scene, { now: () => 0 });
    // The light and lens guides: a root and one dashed mesh with its own material each.
    const built = membership(scene);
    expect(built).toEqual({
      ...before,
      meshes: before.meshes + 2,
      transformNodes: before.transformNodes + 2,
      materials: before.materials + 2,
    });
    const audio = createActor("speaker", "Speaker", {
      components: [{ id: "audio", classId: "AudioComponent", properties: { audioAssetGuid: "sound" } }],
    });
    const audioLibrary = {
      audio: new Map([["sound", { ...createDefaultAudioPayload(), soundAttenuationGuid: "near" }]]),
      attenuations: new Map([["near", { ...createDefaultSoundAttenuationPayload(), innerRadius: 3, maxRadius: 12 }]]),
    };
    overlay.sync({
      sceneData: sceneWith([lightActor("lamp", { lightKind: "point" }), cameraActor(), audio]),
      selectedActorIds: ["lamp", "cam", "speaker"],
      audioLibrary,
    });
    // Only the audio radii (a root plus six dashed meshes and materials) join the scene by selection.
    expect(membership(scene)).toEqual({
      ...built,
      meshes: built.meshes + 6,
      transformNodes: built.transformNodes + 1,
      materials: built.materials + 6,
    });
    const texture = overlay.previewTexture!;
    const camera = texture.activeCamera!;
    const disposeTexture = vi.spyOn(texture, "dispose");
    const disposeCamera = vi.spyOn(camera, "dispose");
    overlay.dispose();
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(disposeCamera).toHaveBeenCalledOnce();
    expect(membership(scene)).toEqual(before);
    // A late sync, such as a React effect after teardown, must not rebuild anything.
    overlay.sync({ sceneData: sceneWith([lightActor("lamp", { lightKind: "point" })]), selectedActorIds: ["lamp"] });
    expect(membership(scene)).toEqual(before);
  });

  it("reshapes the selected light's guide in place when its range or cone changes", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    overlay.sync({ sceneData: sceneWith([lightActor("lamp", { lightKind: "point", range: 8 })]), selectedActorIds: ["lamp"] });
    const root = overlay.lightDebugMesh as TransformNode;
    const [lines] = root.getChildMeshes() as LinesMesh[];
    const before = membership(scene);
    expect(reach(frustumWorldPoints(root))).toBeCloseTo(8, 0);

    overlay.sync({ sceneData: sceneWith([lightActor("lamp", { lightKind: "point", range: 20 })]), selectedActorIds: ["lamp"] });
    expect(overlay.lightDebugMesh).toBe(root);
    expect(root.getChildMeshes()[0]).toBe(lines);
    expect(reach(frustumWorldPoints(root))).toBeCloseTo(20, 0);

    // A wider cone at the same range widens the base ring around the aim axis (+Z).
    const spot = (outerAngle: number) => sceneWith([lightActor("lamp", { lightKind: "spot", range: 10, outerAngle })]);
    overlay.sync({ sceneData: spot(30), selectedActorIds: ["lamp"] });
    const narrow = maxAbs(frustumWorldPoints(root), "x");
    overlay.sync({ sceneData: spot(90), selectedActorIds: ["lamp"] });
    const wide = maxAbs(frustumWorldPoints(root), "x");
    expect(narrow).toBeCloseTo(Math.tan(Math.PI / 12) * 10, 3);
    expect(wide).toBeCloseTo(10, 3);
    expect(overlay.lightDebugKind).toBe("spot");
    expect(membership(scene)).toEqual(before);
    overlay.dispose();
  });

  it("draws green/yellow audio radii and follows an emitter realized after the selection", () => {
    const { scene } = createHandle();
    const hadObservers = scene.onBeforeRenderObservable.hasObservers();
    const overlay = new EditorDebugOverlay(scene);
    const actor = createActor("speaker", "Speaker", {
      transform: { ...identitySerializedTransform(), position: [10, 0, 0], scale: [2, 3, 4] },
      components: [{
        id: "audio", classId: "AudioComponent",
        transform: { ...identitySerializedTransform(), position: [1, 0, 0] },
        properties: { audioAssetGuid: "sound" },
      }],
    });
    const audioLibrary = {
      audio: new Map([["sound", { ...createDefaultAudioPayload(), soundAttenuationGuid: "near" }]]),
      attenuations: new Map([["near", { ...createDefaultSoundAttenuationPayload(), innerRadius: 3, maxRadius: 12 }]]),
    };
    overlay.sync({ sceneData: sceneWith([actor]), selectedActorIds: [actor.id], audioLibrary });
    const root = scene.getTransformNodeByName("debugAudio:speaker:audio")!;
    expect(root.position.asArray()).toEqual([12, 0, 0]);
    const inner = root.getChildMeshes().filter((mesh) => mesh.name.includes(":inner:")) as LinesMesh[];
    const outer = root.getChildMeshes().filter((mesh) => mesh.name.includes(":max:")) as LinesMesh[];
    expect(inner).toHaveLength(3);
    expect(outer).toHaveLength(3);
    for (const [meshes, radius, color] of [[inner, 3, [0, 1, 0]], [outer, 12, [1, 1, 0]]] as const) {
      for (const mesh of meshes) {
        expect(mesh.color.asArray()).toEqual(color);
        expect(mesh.isPickable).toBe(false);
        expect(isViewportShadingTarget(mesh)).toBe(false);
        const vertices = mesh.getVerticesData(VertexBuffer.PositionKind)!;
        let maxRadius = 0;
        for (let i = 0; i < vertices.length; i += 3) {
          maxRadius = Math.max(maxRadius, Math.hypot(vertices[i]!, vertices[i + 1]!, vertices[i + 2]!));
        }
        expect(maxRadius).toBeCloseTo(radius, 4);
      }
    }
    const origin = MeshBuilder.CreateBox(editorMeshName(actor.id), {}, scene);
    origin.position.x = 10;
    origin.scaling.set(2, 3, 4);
    const parent = new TransformNode("parent", scene);
    parent.position.x = 100;
    origin.parent = parent;
    const visual = MeshBuilder.CreateBox(editorComponentMeshName(actor.id, "audio"), {}, scene);
    visual.parent = origin;
    visual.position.x = 1;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(root.position.asArray()).toEqual([112, 0, 0]);
    expect(root.scaling.asArray()).toEqual([1, 1, 1]);
    origin.position.x = 20;
    overlay.followLivePose();
    expect(root.position.asArray()).toEqual([122, 0, 0]);
    // A rebuilt emitter replaces the one the overlay was following.
    visual.dispose();
    const rebuilt = MeshBuilder.CreateBox(editorComponentMeshName(actor.id, "audio"), {}, scene);
    rebuilt.parent = origin;
    rebuilt.position.x = 3;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(root.position.asArray()).toEqual([126, 0, 0]);
    overlay.sync({ sceneData: sceneWith([actor]), selectedActorIds: [], audioLibrary });
    expect(root.isDisposed()).toBe(true);
    expect(scene.meshes.some((mesh) => mesh.name.startsWith("debugAudio:"))).toBe(false);
    overlay.dispose();
    expect(scene.onBeforeRenderObservable.hasObservers()).toBe(hadObservers);
  });

  it("still finds an emitter that arrives while other meshes leave, keeping the mesh count unchanged", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const actor = createActor("speaker", "Speaker", {
      components: [{
        id: "audio", classId: "AudioComponent",
        transform: identitySerializedTransform(),
        properties: { audioAssetGuid: "sound" },
      }],
    });
    const audioLibrary = {
      audio: new Map([["sound", { ...createDefaultAudioPayload(), soundAttenuationGuid: "near" }]]),
      attenuations: new Map([["near", { ...createDefaultSoundAttenuationPayload(), innerRadius: 3, maxRadius: 12 }]]),
    };
    const fillers = [MeshBuilder.CreateBox("filler-a", {}, scene), MeshBuilder.CreateBox("filler-b", {}, scene)];
    overlay.sync({ sceneData: sceneWith([actor]), selectedActorIds: [actor.id], audioLibrary });
    const root = scene.getTransformNodeByName("debugAudio:speaker:audio")!;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(root.position.x).toBe(0);
    // Babylon notifies added meshes after a deferral, so only the count and the
    // removals can reveal this swap on the next frame.
    for (const filler of fillers) filler.dispose();
    const origin = MeshBuilder.CreateBox(editorMeshName(actor.id), {}, scene);
    origin.position.x = 5;
    const visual = MeshBuilder.CreateBox(editorComponentMeshName(actor.id, "audio"), {}, scene);
    visual.parent = origin;
    visual.position.x = 2;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(root.position.x).toBe(7);
    overlay.dispose();
  });

  it("only draws selected Audio Components whose attenuation asset resolves", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const actor = createActor("prefab-root", "Prefab", {
      components: ["spatial", "dry", "missing"].map((id) => ({
        id, classId: "AudioComponent", properties: { audioAssetGuid: id },
      })),
    });
    const audioLibrary = {
      audio: new Map([
        ["spatial", { ...createDefaultAudioPayload(), soundAttenuationGuid: "near" }],
        ["dry", createDefaultAudioPayload()],
        ["missing", { ...createDefaultAudioPayload(), soundAttenuationGuid: "deleted" }],
      ]),
      attenuations: new Map([["near", createDefaultSoundAttenuationPayload()]]),
    };
    const options = { sceneData: sceneWith([actor]), selectedActorIds: [actor.id], audioLibrary };
    overlay.sync({ ...options, selectedComponentIds: ["dry", "missing"] });
    expect(scene.meshes.some((mesh) => mesh.name.startsWith("debugAudio:"))).toBe(false);
    overlay.sync({ ...options, selectedComponentIds: ["spatial"] });
    expect(scene.meshes.filter((mesh) => mesh.name.startsWith("debugAudio:"))).toHaveLength(6);
    audioLibrary.attenuations.clear();
    overlay.sync({ ...options, selectedComponentIds: ["spatial"] });
    expect(scene.meshes.some((mesh) => mesh.name.startsWith("debugAudio:"))).toBe(false);
    overlay.dispose();
  });

  it("draws a cone for a spot light, an arrow for a directional one, and re-aims when the selection switches", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const sceneData = sceneWith([
      lightActor("spot", { lightKind: "spot", range: 10, outerAngle: 45 }),
      lightActor("sun", { lightKind: "directional" }),
    ]);
    overlay.sync({ sceneData, selectedActorIds: ["spot"] });
    expect(overlay.lightDebugKind).toBe("spot");
    const cone = frustumWorldPoints(overlay.lightDebugMesh as TransformNode);
    expect(cone.some((point) => Math.abs(point.z - 10) < 1e-4)).toBe(true);

    overlay.sync({ sceneData, selectedActorIds: ["sun"] });
    expect(overlay.lightDebugKind).toBe("directional");
    // The arrow's shaft is 2 long down +Z, with no ring left from the cone.
    const arrow = frustumWorldPoints(overlay.lightDebugMesh as TransformNode);
    expect(maxAbs(arrow, "z")).toBeLessThanOrEqual(2 + 1e-4);
    expect(maxAbs(arrow, "x")).toBeLessThanOrEqual(0.25 + 1e-4);
    overlay.dispose();
  });

  it("aims light debug from the composed LightComponent transform", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const sceneData = sceneWith([
      createActor("spot", "Spot", {
        transform: { ...identitySerializedTransform(), position: [2, 0, 0] },
        components: [
          {
            id: "light",
            classId: "LightComponent",
            transform: {
              ...identitySerializedTransform(),
              position: [1, 0, 0],
              rotation: eulerDegreesToQuaternion([0, 90, 0]),
            },
            properties: { lightKind: "spot", range: 10, outerAngle: 45 },
          },
        ],
      }),
    ]);
    overlay.sync({ sceneData, selectedActorIds: ["spot"] });
    const points = frustumWorldPoints(overlay.lightDebugMesh as TransformNode);
    // The cone opens from the apex at (3, 0, 0) toward +X, with its base ring 10 away.
    expect(Math.min(...points.map((point) => point.x))).toBeCloseTo(3, 4);
    expect(Math.max(...points.map((point) => point.x))).toBeCloseTo(13, 4);
    for (const apex of points.filter((point) => point.x < 3 + 1e-4)) {
      expect(apex.subtract(new Vector3(3, 0, 0)).length()).toBeCloseTo(0, 4);
    }
    overlay.dispose();
  });

  it("aims light debug from an attached actor's parent-resolved pose", () => {
    const { scene } = createHandle();
    const overlay = new EditorDebugOverlay(scene);
    const sceneData = sceneWith([
      createActor("car", "Car", {
        transform: {
          ...identitySerializedTransform(),
          position: [0, 0, 5],
          rotation: eulerDegreesToQuaternion([0, 90, 0]),
        },
      }),
      createActor("spot", "Spot", {
        parentId: "car",
        transform: { ...identitySerializedTransform(), position: [0, 0, 2] },
        components: [
          { id: "light", classId: "LightComponent", properties: { lightKind: "spot", range: 10, outerAngle: 45 } },
        ],
      }),
    ]);
    overlay.sync({ sceneData, selectedActorIds: ["spot"] });
    const points = frustumWorldPoints(overlay.lightDebugMesh as TransformNode);
    // The car turns the child's local +Z offset and forward onto world +X.
    expect(Math.min(...points.map((point) => point.x))).toBeCloseTo(2, 4);
    expect(Math.max(...points.map((point) => point.x))).toBeCloseTo(12, 4);
    for (const apex of points.filter((point) => point.x < 2 + 1e-4)) {
      expect(apex.subtract(new Vector3(2, 0, 5)).length()).toBeCloseTo(0, 4);
    }
    overlay.dispose();
  });

  it("follows an area light's native parent, hides without it, and never changes scene membership", () => {
    const { scene } = createHandle();
    const parent = new TransformNode("area parent", scene);
    const native = new PointLight("authoredAreaLight:panel:light", Vector3.Zero(), scene);
    native.parent = parent;
    const overlay = new EditorDebugOverlay(scene);
    const baseline = membership(scene);
    const area = (width: number, height: number) => sceneWith([createActor("panel", "Panel", {
      components: [{ id: "light", classId: "AreaRectLightComponent", properties: { width, height } }],
    })]);
    overlay.sync({ sceneData: area(4, 2), selectedActorIds: ["panel"] });
    const root = overlay.lightDebugMesh as TransformNode;
    expect(overlay.lightDebugKind).toBe("area");
    expect(root.isEnabled()).toBe(true);
    // The rectangle spans the light's width and height, and the guides point down local -Z.
    expect(maxAbs(frustumWorldPoints(root), "x")).toBeCloseTo(2, 3);
    expect(maxAbs(frustumWorldPoints(root), "y")).toBeCloseTo(1, 3);

    // A gizmo drag moves the parent before any document commit; the next frame follows it.
    parent.position.set(5, 0, 0);
    parent.rotationQuaternion = Quaternion.FromEulerAngles(0, Math.PI / 2, 0);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    const moved = frustumWorldPoints(root);
    // The parent's quarter turn lays the 4-wide rectangle along Z and the emission side (-Z) along -X from x = 5.
    expect(Math.min(...moved.map((point) => point.x))).toBeCloseTo(3, 3);
    expect(Math.max(...moved.map((point) => point.x))).toBeCloseTo(5, 3);
    expect(maxAbs(moved, "z")).toBeCloseTo(2, 3);

    overlay.sync({ sceneData: area(8, 6), selectedActorIds: ["panel"] });
    expect(maxAbs(frustumWorldPoints(root), "z")).toBeCloseTo(4, 3);

    native.metadata = { areaLight: { error: "unsupported" } };
    overlay.sync({ sceneData: area(8, 6), selectedActorIds: ["panel"] });
    expect(overlay.lightDebugMesh).toBeNull();
    expect(root.isEnabled()).toBe(false);
    native.metadata = null;
    overlay.sync({ sceneData: area(8, 6), selectedActorIds: ["panel"] });
    expect(root.isEnabled()).toBe(true);
    // Rebuilding the native light hides the guide until a sync finds the new one.
    native.dispose();
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(root.isEnabled()).toBe(false);
    expect({ ...membership(scene), lights: 0 }).toEqual({ ...baseline, lights: 0 });
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

  it("follows the editor origin mesh without becoming its child, so rebuilding the mesh cannot dispose the guide", () => {
    const { scene } = createHandle();
    const origin = MeshBuilder.CreateBox(editorMeshName("cam"), { size: 0.01 }, scene);
    origin.position.set(4, 1, -2);
    const overlay = new EditorDebugOverlay(scene);
    const sceneData = sceneWith([cameraActor()]);
    overlay.sync({ sceneData, selectedActorIds: ["cam"] });
    const root = overlay.frustumMesh as TransformNode;
    expect(root.parent).toBeNull();
    expect(root.getAbsolutePosition().asArray()).toEqual([4, 1, -2]);

    // A gizmo drag moves the origin before the commit; the next frame follows it.
    origin.position.set(9, 3, -5);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(root.getAbsolutePosition().asArray()).toEqual([9, 3, -5]);

    // Editing the camera rebuilds the actor's meshes, and the guide survives and follows the new one.
    const guide = root.getChildMeshes()[0]!;
    origin.dispose();
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(root.isDisposed()).toBe(false);
    expect(guide.isDisposed()).toBe(false);
    const rebuilt = MeshBuilder.CreateBox(editorMeshName("cam"), { size: 0.01 }, scene);
    rebuilt.position.set(-3, 2, 6);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(root.getAbsolutePosition().asArray()).toEqual([-3, 2, 6]);
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
    const preview = previewCamera(overlay);
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
    const preview = previewCamera(overlay) as FreeCamera;
    expect(preview.name).toBe("debugPreviewCam:cam");
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

  it("draws a disabled, manual Render Target Capture's frustum and a live-following preview", () => {
    const { scene } = createHandle();
    const origin = MeshBuilder.CreateBox(editorMeshName("rt"), { size: 0.01 }, scene);
    const overlay = new EditorDebugOverlay(scene, { now: () => 0 });
    const sceneData = sceneWith([
      captureActor({ enabled: false, captureEveryFrame: false, renderTargetGuid: null }),
    ]);
    overlay.sync({ sceneData, selectedActorIds: ["rt"] });
    expect((overlay.frustumMesh as TransformNode).getAbsolutePosition().asArray()).toEqual(origin.position.asArray());
    expect(overlay.previewTexture).not.toBeNull();
    expect(overlay.previewRenderCount).toBe(1);

    origin.position.set(9, 3, -5);
    origin.computeWorldMatrix(true);
    overlay.followLivePose();
    const followed = previewCamera(overlay).position;
    expect([followed.x, followed.y, followed.z].map((value) => Math.round(value * 1e5) / 1e5))
      .toEqual([9, 3, -5]);

    overlay.sync({ sceneData, selectedActorIds: [] });
    expect(overlay.frustumMesh).toBeNull();
    expect(overlay.previewTexture).toBeNull();
    // The camera and RTT are kept for the next selection, but nothing draws the preview.
    const drawn = vi.spyOn(RenderTargetTexture.prototype, "render");
    overlay.tick(10_000);
    expect(drawn).not.toHaveBeenCalled();
    drawn.mockRestore();
    overlay.dispose();
  });

  it("retargets one preview camera and RTT between lenses instead of creating new ones", () => {
    const { scene } = createHandle();
    const targets = renderTargetMap({ wide: { width: 16, height: 8 } });
    const overlay = new EditorDebugOverlay(scene, { now: () => 0, renderTargets: () => targets });
    const baseline = membership(scene);
    const sceneData = sceneWith([
      cameraActor(),
      captureActor({ renderTargetGuid: "wide", fieldOfView: 90 }),
      createActor("ortho", "Ortho", {
        components: [{
          id: "camera",
          classId: "CameraComponent",
          properties: { projectionMode: "orthographic", orthographicSize: 5 },
        }],
      }),
    ]);

    // Even the first lens selection leaves the scene's cameras and textures alone.
    overlay.sync({ sceneData, selectedActorIds: ["cam"] });
    expect(membership(scene)).toEqual(baseline);
    const texture = overlay.previewTexture!;
    const camera = previewCamera(overlay);
    expect(texture.getSize()).toEqual({ width: 320, height: 180 });
    expect(camera.name).toBe("debugPreviewCam:cam");

    overlay.sync({ sceneData, selectedActorIds: ["rt"] });
    expect(overlay.previewTexture).toBe(texture);
    expect(texture.getSize()).toEqual({ width: 320, height: 160 });
    expect(texture.name).toBe("debugCameraPreview:rt");
    expect(projectionAspect(camera)).toBeCloseTo(2, 5);

    // An orthographic lens fully replaces the perspective capture's lens state.
    overlay.sync({ sceneData, selectedActorIds: ["ortho"] });
    expect(texture.getSize()).toEqual({ width: 320, height: 180 });
    expect(camera.mode).toBe(FreeCamera.ORTHOGRAPHIC_CAMERA);
    expect(camera.orthoRight! / camera.orthoTop!).toBeCloseTo(CAMERA_PREVIEW_WIDTH / CAMERA_PREVIEW_HEIGHT, 5);

    overlay.sync({ sceneData, selectedActorIds: ["cam"] });
    expect(camera.mode).toBe(FreeCamera.PERSPECTIVE_CAMERA);
    expect(membership(scene)).toEqual(baseline);
    overlay.dispose();
  });

  it.each([
    { label: "a wide 16x8 target", guid: "wide", fieldOfView: 90, aspect: 2, size: { width: 320, height: 160 } },
    { label: "a tall 8x16 target", guid: "tall", fieldOfView: 90, aspect: 0.5, size: { width: 90, height: 180 } },
    { label: "no assigned target", guid: null, fieldOfView: 30, aspect: 1, size: { width: 180, height: 180 } },
    { label: "a missing target asset", guid: "deleted", fieldOfView: 90, aspect: 1, size: { width: 180, height: 180 } },
  ])("sizes a capture frustum and preview from its lens and $label", ({ guid, fieldOfView, aspect, size }) => {
    const { scene, engine } = createHandle();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(200);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(800);
    const targets = renderTargetMap({ wide: { width: 16, height: 8 }, tall: { width: 8, height: 16 } });
    const overlay = new EditorDebugOverlay(scene, { now: () => 0, renderTargets: () => targets });
    overlay.sync({
      sceneData: sceneWith([
        captureActor({ renderTargetGuid: guid, fieldOfView, nearClip: 1, farClip: 20 }),
      ]),
      selectedActorIds: ["rt"],
    });
    const points = frustumWorldPoints(overlay.frustumMesh as TransformNode);
    const farHalfHeight = Math.tan((fieldOfView * Math.PI) / 360) * 20;
    expect(maxAbs(points, "z")).toBeCloseTo(20, 5);
    expect(maxAbs(points, "y")).toBeCloseTo(farHalfHeight, 5);
    expect(maxAbs(points, "x")).toBeCloseTo(farHalfHeight * aspect, 5);
    const preview = previewCamera(overlay);
    expect(overlay.previewTexture!.getSize()).toEqual(size);
    expect(projectionAspect(preview)).toBeCloseTo(aspect, 5);
    expect([preview.minZ, preview.maxZ]).toEqual([1, 20]);
    overlay.dispose();
  });

  it("previews only capture-eligible meshes and honours Capture Only Actors by nearest actor", () => {
    const { scene } = createHandle();
    const subject = MeshBuilder.CreateBox(editorMeshName("subject"), {}, scene);
    const part = MeshBuilder.CreateBox(editorComponentMeshName("subject", "mesh"), {}, scene);
    part.parent = subject;
    const attached = MeshBuilder.CreateBox(editorMeshName("attached"), {}, scene);
    attached.parent = subject;
    const other = MeshBuilder.CreateBox(editorMeshName("other"), {}, scene);
    const world = MeshBuilder.CreateBox("world", {}, scene);
    const proxy = MeshBuilder.CreateBox("pick proxy", {}, scene);
    proxy.metadata = { editorPickProxy: true };
    const billboard = MeshBuilder.CreatePlane("billboard", {}, scene);
    billboard.metadata = { editorBillboard: "point_light" };
    const guide = MeshBuilder.CreateLines("guide", { points: [Vector3.Zero(), Vector3.One()] }, scene);
    const model = createEditorCameraModel(scene, editorComponentMeshName("rt", "capture"));
    for (const helper of [proxy, billboard, guide, model]) helper.parent = subject;
    const overlay = new EditorDebugOverlay(scene, { now: () => 0 });

    overlay.sync({
      sceneData: sceneWith([captureActor({ captureOnlyActors: true, actorIds: ["subject"] })]),
      selectedActorIds: ["rt"],
    });
    const previewed = () => overlay.previewTexture!.renderList!.map((mesh) => mesh.name);
    expect(previewed()).toEqual([subject, part].map((mesh) => mesh.name));

    overlay.sync({ sceneData: sceneWith([captureActor()]), selectedActorIds: ["rt"] });
    expect(previewed()).toEqual([subject, part, attached, other, world].map((mesh) => mesh.name));
    overlay.dispose();
  });

  it("previews meshes sampling the capture's own output as well as other targets", () => {
    const { scene } = createHandle();
    const captures = sceneRenderTargetCaptures(scene);
    const textures = new Map([
      ["feed", { renderTargetGuid: "target" }],
      ["other feed", { renderTargetGuid: "other" }],
    ]);
    let targets = renderTargetMap({ target: { width: 16, height: 8 }, other: { width: 16, height: 8 } });
    captures.setAssets(targets, textures);
    const screen = (name: string, textureGuid: string) => {
      const mesh = MeshBuilder.CreatePlane(name, {}, scene);
      const material = new StandardMaterial(`${name} material`, scene);
      material.emissiveTexture = captures.acquireTexture(textureGuid)!.resource;
      mesh.material = material;
      return mesh;
    };
    const monitor = screen("monitor", "feed");
    const otherMonitor = screen("other monitor", "other feed");
    const wall = MeshBuilder.CreateBox("wall", {}, scene);
    const overlay = new EditorDebugOverlay(scene, { now: () => 0, renderTargets: () => targets });

    // Disabled, so the target has never published: the preview still shows
    // what the capture records once it runs.
    overlay.sync({
      sceneData: sceneWith([captureActor({ renderTargetGuid: "target", enabled: false })]),
      selectedActorIds: ["rt"],
    });
    const preview = overlay.previewTexture;
    const previewed = () => overlay.previewTexture!.renderList!.map((mesh) => mesh.name);
    expect(previewed()).toEqual([monitor, otherMonitor, wall].map((mesh) => mesh.name));

    // Depth and normal passes replace materials, so they record the monitor.
    targets = new Map<string, RenderTargetPayload>([...targets, ["target", { mode: "DepthPass", width: 16, height: 8 }]]);
    captures.setAssets(targets, textures);
    overlay.refreshRenderTargets();
    expect(overlay.previewTexture).toBe(preview);
    expect(previewed()).toEqual([monitor, otherMonitor, wall].map((mesh) => mesh.name));
    overlay.dispose();
  });

  it("resizes a selected capture preview and reshapes its frustum only when its target's aspect changes", () => {
    const { scene } = createHandle();
    let targets = renderTargetMap({ target: { width: 16, height: 8 } });
    const overlay = new EditorDebugOverlay(scene, { now: () => 0, renderTargets: () => targets });
    overlay.sync({
      sceneData: sceneWith([captureActor({ renderTargetGuid: "target" })]),
      selectedActorIds: ["rt"],
    });
    const preview = overlay.previewTexture!;
    const resize = vi.spyOn(preview, "resize");
    const rendered = overlay.previewRenderCount;
    targets = renderTargetMap({ target: { width: 32, height: 16 } });
    overlay.refreshRenderTargets();
    expect(resize).not.toHaveBeenCalled();
    expect(overlay.previewRenderCount).toBe(rendered);

    targets = renderTargetMap({ target: { width: 8, height: 16 } });
    overlay.refreshRenderTargets();
    // The retained RTT changes size in place; no second texture joins the scene.
    expect(overlay.previewTexture).toBe(preview);
    expect(resize).toHaveBeenCalledOnce();
    expect(preview.getSize()).toEqual({ width: 90, height: 180 });
    expect(projectionAspect(previewCamera(overlay))).toBeCloseTo(0.5, 5);
    const points = frustumWorldPoints(overlay.frustumMesh as TransformNode);
    expect(maxAbs(points, "x") / maxAbs(points, "y")).toBeCloseTo(0.5, 5);
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
