import { Mesh, Ray, StandardMaterial, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createActor, createDefaultScene, identitySerializedTransform, type SerializedActor } from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { createEditorCamera } from "./editor-camera";
import { createEditorCameraModel } from "./editor-camera-model";
import { EditorSceneSync } from "./editor-scene-sync";
import { editorComponentMeshName } from "./scene-loader";
import { AUTHORED_CAMERA_PREFIX } from "./scene-illumination";
import { participatesInShadows } from "./shadow-mesh-policy";
import { ViewportShadingOverlay } from "./viewport-shading-mode";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => {
  for (const { scene, engine } of handles.splice(0)) {
    scene.dispose();
    engine.dispose();
  }
});

function setup() {
  const handle = createTestEngine();
  handles.push(handle);
  return handle;
}

function cameraActor(id: string): SerializedActor {
  return createActor(id, id, {
    components: [{ id: "camera", classId: "CameraComponent", properties: {}, transform: identitySerializedTransform() }],
  });
}

/** Read the actual exported front-face winding, rather than a claimed asset axis. */
function lensDirection(mesh: Mesh): Vector3 {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
  const colors = mesh.getVerticesData(VertexBuffer.ColorKind)!;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, mesh.getIndices()!, normals);
  let front = 0;
  for (let i = 3; i < positions.length; i += 3) {
    // The broad dark lens face is inset behind the lip of the housing.
    if (colors[(i / 3) * 4]! < colors[(front / 3) * 4]!) front = i;
  }
  mesh.computeWorldMatrix(true);
  return Vector3.TransformNormal(Vector3.FromArray(normals, front), mesh.getWorldMatrix()).normalize();
}

describe("editor camera model", () => {
  it("shares a small texture-free mesh and releases its resources after the last camera", () => {
    const { scene } = setup();
    const first = createEditorCameraModel(scene, "first");
    const second = createEditorCameraModel(scene, "second");
    const geometry = first.geometry!;
    const material = first.material!;
    expect(first.getTotalIndices() / 3).toBeLessThan(256);
    expect(first.subMeshes).toHaveLength(1);
    expect(material.getActiveTextures()).toEqual([]);
    expect(second.geometry).toBe(geometry);
    expect(second.material).toBe(material);
    first.dispose();
    expect(second.getTotalVertices()).toBeGreaterThan(0);
    expect(geometry.isDisposed()).toBe(false);
    second.dispose();
    expect(geometry.isDisposed()).toBe(true);
    expect(scene.materials).not.toContain(material);
    const replacement = createEditorCameraModel(scene, "replacement");
    expect(replacement.geometry).not.toBe(geometry);
    expect(replacement.getTotalVertices()).toBeGreaterThan(0);
  });

  it("aims the exported lens along the camera view, including incremental actor and component rotations", () => {
    const { scene } = setup();
    createEditorCamera(scene);
    const sync = new EditorSceneSync(scene);
    const actor = cameraActor("cam");
    const data = { ...createDefaultScene(), actors: [actor] };
    sync.apply(data);
    const model = scene.getMeshByName(editorComponentMeshName("cam", "camera")) as Mesh;
    expect(lensDirection(model).equalsWithEpsilon(new Vector3(0, 0, 1))).toBe(true);
    // The entire body stays behind the optical origin, outside its own view.
    expect(model.getBoundingInfo().boundingBox.maximum.z).toBeLessThan(0);
    for (const [actorYaw, componentYaw, forward] of [
      [Math.SQRT1_2, 0, new Vector3(1, 0, 0)],
      [Math.SQRT1_2, Math.SQRT1_2, new Vector3(0, 0, -1)],
    ] as const) {
      const next = structuredClone(data);
      next.actors[0]!.transform.rotation = [0, actorYaw, 0, Math.SQRT1_2];
      next.actors[0]!.components[0]!.transform!.rotation = [0, componentYaw, 0, componentYaw ? Math.SQRT1_2 : 1];
      sync.apply(next);
      expect(scene.getMeshByName(model.name)).toBe(model);
      expect(lensDirection(model).equalsWithEpsilon(forward, 1e-5)).toBe(true);
      const camera = scene.getCameraByName(`${AUTHORED_CAMERA_PREFIX}cam`)!;
      expect(camera.getDirection(Vector3.Forward()).equalsWithEpsilon(forward, 1e-5)).toBe(true);
    }
    sync.dispose();
  });

  it("keeps cameras pickable in the editor but out of Game Camera preview", () => {
    const { scene } = setup();
    const editor = createEditorCamera(scene);
    const sync = new EditorSceneSync(scene);
    const primary = cameraActor("primary");
    const other = cameraActor("other");
    other.transform.position = [0, 0, 4];
    const data = { ...createDefaultScene(), actors: [primary, other] };
    data.settings.mainCameraActorId = "primary";
    data.settings.mainCameraComponentId = "camera";
    sync.apply(data);
    const model = scene.getMeshByName(editorComponentMeshName("other", "camera")) as Mesh;
    const active = () => scene.getActiveMeshes().data.slice(0, scene.getActiveMeshes().length);
    expect(active()).toContain(model);
    const hit = scene.pickWithRay(new Ray(new Vector3(0, 0, 5), new Vector3(0, 0, -1)), (mesh) => mesh === model);
    expect(hit?.hit).toBe(true);
    expect(sync.actorForMesh(hit!.pickedMesh!.name)).toBe("other");
    sync.setGameCameraPreview(true, editor.camera);
    expect(active()).not.toContain(model);
    sync.setGameCameraPreview(false, editor.camera);
    expect(active()).toContain(model);
    const hidden = structuredClone(data);
    hidden.actors[1]!.visible = false;
    hidden.actors[0]!.locked = true;
    sync.apply(hidden);
    expect(model.isVisible).toBe(false);
    expect(scene.getMeshByName(editorComponentMeshName("primary", "camera"))!.isPickable).toBe(false);
    sync.dispose();
  });

  it("keeps the helper unlit and out of shadows when viewport shading changes", () => {
    const { scene } = setup();
    const model = createEditorCameraModel(scene, "camera");
    const overlay = new ViewportShadingOverlay(scene);
    overlay.setMode("wireframe");
    expect((model.material as StandardMaterial).disableLighting).toBe(true);
    expect(model.material!.wireframe).toBe(false);
    expect(participatesInShadows(model)).toBe(false);
  });
});
