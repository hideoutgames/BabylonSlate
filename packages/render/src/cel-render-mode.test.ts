import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Color3,
  Matrix,
  SphericalPolynomial,
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
} from "@haptic/shader-graph";
import { normalizeCelShadingSettings, normalizeEnvironmentLightingSettings } from "@haptic/core";
import { CelMaterial, celSourceReflectivity } from "./cel-material";
import { celFunctions } from "./cel-shader";
import { compileMaterialPlan } from "./material-compiler";
import { sceneRenderingSettings } from "./render-settings";
import { onSceneReadinessDirty } from "./scene-perf";
import { setSceneRenderSettings } from "./scene-render-mode";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { ResourceCache } from "./resource-cache";
import { applyEnvironmentLighting } from "./environment-lighting";
import { buildFloatDdsCubeFixture } from "@haptic/test-kit/environment-fixtures";

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
  it("binds opted-in diffuse irradiance for frozen native and graph CEL without changing the default contribution", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    const engine = scene.getEngine();
    const cache = new ResourceCache();
    scene.onDisposeObservable.addOnce(() => cache.dispose());
    const polynomial = new SphericalPolynomial();
    polynomial.yy.set(0.2, 0.7, 0.4);
    vi.spyOn(engine, "createPrefilteredCubeTexture").mockImplementation((url) => {
      const internal = engine.createTexture(url, false, false, null);
      internal.isCube = true;
      internal._sphericalPolynomial = polynomial;
      return internal;
    });
    const settings = { mode: "cel" as const, environmentLighting: normalizeEnvironmentLightingSettings({ intensity: 4 }) };
    setSceneRenderSettings(scene, settings);
    applyEnvironmentLighting(scene, "environment", { resourceCache: cache, textureBytes: new Map([["environment", buildFloatDdsCubeFixture()]]) });
    const source = new PBRMaterial("source", scene);
    const native = new CelMaterial(source, scene);
    const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
    if (!lowered.ok) throw new Error("Invalid fixture");
    const compiled = compileMaterialPlan(lowered.plan, { scene, name: "graph-environment" });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    expect(await compiled.ready).toEqual([]);
    for (const material of [native, compiled.material]) {
      const mesh = MeshBuilder.CreateBox(material.name, {}, scene);
      mesh.material = material;
      await material.forceCompilationAsync(mesh);
      const subMesh = mesh.subMeshes[0]!;
      expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
      const effect = subMesh.effect!;
      const uniforms = vi.spyOn(effect, "setFloat4");
      material.freeze();
      setSceneRenderSettings(scene, settings);
      material.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
      expect(uniforms.mock.calls.filter(([name]) => name === "slateCelEnvironment").at(-1)).toEqual(["slateCelEnvironment", 0, 0, 0, 0]);
      setSceneRenderSettings(scene, { ...settings, environmentLighting: { ...settings.environmentLighting, celStrength: 0.5 } });
      material.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
      expect(uniforms.mock.calls.filter(([name]) => name === "slateCelEnvironment").at(-1)).toEqual(["slateCelEnvironment", 2, 0, 0, 0]);
      expect(uniforms.mock.calls.filter(([name]) => name === "slateCelIrradiance_yy").at(-1)).toEqual(["slateCelIrradiance_yy", 0.2, 0.7, 0.4, 0]);
      expect(material.isFrozen).toBe(true);
      uniforms.mockRestore();
    }
    compiled.dispose();
  });
  it("binds only hard-step uniforms and the CEL functions contain no smoothstep", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    const native = new CelMaterial(new PBRMaterial("source", scene), scene);
    const mesh = MeshBuilder.CreateSphere("sphere", {}, scene);
    mesh.material = native;
    setSceneRenderSettings(scene, {
      mode: "cel",
      cel: normalizeCelShadingSettings({
        shadowBands: 4,
        shadowThreshold: 0.4,
        shadowStrength: 0.7,
        specularStrength: 0.3,
        specularSize: 0.25,
      }),
    });
    await native.forceCompilationAsync(mesh);
    const subMesh = mesh.subMeshes[0]!;
    expect(native.isReadyForSubMesh(mesh, subMesh)).toBe(true);
    const uniforms = vi.spyOn(subMesh.effect!, "setFloat4");
    native.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
    expect(
      uniforms.mock.calls.filter(([name]) => name === "slateCelBands").at(-1),
    ).toEqual(["slateCelBands", 4, 0.4, 0.7, 0]);
    expect(
      uniforms.mock.calls.filter(([name]) => name === "slateCelSpecular").at(-1),
    ).toEqual(["slateCelSpecular", 0.3, 0.25, 0, 0]);
    for (const wgsl of [false, true])
      expect(celFunctions(wgsl)).not.toContain("smoothstep");
  });

  it("reflects a native source as PBR draws it, never where a texture it cannot read decides", () => {
    const scene = host();
    const metal = new PBRMaterial("metal", scene);
    metal.metallic = 1;
    metal.roughness = 0.25;
    const textured = new PBRMaterial("textured", scene);
    textured.metallic = 1;
    textured.roughness = 1;
    textured.metallicTexture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene);
    const glossy = new PBRMaterial("glossy", scene);
    glossy.reflectivityColor = new Color3(0.5, 0.25, 0);
    glossy.microSurface = 0.75;
    const standard = new StandardMaterial("standard", scene);
    standard.specularColor = new Color3(0.5, 1, 0);
    const cases: [PBRMaterial | StandardMaterial, boolean, number[]][] = [
      // F0 0.04 for non-metals, metalness and glossiness 1 - roughness.
      [metal, false, [0.04, 0.04, 0.04, 1, 0.75]],
      [metal, true, [0, 0, 0, 0, 0]],
      // Metalness from an unread texture stays non-metal: 0.04 is below the reflectivity threshold.
      [textured, false, [0.04, 0.04, 0.04, 0, 0]],
      [glossy, false, [0.5, 0.25, 0, 0, 0.75]],
      // Standard reflectivity is the linear specular color at full gloss.
      [standard, false, [0.2176, 1, 0, 0, 1]],
    ];
    for (const [source, unlit, expected] of cases) {
      const values = celSourceReflectivity(source, unlit);
      expected.forEach((value, index) => expect(values[index]).toBeCloseTo(value, 3));
    }
    standard.specularTexture = textured.metallicTexture;
    expect(celSourceReflectivity(standard, false)).toEqual([0, 0, 0, 0, 0]);
  });

  it("binds the source's reflectivity for the geometry pass and none once the source is unlit", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    const source = new PBRMaterial("source", scene);
    source.metallic = 1;
    source.roughness = 0.5;
    const native = new CelMaterial(source, scene);
    const mesh = MeshBuilder.CreateSphere("sphere", {}, scene);
    mesh.material = native;
    setSceneRenderSettings(scene, { mode: "cel" });
    await native.forceCompilationAsync(mesh);
    const subMesh = mesh.subMeshes[0]!;
    expect(native.isReadyForSubMesh(mesh, subMesh)).toBe(true);
    const uniforms = vi.spyOn(subMesh.effect!, "setFloat4");
    const bound = (name: string) => uniforms.mock.calls.filter(([uniform]) => uniform === name).at(-1)?.slice(1);
    native.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
    expect(bound("slateCelReflectivity")).toEqual([0.04, 0.04, 0.04, 1]);
    expect(bound("slateCelTextures")?.[3]).toBe(0.5);
    source.unlit = true;
    native.syncSource();
    native.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
    expect(bound("slateCelReflectivity")).toEqual([0, 0, 0, 0]);
  });

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

  it("stays idle on unchanged frames: no readiness invalidation or material churn", () => {
    const scene = host();
    const pbr = new PBRMaterial("imported", scene);
    const mesh = MeshBuilder.CreateBox("model", {}, scene);
    mesh.material = pbr;
    setSceneRenderSettings(scene, { mode: "cel" });
    const cel = mesh.material;
    expect(cel).toBeInstanceOf(CelMaterial);
    // The CEL sync is event-driven: clean frames must not re-resolve materials,
    // invalidate the strict readiness cache, or churn mesh.material.
    let marks = 0;
    const off = onSceneReadinessDirty(scene, () => {
      marks += 1;
    });
    for (let frame = 0; frame < 20; frame += 1) {
      scene.onBeforeRenderObservable.notifyObservers(scene);
      expect(mesh.material).toBe(cel);
    }
    expect(marks).toBe(0);
    off();
  });

  it("replaces the material of a mesh added while CEL is active exactly once", () => {
    const scene = host();
    const pbr = new PBRMaterial("imported", scene);
    setSceneRenderSettings(scene, { mode: "cel" });
    const mesh = MeshBuilder.CreateBox("late", {}, scene);
    const assigned = vi.spyOn(mesh, "material", "set");
    mesh.material = pbr;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    const cel = mesh.material;
    expect(cel).toBeInstanceOf(CelMaterial);
    // The explicit assignment plus exactly one CEL replacement; scene-lighting
    // separately invalidates readiness for the new material's light defines.
    expect(assigned).toHaveBeenCalledTimes(2);
    for (let frame = 0; frame < 5; frame += 1)
      scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(assigned).toHaveBeenCalledTimes(2);
    expect(mesh.material).toBe(cel);
    assigned.mockRestore();
  });

  it("replaces and restores materials once per PBR ⇄ CEL switch", () => {
    const scene = host();
    const pbr = new PBRMaterial("imported", scene);
    const mesh = MeshBuilder.CreateBox("model", {}, scene);
    mesh.material = pbr;
    const assigned = vi.spyOn(mesh, "material", "set");
    setSceneRenderSettings(scene, { mode: "cel" });
    expect(assigned).toHaveBeenCalledTimes(1);
    const cel = mesh.material;
    expect(cel).toBeInstanceOf(CelMaterial);
    setSceneRenderSettings(scene, { mode: "pbr" });
    expect(assigned).toHaveBeenCalledTimes(2);
    expect(mesh.material).toBe(pbr);
    // The owned replacement is reused rather than rebuilt.
    setSceneRenderSettings(scene, { mode: "cel" });
    expect(assigned).toHaveBeenCalledTimes(3);
    expect(mesh.material).toBe(cel);
    assigned.mockRestore();
  });

  it("replaces a material assigned after CEL was applied on the next frame", () => {
    const scene = host();
    const first = new PBRMaterial("first", scene);
    const other = new PBRMaterial("other", scene);
    const mesh = MeshBuilder.CreateBox("model", {}, scene);
    mesh.material = first;
    setSceneRenderSettings(scene, { mode: "cel" });
    expect(mesh.material).toBeInstanceOf(CelMaterial);
    mesh.material = other;
    scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(mesh.material).toBeInstanceOf(CelMaterial);
    expect(mesh.material).not.toBe(other);
    for (let frame = 0; frame < 5; frame += 1)
      scene.onBeforeRenderObservable.notifyObservers(scene);
    expect(mesh.material).not.toBe(other);
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
    // NullEngine's non-UBO path admits four conventional lights.
    expect(material.maxSimultaneousLights).toBe(4);
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
