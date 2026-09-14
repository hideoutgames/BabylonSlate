import { afterEach, expect, it, vi } from "vitest";
import { Matrix, MeshBuilder, NullEngine, Scene } from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  createDefaultMaterialFunctionDocument,
  lowerMaterialDocument,
  type MaterialDocument,
} from "@babylonslate/shader-graph";
import { normalizeEnvironmentLightingSettings } from "@babylonslate/core";
import { buildFloatDdsCubeFixture } from "@babylonslate/test-kit/environment-fixtures";
import { compileMaterialPlan } from "./material-compiler";
import { EnvironmentSampleBlock } from "./environment-sample-block";
import { ResourceCache } from "./resource-cache";
import { applyEnvironmentLighting } from "./environment-lighting";
import { setSceneRenderSettings } from "./scene-render-mode";

const dispose: Array<() => void> = [];
afterEach(() => {
  while (dispose.length) dispose.pop()!();
  vi.restoreAllMocks();
});

function host() {
  const engine = new NullEngine();
  engine.getCaps().textureLOD = true;
  const scene = new Scene(engine);
  const cache = new ResourceCache();
  const upload = vi
    .spyOn(engine, "createPrefilteredCubeTexture")
    .mockImplementation((url) => {
      const texture = engine.createTexture(url, false, false, null);
      texture.isCube = true;
      return texture;
    });
  const assets = {
    resourceCache: cache,
    textureBytes: new Map([["cube", buildFloatDdsCubeFixture()]]),
  };
  setSceneRenderSettings(scene, {
    environmentLighting: normalizeEnvironmentLightingSettings({
      enabled: false,
      intensity: 4,
    }),
  });
  applyEnvironmentLighting(scene, "cube", assets);
  dispose.push(() => {
    scene.dispose();
    cache.dispose();
    engine.dispose();
  });
  return { engine, scene, cache, upload, assets };
}

function sampleDocument(): MaterialDocument {
  const doc = createDefaultMaterialDocument();
  doc.shadingModel = "unlit";
  doc.nodes.push({
    id: "sample",
    type: "input.environmentSample",
    position: { x: 0, y: 0 },
    properties: {},
  });
  doc.edges = [
    {
      id: "sample-output",
      sourceNodeId: "sample",
      sourcePinId: "color",
      targetNodeId: "output",
      targetPinId: "baseColor",
    },
  ];
  return doc;
}

it("leases the scene cube only for a compiled raw consumer, preserves bindings across rebuild and releases the last consumer", async () => {
  const { scene, cache, upload } = host();
  expect(upload).not.toHaveBeenCalled();
  const lowered = lowerMaterialDocument(sampleDocument());
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const compiled = compileMaterialPlan(lowered.plan, {
    scene,
    name: "raw-environment",
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(await compiled.ready).toEqual([]);
  const view = scene.environmentTexture!;
  const sample = compiled.material.attachedBlocks.find(
    (block) => block instanceof EnvironmentSampleBlock,
  )!;
  expect(sample.environmentTexture).toBe(view);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(scene.iblIntensity).toBe(0);
  scene.setTransformMatrix(Matrix.Identity(), Matrix.Identity());
  const mesh = MeshBuilder.CreateBox("consumer", {}, scene);
  mesh.material = compiled.material;
  await compiled.material.forceCompilationAsync(mesh);
  const effect = mesh.subMeshes[0]!.effect!;
  const textures = vi.spyOn(effect, "setTexture");
  compiled.material.bindForSubMesh(
    mesh.computeWorldMatrix(),
    mesh,
    mesh.subMeshes[0]!,
  );
  expect(textures.mock.calls.some(([, texture]) => texture === view)).toBe(
    true,
  );
  compiled.material.build();
  expect(scene.environmentTexture).toBe(view);
  expect(upload).toHaveBeenCalledTimes(1);
  compiled.dispose();
  expect(scene.environmentTexture).toBeNull();
  cache.flushUnreferenced();
  expect(view.getInternalTexture()).toBeNull();
  expect(cache.accountedBytes()).toBe(0);
});

it("rejects unsupported explicit mip sampling before acquiring any cube", () => {
  const { engine, scene, upload } = host();
  engine.getCaps().textureLOD = false;
  const lowered = lowerMaterialDocument(sampleDocument());
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const result = compileMaterialPlan(lowered.plan, {
    scene,
    name: "unsupported",
  });
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "material.capability", nodeId: "sample" }),
  );
  expect(upload).not.toHaveBeenCalled();
  expect(scene.environmentTexture).toBeNull();
});

it("inherits Environment Sample resource and fragment restrictions through a Material Function", async () => {
  const { scene, upload, cache } = host();
  const fn = createDefaultMaterialFunctionDocument("Raw Environment");
  fn.inputs = [];
  fn.nodes.push({
    id: "sample",
    type: "input.environmentSample",
    position: { x: 0, y: 0 },
    properties: {},
  });
  fn.edges = [
    {
      id: "sample-output",
      sourceNodeId: "sample",
      sourcePinId: "color",
      targetNodeId: "outputs",
      targetPinId: "out_value",
    },
  ];
  const doc = createDefaultMaterialDocument();
  doc.shadingModel = "unlit";
  doc.nodes.push({
    id: "call",
    type: "function.call",
    position: { x: 0, y: 0 },
    properties: { functionGuid: "environment" },
  });
  doc.edges = [
    {
      id: "call-output",
      sourceNodeId: "call",
      sourcePinId: "out_value",
      targetNodeId: "output",
      targetPinId: "baseColor",
    },
  ];
  const functions = { environment: fn };
  const lowered = lowerMaterialDocument(doc, { functions });
  if (!lowered.ok) throw new Error(JSON.stringify(lowered.diagnostics));
  const result = compileMaterialPlan(lowered.plan, {
    scene,
    name: "nested-raw",
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  expect(await result.ready).toEqual([]);
  expect(upload).toHaveBeenCalledTimes(1);
  result.dispose();
  cache.flushUnreferenced();
  expect(cache.accountedBytes()).toBe(0);
  doc.edges[0]!.targetPinId = "worldPositionOffset";
  const vertex = lowerMaterialDocument(doc, { functions });
  expect(vertex.ok).toBe(false);
  expect(
    vertex.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
  ).toBe(true);
});
