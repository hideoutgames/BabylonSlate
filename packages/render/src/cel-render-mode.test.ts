import { afterEach, describe, expect, it, vi } from "vitest";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { SphericalPolynomial } from "@babylonjs/core/Maths/sphericalPolynomial";
import { InputBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/inputBlock";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Scene } from "@babylonjs/core/scene";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@haptic/shader-graph";
import {
  normalizeCelShadingSettings,
  normalizeEnvironmentLightingSettings,
} from "@haptic/core";
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

/**
 * `effect`'s fragment source as the GPU's preprocessor leaves it, for the simple conditions (`#ifdef`, `#ifndef`, one
 * `defined()`), without comments. A block under any other condition stays whole, so a check that the source lacks a
 * name cannot pass by leaving one out.
 */
function preprocessed(effect: Effect): string {
  const defined = new Set([...effect.defines.matchAll(/^#define (\w+)/gm)].map((match) => match[1]!));
  const known = (line: string): boolean | null => {
    const match = /^#(ifdef|ifndef) (\w+)$/.exec(line) ?? /^#if (!?)defined\((\w+)\)$/.exec(line);
    if (!match) return null;
    return (match[1] === "ifndef" || match[1] === "!") !== defined.has(match[2]!);
  };
  const stack: { outer: boolean; condition: boolean | null }[] = [];
  let active = true;
  const kept: string[] = [];
  for (const raw of effect.fragmentSourceCode.split("\n")) {
    const line = raw.trim();
    if (/^#if/.test(line)) {
      const condition = known(line);
      stack.push({ outer: active, condition });
      active = active && condition !== false;
    } else if (/^#el/.test(line) && stack.length) {
      const top = stack.at(-1)!;
      // An \`#elif\` is not evaluated: it is taken unless an earlier branch surely was.
      active = top.outer && top.condition !== true;
      if (!line.startsWith("#else")) top.condition = null;
    } else if (/^#endif/.test(line) && stack.length) {
      active = stack.pop()!.outer;
    } else if (active) kept.push(raw.replace(/\/\/.*$/, ""));
  }
  return kept.join("\n");
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

  it("binds the ramp's and the highlight's terms derived from the CEL settings", async () => {
    const scene = host();
    scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
    const cel = {
      shadowBands: 4,
      shadowThreshold: 0.4,
      shadowStrength: 0.7,
      specularStrength: 0.3,
      specularSize: 0.25,
    };
    setSceneRenderSettings(scene, { mode: "cel", cel: normalizeCelShadingSettings(cel) });
    const compiled = await defaultGraph(scene, "graph-bands");
    const material = compiled.material;
    const mesh = MeshBuilder.CreateSphere("sphere", {}, scene);
    mesh.material = material;
    await material.forceCompilationAsync(mesh);
    const subMesh = mesh.subMeshes[0]!;
    expect(material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
    const uniforms = vi.spyOn(subMesh.effect!, "setFloat4");
    const last = (name: string) => uniforms.mock.calls.filter(([uniform]) => uniform === name).at(-1)!.slice(1) as number[];
    const expectClose = (actual: number[], expected: number[]) =>
      expected.forEach((value, index) => expect(actual[index], `${index}`).toBeCloseTo(value, 6));
    material.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
    // Three levels above the darkest; ln 0.5 / ln 0.4; 1 - 0.7; (0.5 / 3) ^ (1 / 0.75647), where the first lit band starts.
    expectClose(last("slateCelBands"), [3, 0.7564708, 0.3, 0.0936138]);
    // Strength; the cosine of the highlight's half angle, sqrt(1 - 0.25²); a rect light's form factor threshold.
    expectClose(last("slateCelSpecular"), [0.3, 0.9682458, 0.75, 0]);
    // Highlights off bind a zero strength, which skips them in the shader.
    setSceneRenderSettings(scene, { mode: "cel", cel: normalizeCelShadingSettings({ ...cel, specularEnabled: false }) });
    material.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh);
    expect(last("slateCelSpecular")[0]).toBe(0);
    compiled.dispose();
  });

  it("compiles neither the PBR lighting nor the samplers it never reads into a CEL program", async () => {
    // The fragment source is the contract here: what a program declares and links is what its source holds once the
    // GPU's preprocessor has resolved it (`preprocessed`).
    const fragment = async (mode: "cel" | "pbr") => {
      const scene = host();
      scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
      setSceneRenderSettings(scene, { mode, cel: normalizeCelShadingSettings({}) });
      const compiled = await defaultGraph(scene, "graph-modes");
      const mesh = MeshBuilder.CreateSphere("sphere", {}, scene);
      mesh.material = compiled.material;
      await compiled.material.forceCompilationAsync(mesh);
      expect(compiled.material.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)).toBe(true);
      const source = preprocessed(mesh.subMeshes[0]!.effect!);
      compiled.dispose();
      return source;
    };
    const pbrOnly = ["hapticDirectLights", "hapticEnvironmentBrdfSampler", "hapticShadowAtlasDepth", "hapticContactLit", "hapticPoisson64"];
    const cel = await fragment("cel");
    expect(cel).toContain("hapticCelLighting");
    for (const name of pbrOnly) expect(cel, name).not.toContain(name);
    const pbr = await fragment("pbr");
    expect(pbr).not.toContain("hapticCelLighting");
    for (const name of pbrOnly) expect(pbr, name).toContain(name);
    // CEL's highlights read the Material's Roughness: the same input the PBR program shades with.
    const roughness = /hapticS\.roughness = clamp\((\w+), 0\.0, 1\.0\);/.exec(pbr)?.[1];
    expect(roughness).toBeTruthy();
    expect(cel).toMatch(new RegExp(`hapticCelLighting\\([^;]*clamp\\(${roughness}, 0\\.0, 1\\.0\\)\\)`));
  });

  it("binds a CEL program's settings once per Scene and frame, and again on a change", async () => {
    const engine = new NullEngine();
    engines.push(engine);
    const a = new Scene(engine);
    const b = new Scene(engine);
    const draw = async (scene: Scene, shadowBands: number) => {
      scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
      setSceneRenderSettings(scene, { mode: "cel", cel: normalizeCelShadingSettings({ shadowBands }) });
      const compiled = await defaultGraph(scene, "graph-shared");
      const mesh = MeshBuilder.CreateSphere("sphere", {}, scene);
      mesh.material = compiled.material;
      await compiled.material.forceCompilationAsync(mesh);
      const subMesh = mesh.subMeshes[0]!;
      expect(compiled.material.isReadyForSubMesh(mesh, subMesh)).toBe(true);
      return { effect: subMesh.effect!, bind: () => compiled.material.bindForSubMesh(mesh.computeWorldMatrix(), mesh, subMesh) };
    };
    const { effect, bind: drawA } = await draw(a, 3);
    const { effect: effectB, bind: drawB } = await draw(b, 6);
    // One program serves both Scenes, each with its own settings.
    expect(effectB).toBe(effect);
    const uniforms = vi.spyOn(effect, "setFloat4");
    const bands = () => uniforms.mock.calls.filter(([name]) => name === "slateCelBands").map(([, levels]) => levels);
    drawA();
    drawA();
    expect(bands()).toEqual([2]);
    // Another Scene drawing the same program in the same frame binds its own, and the first binds its own back.
    drawB();
    drawA();
    expect(bands()).toEqual([2, 5, 2]);
    // A settings change within the frame binds at once.
    setSceneRenderSettings(a, { mode: "cel", cel: normalizeCelShadingSettings({ shadowBands: 4 }) });
    drawA();
    drawA();
    expect(bands()).toEqual([2, 5, 2, 3]);
    // The next frame binds again.
    engine.endFrame();
    drawA();
    expect(bands()).toEqual([2, 5, 2, 3, 3]);
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
