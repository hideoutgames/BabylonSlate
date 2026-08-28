import { describe, expect, it } from "vitest";
import {
  Mesh,
  MeshBuilder,
  PBRMaterial,
  StandardMaterial,
} from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { CAMERA_BOUNDS_MESH_NAME, GRID_MESH_NAME } from "./editor-grid";
import { EditorSceneSync } from "./editor-scene-sync";
import {
  isViewportShadingTarget,
  ViewportShadingOverlay,
} from "./viewport-shading-mode";

describe("isViewportShadingTarget", () => {
  it("keeps actor meshes and skips editor chrome", () => {
    const { engine, scene } = createTestEngine();
    const actor = MeshBuilder.CreateBox("box", { size: 1 }, scene);
    const billboard = MeshBuilder.CreatePlane("icon", { size: 1 }, scene);
    billboard.metadata = { editorBillboard: "camera" };
    const volume = MeshBuilder.CreateBox("volume", { size: 1 }, scene);
    volume.metadata = { editorVolume: true };
    const collider = MeshBuilder.CreateBox("collider", { size: 1 }, scene);
    collider.metadata = { editorColliderVisual: true };
    const origin = MeshBuilder.CreateBox("origin", { size: 1 }, scene);
    origin.metadata = { editorActorOrigin: true };
    const placeholder = new Mesh("model-root", scene);
    placeholder.metadata = { editorModelPlaceholder: true };
    const grid = MeshBuilder.CreateGround(GRID_MESH_NAME, { width: 1, height: 1 }, scene);
    const bounds = MeshBuilder.CreateGround(
      CAMERA_BOUNDS_MESH_NAME,
      { width: 1, height: 1 },
      scene,
    );
    const frustum = MeshBuilder.CreateBox("debugFrustum:cam:0", { size: 1 }, scene);

    expect(isViewportShadingTarget(actor)).toBe(true);
    expect(isViewportShadingTarget(billboard)).toBe(false);
    expect(isViewportShadingTarget(volume)).toBe(false);
    expect(isViewportShadingTarget(collider)).toBe(false);
    expect(isViewportShadingTarget(origin)).toBe(false);
    expect(isViewportShadingTarget(placeholder)).toBe(false);
    expect(isViewportShadingTarget(grid)).toBe(false);
    expect(isViewportShadingTarget(bounds)).toBe(false);
    expect(isViewportShadingTarget(frustum)).toBe(false);
    engine.dispose();
  });
});

describe("ViewportShadingOverlay", () => {
  it("sets wireframe on actor materials and leaves helper chrome alone", () => {
    const { engine, scene } = createTestEngine();
    const mesh = MeshBuilder.CreateBox("actor", { size: 1 }, scene);
    mesh.material = new StandardMaterial("actor-mat", scene);
    const helper = MeshBuilder.CreateBox("helper", { size: 1 }, scene);
    helper.material = new StandardMaterial("helper-mat", scene);
    helper.metadata = { editorBillboard: "default" };
    const overlay = new ViewportShadingOverlay(scene);
    overlay.setMode("wireframe");
    expect(mesh.material.wireframe).toBe(true);
    expect(helper.material.wireframe).toBe(false);
    engine.dispose();
  });

  it("sets unlit flags and lightsEnabled, then restores authored lighting on PBR", () => {
    const { engine, scene } = createTestEngine();
    scene.lightsEnabled = true;
    const standard = new StandardMaterial("std", scene);
    const pbr = new PBRMaterial("pbr", scene);
    pbr.unlit = false;
    const alreadyUnlit = new PBRMaterial("sky", scene);
    alreadyUnlit.unlit = true;
    const stdMesh = MeshBuilder.CreateBox("std-mesh", { size: 1 }, scene);
    stdMesh.material = standard;
    const pbrMesh = MeshBuilder.CreateBox("pbr-mesh", { size: 1 }, scene);
    pbrMesh.material = pbr;
    const sky = MeshBuilder.CreateBox("sky", { size: 1 }, scene);
    sky.material = alreadyUnlit;
    const overlay = new ViewportShadingOverlay(scene);
    overlay.setMode("unlit");
    expect(scene.lightsEnabled).toBe(false);
    expect(standard.disableLighting).toBe(true);
    expect(pbr.unlit).toBe(true);
    expect(alreadyUnlit.unlit).toBe(true);
    overlay.setMode("pbr");
    expect(scene.lightsEnabled).toBe(true);
    expect(standard.disableLighting).toBe(false);
    expect(pbr.unlit).toBe(false);
    expect(alreadyUnlit.unlit).toBe(true);
    engine.dispose();
  });

  it("keeps Unlit albedo flags without an engine hemispheric fill", () => {
    const { engine, scene } = createTestEngine();
    scene.lightsEnabled = true;
    expect(scene.getLightByName("light")).toBeNull();
    const pbr = new PBRMaterial("pbr", scene);
    pbr.unlit = false;
    const alreadyUnlit = new PBRMaterial("sky", scene);
    alreadyUnlit.unlit = true;
    const pbrMesh = MeshBuilder.CreateBox("pbr-mesh", { size: 1 }, scene);
    pbrMesh.material = pbr;
    const sky = MeshBuilder.CreateBox("sky", { size: 1 }, scene);
    sky.material = alreadyUnlit;
    const overlay = new ViewportShadingOverlay(scene);
    overlay.setMode("unlit");
    expect(scene.lightsEnabled).toBe(false);
    expect(pbr.unlit).toBe(true);
    expect(alreadyUnlit.unlit).toBe(true);
    overlay.setMode("pbr");
    expect(scene.lightsEnabled).toBe(true);
    expect(pbr.unlit).toBe(false);
    expect(alreadyUnlit.unlit).toBe(true);
    engine.dispose();
  });

  it("restores an authored points-cloud fill when returning to PBR", () => {
    const { engine, scene } = createTestEngine();
    const mesh = MeshBuilder.CreateBox("actor", { size: 1 }, scene);
    mesh.material = new StandardMaterial("actor-mat", scene);
    mesh.material.pointsCloud = true;
    const overlay = new ViewportShadingOverlay(scene);
    overlay.setMode("wireframe");
    expect(mesh.material.wireframe).toBe(true);
    expect(mesh.material.pointsCloud).toBe(false);
    overlay.setMode("pbr");
    expect(mesh.material.wireframe).toBe(false);
    expect(mesh.material.pointsCloud).toBe(true);
    engine.dispose();
  });

  it("re-applies the current mode after EditorSceneSync creates a mesh", () => {
    const { engine, scene } = createTestEngine();
    const overlay = new ViewportShadingOverlay(scene);
    overlay.setMode("wireframe");
    const sync = new EditorSceneSync(scene, undefined, {
      onAfterApply: () => overlay.apply(),
    });
    sync.apply({
      ...createDefaultScene(),
      actors: [
        createActor("box", "Box", {
          components: [createMeshComponent("mesh", "box")],
        }),
      ],
    });
    const visual = sync.visualMeshesForActor("box")[0];
    const material = visual?.material ?? scene.defaultMaterial;
    expect(material.wireframe).toBe(true);
    engine.dispose();
  });
});
