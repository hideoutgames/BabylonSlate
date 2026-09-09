import { describe, expect, it, vi } from "vitest";
import {
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PBRMetallicRoughnessBlock,
  RawTexture,
  StandardMaterial,
  Vector3,
  type Scene,
} from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
} from "@babylonslate/core";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { createTestEngine } from "./create-null-engine";
import { CAMERA_BOUNDS_MESH_NAME, GRID_MESH_NAME } from "./editor-grid";
import { EditorSceneSync } from "./editor-scene-sync";
import {
  isViewportShadingTarget,
  ViewportShadingOverlay,
} from "./viewport-shading-mode";

function compiledPbr(scene: Scene) {
  // NullEngine cannot upload the BRDF lookup; retain real shader compilation.
  scene.environmentBRDFTexture ??= RawTexture.CreateRGBATexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    scene,
  );
  vi.spyOn(scene.environmentBRDFTexture, "isReady").mockReturnValue(true);
  const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
  if (!lowered.ok) throw new Error("Fixture material did not lower");
  const compiled = compileMaterialPlan(lowered.plan, {
    scene,
    name: "surface",
  });
  if (!compiled.ok) throw new Error("Fixture material did not compile");
  compiled.material.allowShaderHotSwapping = false;
  return compiled.material;
}

async function shaderDefines(scene: Scene, mesh: Mesh): Promise<string> {
  scene.incrementRenderId();
  const material = mesh.material ?? scene.defaultMaterial;
  await vi.waitFor(() =>
    expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true),
  );
  return mesh.subMeshes[0]!.effect!.defines;
}

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
    const grid = MeshBuilder.CreateGround(
      GRID_MESH_NAME,
      { width: 1, height: 1 },
      scene,
    );
    const bounds = MeshBuilder.CreateGround(
      CAMERA_BOUNDS_MESH_NAME,
      { width: 1, height: 1 },
      scene,
    );
    const frustum = MeshBuilder.CreateBox(
      "debugFrustum:cam:0",
      { size: 1 },
      scene,
    );

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
  it("restores lighting for a frozen surface first compiled in Unlit", async () => {
    const { engine, scene } = createTestEngine();
    try {
      new HemisphericLight("key", Vector3.Up(), scene);
      const overlay = new ViewportShadingOverlay(scene);
      overlay.setMode("unlit");
      const mesh = MeshBuilder.CreateBox("actor", {}, scene);
      const material = compiledPbr(scene);
      mesh.material = material;
      material.freeze();
      scene.blockMaterialDirtyMechanism = true;
      overlay.apply();
      expect(await shaderDefines(scene, mesh)).toContain("#define UNLIT");
      overlay.setMode("pbr");
      const defines = await shaderDefines(scene, mesh);
      expect(defines).not.toContain("#define UNLIT");
      expect(defines).toContain("#define LIGHT0");
      expect(mesh.subMeshes[0]!.effect!.fragmentSourceCode).toContain("vLightData0");
      expect(material.isFrozen).toBe(true);
    } finally {
      engine.dispose();
    }
  });

  it.each(["compiled", "native"] as const)(
    "refreshes the frozen %s PBR shader through Unlit and restores shading",
    async (kind) => {
      const { engine, scene } = createTestEngine();
      try {
        // No light-policy transition can mask a missing overlay invalidation.
        scene.lightsEnabled = false;
        const mesh = MeshBuilder.CreateBox("actor", {}, scene);
        const material =
          kind === "compiled"
            ? compiledPbr(scene)
            : new PBRMaterial("native", scene);
        material.allowShaderHotSwapping = false;
        mesh.material = material;
        material.freeze();
        expect(await shaderDefines(scene, mesh)).not.toContain("#define UNLIT");
        const overlay = new ViewportShadingOverlay(scene);
        scene.blockMaterialDirtyMechanism = true;
        overlay.setMode("unlit");
        expect(await shaderDefines(scene, mesh)).toContain("#define UNLIT");
        expect(material.isFrozen).toBe(true);
        expect(scene.blockMaterialDirtyMechanism).toBe(true);
        overlay.apply();
        expect(await shaderDefines(scene, mesh)).toContain("#define UNLIT");
        overlay.setMode("wireframe");
        expect(await shaderDefines(scene, mesh)).not.toContain("#define UNLIT");
        expect(material.wireframe).toBe(true);
        overlay.setMode("pbr");
        expect(await shaderDefines(scene, mesh)).not.toContain("#define UNLIT");
        expect(material.wireframe).toBe(false);
        expect(material.isFrozen).toBe(true);
        expect(mesh.material).toBe(material);
        expect(scene.lightsEnabled).toBe(false);
      } finally {
        engine.dispose();
      }
    },
  );

  it("applies Unlit to newly assigned surface graphs and preserves authored unlit blocks", async () => {
    const { engine, scene } = createTestEngine();
    try {
      const overlay = new ViewportShadingOverlay(scene);
      overlay.setMode("unlit");
      const mesh = MeshBuilder.CreateBox("late-model", {}, scene);
      const authored = compiledPbr(scene);
      const block = authored.attachedBlocks.find(
        (candidate): candidate is PBRMetallicRoughnessBlock =>
          candidate instanceof PBRMetallicRoughnessBlock,
      )!;
      block.unlit = true;
      mesh.material = authored;
      overlay.apply();
      expect(await shaderDefines(scene, mesh)).toContain("#define UNLIT");
      overlay.setMode("pbr");
      expect(await shaderDefines(scene, mesh)).toContain("#define UNLIT");
      overlay.setMode("unlit");
      const replacement = compiledPbr(scene);
      mesh.material = replacement;
      overlay.apply();
      expect(await shaderDefines(scene, mesh)).toContain("#define UNLIT");
      overlay.setMode("pbr");
      expect(await shaderDefines(scene, mesh)).not.toContain("#define UNLIT");
      expect(mesh.material).toBe(replacement);
      expect(block.unlit).toBe(true);
    } finally {
      engine.dispose();
    }
  });

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
