import { afterEach, describe, expect, it, vi } from "vitest";
import { InputBlock, NodeMaterial, NullEngine, RawTexture, Scene, TextureBlock } from "@babylonjs/core";
import { createActor, createDefaultScene, createMeshComponent, type MaterialParameterValue, type SerializedScene } from "@babylonslate/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { EditorSceneSync } from "./editor-scene-sync";
import { MaterialLibrary } from "./material-library";
import { applySceneToBabylonScene, editorMeshName } from "./scene-loader";
import { authoredMaterialInstancePreparation } from "./authored-material-instance";
import type { MeshAssetContext } from "./mesh-assets";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()?.(); vi.restoreAllMocks(); });

function parameterDocument() {
  const document = createDefaultMaterialDocument();
  document.nodes.push({ id: "roughness", type: "param.float", position: { x: 0, y: 0 },
    properties: { name: "Roughness", value: [0.5] } });
  document.edges.push({ id: "roughness-output", sourceNodeId: "roughness", sourcePinId: "out",
    targetNodeId: "output", targetPinId: "roughness" });
  return document;
}

function sceneDocument(parameters?: Record<string, MaterialParameterValue>): SerializedScene {
  const component = createMeshComponent("body", "box");
  component.properties.materialGuid = "material";
  if (parameters) component.materialInstance = { materialGuid: "material", parameters };
  return { ...createDefaultScene(), actors: [createActor("actor", "Actor", { components: [component] })] };
}

function fixture(document = parameterDocument(), libraryOptions: ConstructorParameters<typeof MaterialLibrary>[0] = {}) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const library = new MaterialLibrary(libraryOptions);
  const assets: MeshAssetContext = {
    resolveMaterial: (guid, options) => guid === "material" ? library.resolve(scene, guid, document, options) : null,
    releaseMaterialInstance: (key, guid) => library.releaseInstance(key, guid),
    validateMaterialParameter: (guid, name, value) => guid === "material" && library.acceptsParameter(document, name, value),
  };
  const sync = new EditorSceneSync(scene, undefined, assets);
  disposers.push(() => { sync.dispose(); library.dispose(); scene.dispose(); engine.dispose(); });
  return { engine, scene, library, assets, sync };
}

