import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Color3,
  InputBlock,
  Material,
  MeshBuilder,
  MultiMaterial,
  NullEngine,
  PBRMaterial,
  PointLight,
  RawTexture,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";
import { normalizeCelShadingSettings } from "@babylonslate/core";
import { CelMaterial } from "./cel-material";
import { compileMaterialPlan } from "./material-compiler";
import { sceneRenderingSettings } from "./render-settings";
import { setSceneRenderSettings } from "./scene-render-mode";
import { isDisposedGpuTexture } from "./gpu-resource-live";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function host() {
  const engine = new NullEngine();
  engines.push(engine);
  return new Scene(engine);
}

describe("native CEL render mode", () => {
  it("adapts imported slots and late meshes, preserving textures, alpha and PBR restoration", () => {
    const scene = host();
    const pbr = new PBRMaterial("imported", scene);
    pbr.albedoColor = new Color3(0.25, 0.5, 0.75);
    pbr.albedoTexture = RawTexture.CreateRGBATexture(
      new Uint8Array([30, 90, 120, 200]),
      1,
      1,
      scene,
    );
    pbr.useAlphaFromAlbedoTexture = true;
    pbr.alpha = 0.7;
    pbr.transparencyMode = Material.MATERIAL_ALPHABLEND;
    pbr.backFaceCulling = false;
    const slots = new MultiMaterial("slots", scene);
    const unlit = new StandardMaterial("sprite", scene);
    unlit.disableLighting = true;
    slots.subMaterials = [pbr, unlit, null];
    const mesh = MeshBuilder.CreateBox("model", {}, scene);
    mesh.material = slots;
    setSceneRenderSettings(scene, { mode: "cel" });
    const celSlots = mesh.material as MultiMaterial;
    const cel = celSlots.subMaterials[0] as CelMaterial;
    expect(cel).toBeInstanceOf(CelMaterial);
    expect(cel).not.toBeInstanceOf(PBRMaterial);
    expect(cel.diffuseTexture).toBe(pbr.albedoTexture);
    expect(cel.useAlphaFromDiffuseTexture).toBe(true);
    expect(cel.alpha).toBe(0.7);
    expect(cel.backFaceCulling).toBe(false);
    expect(celSlots.subMaterials.slice(1)).toEqual([unlit, null]);
    const late = MeshBuilder.CreateBox("late", {}, scene);
    late.material = pbr;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(late.material).toBe(cel);
    setSceneRenderSettings(scene, {
      mode: "pbr",
      cel: normalizeCelShadingSettings({ shadowBands: 8 }),
    });
    expect(mesh.material).toBe(slots);
    expect(late.material).toBe(pbr);
    expect(pbr.albedoColor.asArray()).toEqual([0.25, 0.5, 0.75]);
    expect(isDisposedGpuTexture(pbr.albedoTexture)).toBe(false);
  });

  it("switches authored graphs in place and preserves frozen materials and live parameters", async () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    doc.nodes[0] = {
      ...doc.nodes[0]!,
      type: "param.color",
      properties: { name: "Tint", value: [0.2, 0.6, 0.3, 1] },
    };
    doc.edges[0]!.sourcePinId = "rgb";
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("Invalid fixture");
    const compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: "authored",
    });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    expect(await compiled.ready).toEqual([]);
    const material = compiled.material;
    const mesh = MeshBuilder.CreateBox("actor", {}, scene);
    mesh.material = material;
    for (let i = 0; i < 6; i++)
      new PointLight(`light-${i}`, new Vector3(i, 3, 0), scene);
    material.freeze();
    // First activation loads CEL blocks asynchronously. Rapid switches must
    // settle on the last request rather than lose a build or mix graph roots.
    setSceneRenderSettings(scene, { mode: "cel" });
    setSceneRenderSettings(scene, { mode: "pbr" });
    await vi.waitFor(() =>
      expect(material.compiledShaders).toContain("pbrBlockAlbedoOpacity"),
    );
    setSceneRenderSettings(scene, { mode: "cel" });
    expect(material.maxSimultaneousLights).toBe(6);
    await vi.waitFor(() =>
      expect(material.compiledShaders).toContain("slateCelSurfaceLight"),
    );
    expect(material.compiledShaders).not.toContain("pbrBlockAlbedoOpacity");
    material.freeze();
    expect(
      compiled.setParameter("Tint", {
        kind: "color",
        value: [0.1, 0.4, 0.8, 1],
      }),
    ).toBe(true);
    setSceneRenderSettings(scene, { mode: "pbr" });
    await vi.waitFor(() =>
      expect(material.compiledShaders).toContain("pbrBlockAlbedoOpacity"),
    );
    expect(mesh.material).toBe(material);
    expect(material.isFrozen).toBe(true);
    const tint = material.getBlockByName("baseColor") as InputBlock;
    expect(tint.value.asArray()).toEqual([0.1, 0.4, 0.8, 1]);
    setSceneRenderSettings(scene, { mode: "cel" });
    await vi.waitFor(() =>
      expect(material.compiledShaders).toContain("slateCelSurfaceLight"),
    );
    expect(mesh.material).toBe(material);
    expect(material.isFrozen).toBe(true);
    expect(material.getBlockByName("baseColor")).toBe(tint);
    expect(
      compiled.setParameter("Tint", {
        kind: "color",
        value: [0.8, 0.2, 0.1, 1],
      }),
    ).toBe(true);
    expect(tint.value.asArray()).toEqual([0.8, 0.2, 0.1, 1]);
    compiled.dispose();
    expect(sceneRenderingSettings(scene).listeners.size).toBe(0);
  });

  it("resolves scene overrides without leaking them between scenes or into PBR", () => {
    const a = host();
    const b = host();
    const project = {
      mode: "cel" as const,
      cel: normalizeCelShadingSettings({
        shadowBands: 4,
        specularStrength: 0.3,
      }),
    };
    setSceneRenderSettings(a, project, { shadowBands: 7 });
    setSceneRenderSettings(b, project);
    expect(sceneRenderingSettings(a).cel.shadowBands).toBe(7);
    expect(sceneRenderingSettings(b).cel.shadowBands).toBe(4);
    setSceneRenderSettings(a, {
      ...project,
      cel: { ...project.cel, specularStrength: 0.6 },
    });
    expect(sceneRenderingSettings(a).cel).toMatchObject({
      shadowBands: 7,
      specularStrength: 0.6,
    });
    setSceneRenderSettings(a, undefined, {});
    expect(sceneRenderingSettings(a).cel.shadowBands).toBe(4);
    setSceneRenderSettings(a, { ...project, mode: "pbr" }, { shadowBands: 8 });
    expect(sceneRenderingSettings(a).mode).toBe("pbr");
    expect(sceneRenderingSettings(b).mode).toBe("cel");
  });
});
