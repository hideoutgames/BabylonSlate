import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Matrix,
  SphericalPolynomial,
  InputBlock,
  MeshBuilder,
  NullEngine,
  PointLight,
  Scene,
  Vector3,
} from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@haptic/shader-graph";
import {
  normalizeCelShadingSettings,
  normalizeEnvironmentLightingSettings,
} from "@haptic/core";
import { celFunctions } from "./cel-shader";
import { compileMaterialPlan } from "./material-compiler";
import { HapticLightingBlock } from "./haptic-lighting-block";
import { sceneRenderingSettings } from "./render-settings";
import { setSceneRenderSettings } from "./scene-render-mode";
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

/** The default Material compiled in `scene`. */
async function defaultGraph(scene: Scene, name: string) {
  const lowered = lowerMaterialDocument(createDefaultMaterialDocument());
  if (!lowered.ok) throw new Error("Invalid fixture");
  const compiled = compileMaterialPlan(lowered.plan, { scene, name });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(await compiled.ready).toEqual([]);
  return compiled;
}

describe("CEL render mode", () => {
  it("binds opted-in diffuse irradiance for a frozen CEL graph without changing the default contribution", async () => {
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
    const compiled = await defaultGraph(scene, "graph-environment");
    const material = compiled.material;
    const mesh = MeshBuilder.CreateBox(material.name, {}, scene);
    mesh.material = material;
    await material.forceCompilationAsync(mesh);
    const subMesh = mesh.subMeshes[0]!;
    expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
    const uniforms = vi.spyOn(subMesh.effect!, "setFloat4");
    material.freeze();
    setSceneRenderSettings(scene, settings);
    material.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
    expect(uniforms.mock.calls.filter(([name]) => name === "slateCelEnvironment").at(-1)).toEqual(["slateCelEnvironment", 0, 0, 0, 0]);
    setSceneRenderSettings(scene, { ...settings, environmentLighting: { ...settings.environmentLighting, celStrength: 0.5 } });
    material.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
    expect(uniforms.mock.calls.filter(([name]) => name === "slateCelEnvironment").at(-1)).toEqual(["slateCelEnvironment", 2, 0, 0, 0]);
    expect(uniforms.mock.calls.filter(([name]) => name === "slateCelIrradiance_yy").at(-1)).toEqual(["slateCelIrradiance_yy", 0.2, 0.7, 0.4, 0]);
    expect(material.isFrozen).toBe(true);
    compiled.dispose();
  });

  it("binds only hard-step uniforms and the CEL functions contain no smoothstep", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
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
    const compiled = await defaultGraph(scene, "graph-bands");
    const material = compiled.material;
    const mesh = MeshBuilder.CreateSphere("sphere", {}, scene);
    mesh.material = material;
    await material.forceCompilationAsync(mesh);
    const subMesh = mesh.subMeshes[0]!;
    expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
    const uniforms = vi.spyOn(subMesh.effect!, "setFloat4");
    material.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
    expect(
      uniforms.mock.calls.filter(([name]) => name === "slateCelBands").at(-1),
    ).toEqual(["slateCelBands", 4, 0.4, 0.7, 0]);
    expect(
      uniforms.mock.calls.filter(([name]) => name === "slateCelSpecular").at(-1),
    ).toEqual(["slateCelSpecular", 0.3, 0.25, 0, 0]);
    for (const wgsl of [false, true])
      expect(celFunctions(wgsl)).not.toContain("smoothstep");
    compiled.dispose();
  });

  it("fogs a CEL graph by the one rule, in linear as a PBR graph", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    scene.fogMode = Scene.FOGMODE_LINEAR;
    setSceneRenderSettings(scene, { mode: "cel", cel: normalizeCelShadingSettings({}) });
    const compiled = await defaultGraph(scene, "graph-fog");
    const material = compiled.material;
    expect(material.compiledShaders).toContain("return toLinearSpace(CalcFogFactor(viewPosition, sceneFogInfo));");
    // CEL is a define of the lit graph, whose colour is linear: it fogs toward the linear fog colour, as PBR does.
    expect(material.compiledShaders).toMatch(/= fogKeep\w* \* \w+\.rgb \+ \(1\.0 - fogKeep\w*\) \* sceneFogColor\.rgb;/);
    expect(material.compiledShaders).not.toMatch(/toGammaSpace\(fogKeep/);
    const mesh = MeshBuilder.CreateSphere("sphere", {}, scene);
    mesh.material = material;
    await material.forceCompilationAsync(mesh);
    const subMesh = mesh.subMeshes[0]!;
    expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
    expect(subMesh.effect!.defines).toMatch(/^#define FOG$/m);
    expect(subMesh.effect!.defines).toMatch(/^#define HAPTIC_CEL$/m);
    compiled.dispose();
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
    const blocks = material.attachedBlocks.slice();
    expect(blocks.some((block) => block instanceof HapticLightingBlock)).toBe(true);
    // Whether the Effect the mesh draws with once ready is CEL's, after a render-mode change re-prepared its defines.
    const drawsCel = async () => {
      scene.incrementRenderId();
      await material.forceCompilationAsync(mesh);
      await vi.waitFor(() => expect(material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true));
      return /^#define HAPTIC_CEL$/m.test(mesh.subMeshes[0]!.effect!.defines);
    };
    expect(await drawsCel()).toBe(false);
    material.freeze();
    // Rapid switches settle on the last request.
    setSceneRenderSettings(scene, { mode: "cel" });
    setSceneRenderSettings(scene, { mode: "pbr" });
    expect(await drawsCel()).toBe(false);
    setSceneRenderSettings(scene, { mode: "cel" });
    expect(await drawsCel()).toBe(true);
    expect(
      compiled.setParameter("Tint", {
        kind: "color",
        value: [0.1, 0.4, 0.8, 1],
      }),
    ).toBe(true);
    setSceneRenderSettings(scene, { mode: "pbr" });
    expect(await drawsCel()).toBe(false);
    expect(mesh.material).toBe(material);
    expect(material.isFrozen).toBe(true);
    const tint = material.getBlockByName("baseColor") as InputBlock;
    expect(tint.value.asArray()).toEqual([0.1, 0.4, 0.8, 1]);
    setSceneRenderSettings(scene, { mode: "cel" });
    expect(await drawsCel()).toBe(true);
    // One graph draws both modes: no block was swapped.
    expect(material.attachedBlocks).toEqual(blocks);
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