describe("saved component material instances", () => {
  it("loads private uniforms, preserves shared defaults, and releases overrides on Undo and actor deletion", async () => {
    const f = fixture();
    const authored = sceneDocument({ Roughness: { kind: "float", value: 0.2 } });
    const second = structuredClone(authored.actors[0]!);
    second.id = "other";
    second.components[0]!.materialInstance!.parameters.Roughness = { kind: "float", value: 0.8 };
    authored.actors.push(second);
    const before = JSON.stringify(authored);
    f.sync.apply(authored);
    await f.sync.whenEditorModelsReady();
    const firstMaterial = f.sync.meshForActor("actor")!.material as NodeMaterial;
    const otherMaterial = f.sync.meshForActor("other")!.material as NodeMaterial;
    const shared = f.library.materialFor(f.scene, "material")!;
    expect(firstMaterial).not.toBe(shared);
    expect(firstMaterial).not.toBe(otherMaterial);
    expect((firstMaterial.getBlockByName("roughness") as InputBlock).value).toBe(0.2);
    expect((otherMaterial.getBlockByName("roughness") as InputBlock).value).toBe(0.8);
    expect((shared.getBlockByName("roughness") as InputBlock).value).toBe(0.5);
    expect(JSON.stringify(authored)).toBe(before);

    const restored = structuredClone(authored);
    delete restored.actors[0]!.components[0]!.materialInstance;
    f.sync.apply(restored);
    expect(f.sync.meshForActor("actor")!.material).toBe(shared);
    expect(f.scene.materials).not.toContain(firstMaterial);
    expect(f.scene.materials).toContain(otherMaterial);
    f.sync.apply({ ...restored, actors: [restored.actors[0]!] });
    expect(f.scene.materials).not.toContain(otherMaterial);
    expect(f.scene.materials).toContain(shared);
  });

  it("reapplies saved values on a full scene load and ignores values for a different assignment", async () => {
    const f = fixture();
    const authored = sceneDocument({ Roughness: { kind: "float", value: 0.3 } });
    applySceneToBabylonScene(f.scene, authored, f.assets);
    const visual = f.scene.getMeshByName(editorMeshName("actor"))!;
    await authoredMaterialInstancePreparation(visual as import("@babylonjs/core").Mesh);
    const material = visual.material as NodeMaterial;
    expect((material.getBlockByName("roughness") as InputBlock).value).toBe(0.3);
    applySceneToBabylonScene(f.scene, { ...authored, actors: [] }, f.assets);
    expect(f.scene.materials).not.toContain(material);

    authored.actors[0]!.components[0]!.materialInstance!.materialGuid = "previous-assignment";
    f.sync.apply(authored);
    await f.sync.whenEditorModelsReady();
    expect(f.sync.meshForActor("actor")!.material).toBe(f.library.materialFor(f.scene, "material"));
    expect((f.library.materialFor(f.scene, "material")!.getBlockByName("roughness") as InputBlock).value).toBe(0.5);
  });

  it("keeps the working private material on texture failure and cancels a superseded texture lease", async () => {
    const document = createDefaultMaterialDocument();
    document.nodes.push(
      { id: "texture", type: "param.texture", position: { x: 0, y: 0 }, properties: { name: "Albedo", textureGuid: "working" } },
      { id: "uv", type: "input.uv", position: { x: 0, y: 0 }, properties: {} },
      { id: "sample", type: "texture.sample", position: { x: 0, y: 0 }, properties: {} },
    );
    document.edges = document.edges.filter((edge) => edge.id !== "e-color-output");
    document.edges.push(
      { id: "texture-sample", sourceNodeId: "texture", sourcePinId: "out", targetNodeId: "sample", targetPinId: "texture" },
      { id: "uv-sample", sourceNodeId: "uv", sourcePinId: "uv", targetNodeId: "sample", targetPinId: "uv" },
      { id: "sample-output", sourceNodeId: "sample", sourcePinId: "rgb", targetNodeId: "output", targetPinId: "baseColor" },
    );
    let reject!: (error: Error) => void;
    let finish!: () => void;
    const failed = new Promise<void>((_yes, no) => { reject = no; });
    const cancelled = new Promise<void>((yes) => { finish = yes; });
    const leases = new Map<string, number>();
    const f = fixture(document, {
      textureIdentity: (guid) => guid,
      acquireTexture: (guid) => {
        leases.set(guid, (leases.get(guid) ?? 0) + 1);
        let released = false;
        return { key: guid, resource: texture, ready: guid === "failed" ? failed : guid === "cancelled" ? cancelled : Promise.resolve(),
          release: () => { if (!released) { released = true; leases.set(guid, leases.get(guid)! - 1); } } };
      },
    });
    const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, f.scene);
    texture.getInternalTexture()!.isReady = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const working = sceneDocument({ Albedo: { kind: "texture", textureAssetGuid: "working" } });
    f.sync.apply(working);
    await f.sync.whenEditorModelsReady();
    const previous = f.sync.meshForActor("actor")!.material as NodeMaterial;
    const replacement = (guid: string) => sceneDocument({ Albedo: { kind: "texture", textureAssetGuid: guid } });
    f.sync.apply(replacement("failed"));
    const readiness = f.sync.whenEditorModelsReady();
    expect(f.sync.meshForActor("actor")!.material).toBe(previous);
    reject(new Error("Texture admission failed"));
    await expect(readiness).rejects.toThrow("Texture admission failed");
    expect(f.sync.meshForActor("actor")!.material).toBe(previous);
    expect((previous.getBlockByName("sample") as TextureBlock).texture).toBe(texture);
    expect(leases.get("failed")).toBe(0);

    f.sync.apply(replacement("cancelled"));
    const superseded = f.sync.whenEditorModelsReady();
    f.sync.apply(working);
    await superseded;
    finish();
    await f.sync.whenEditorModelsReady();
    expect(f.sync.meshForActor("actor")!.material).toBe(previous);
    expect(leases.get("cancelled")).toBe(0);
    f.sync.apply({ ...working, actors: [] });
    expect(f.scene.materials).not.toContain(previous);
  });
});
