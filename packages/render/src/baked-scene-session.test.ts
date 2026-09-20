import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  type SerializedScene,
} from "@babylonslate/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createBakedLightingFixture } from "@babylonslate/test-kit/baked-lighting-fixtures";
import {
  bakedGeometryImportResult,
  bakedLightingImportResult,
  encodeBakedGeometryAsset,
  encodeBakedLightingAsset,
  encodeBakeTopology,
  sha256Hex,
} from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { prepareSceneBake } from "./scene-bake-preparation";
import {
  BakedSceneSession,
  type BakedSceneHost,
} from "./baked-scene-session";

const disposers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (disposers.length) disposers.pop()!();
});

function engineScene() {
  const { engine, scene } = createTestEngine();
  engine.getCaps().textureHalfFloat = true;
  engine.getCaps().textureHalfFloatLinearFiltering = true;
  // Pinned NullEngine omits the upload completion flag set by both real backends.
  const createRawTexture = engine.createRawTexture.bind(engine);
  vi.spyOn(engine, "createRawTexture").mockImplementation((...args) => {
    const texture = createRawTexture(...args);
    texture.isReady = true;
    return texture;
  });
  disposers.push(() => {
    scene.dispose();
    engine.dispose();
  });
  return { engine, scene };
}

function bakeDocument() {
  const document = createDefaultScene();
  const mesh = createMeshComponent("mesh", "ground");
  mesh.properties.materialGuid = "material-1";
  mesh.properties.bakeParticipation = "staticReceiver";
  document.actors = [
    createActor("receiver", "Ground", { components: [mesh] }),
    createActor("lamp", "Lamp", {
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [
        {
          id: "light",
          classId: "LightComponent",
          properties: { mobility: "static", intensity: 4 },
        },
      ],
    }),
  ];
  document.settings.bakedLightingAssetGuid = "bake";
  document.settings.bakeSettings = {
    resolution: 32,
    paddingTexels: 2,
    samples: 1,
    bounces: 2,
  };
  return document;
}

async function bakeAssetFor(
  document: SerializedScene,
  sync: EditorSceneSync,
  materials: Map<string, ReturnType<typeof createDefaultMaterialDocument>>,
) {
  const owner = { sceneGuid: "scene-1", generation: 1 };
  const prepared = await prepareSceneBake({
    owner,
    current: () => owner,
    document,
    meshForComponent: (actorId, componentId) =>
      sync.meshForComponent(actorId, componentId),
    materials,
    settings: { resolution: 32, paddingTexels: 2, samples: 1, bounces: 2 },
  });
  const { manifest, atlases } = await createBakedLightingFixture(2, 2);
  manifest.sceneGuid = "scene-1";
  manifest.inputs = prepared.inputs;
  manifest.sources = prepared.sources;
  manifest.dependencies = ["geometry"];
  const receiver = manifest.receivers[0]!;
  receiver.identity = prepared.meshes[0]!.identity;
  receiver.hashes = prepared.meshes[0]!.hashes;
  receiver.contributions = [
    { sourceId: prepared.sources[0]!.id, term: "directAndIndirect" },
  ];
  // The bake job ships generated UV2 topology; receivers keep authored geometry.
  const topology = {
    indices: new Uint32Array([3, 1, 0, 2, 3, 0]),
    originalVertices: new Uint32Array([0, 1, 2, 3]),
    uv2: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  };
  const contentHash = await sha256Hex(encodeBakeTopology(topology, 4));
  receiver.generatedGeometry = { assetGuid: "geometry", contentHash };
  const geometryBytes = await encodeBakedGeometryAsset(
    await bakedGeometryImportResult({
      guid: "geometry",
      name: "Geometry",
      topology,
      manifest: {
        version: 1,
        sceneGuid: "scene-1",
        receiver: receiver.identity,
        sourceHash: receiver.hashes.geometry,
        sourceVertexCount: 4,
        indexCount: 6,
        vertexCount: 4,
        contentHash,
        provider: { id: "fixture", version: "1", adapterVersion: "1" },
        layout: {
          width: 32,
          height: 32,
          paddingTexels: 2,
          uvSet: 1,
          coordinates: "normalized-bottom-first",
          mipLevels: 1,
        },
      },
    }),
  );
  const bytes = await encodeBakedLightingAsset(
    await bakedLightingImportResult({
      guid: "bake",
      name: "Bake",
      manifest,
      atlases,
    }),
  );
  return new Map([
    ["bake", bytes],
    ["geometry", geometryBytes],
  ]);
}

async function fixture() {
  const { engine, scene } = engineScene();
  const sync = new EditorSceneSync(scene);
  disposers.push(() => sync.dispose());
  const document = bakeDocument();
  const material = createDefaultMaterialDocument();
  // The bake Material closure admits only opaque two-sided PBR surfaces.
  material.twoSided = true;
  const materials = new Map([["material-1", material]]);
  sync.apply(document);
  const payloads = await bakeAssetFor(document, sync, materials);
  const host: BakedSceneHost = {
    sceneAssetGuid: "scene-1",
    readAsset: async (guid) => {
      const bytes = payloads.get(guid);
      return bytes ? { bytes } : undefined;
    },
    materials,
    meshForComponent: (actorId, componentId) =>
      sync.meshForComponent(actorId, componentId),
    lightForComponent: (actorId) =>
      scene.getLightByName(`authoredLight:${actorId}`),
    isCurrent: () => true,
  };
  return { engine, scene, sync, document, host };
}

async function waitForState(
  session: BakedSceneSession,
  state: "applied" | "stale",
) {
  await vi.waitFor(
    () => {
      expect(session.sessionState).toBe(state);
    },
    { timeout: 5000, interval: 10 },
  );
}

describe("per-Scene baked lighting session", () => {
  it("stays idle without an assigned bake or an asset reader", () => {
    const { scene } = engineScene();
    const session = new BakedSceneSession(scene);
    disposers.push(() => session.dispose());
    const document = bakeDocument();
    session.apply(document, null);
    expect(session.sessionState).toBe("idle");
    const withoutBake = structuredClone(document);
    withoutBake.settings.bakedLightingAssetGuid = null;
    session.apply(withoutBake, null);
    expect(session.sessionState).toBe("idle");
  });

  it("gates first-frame admission until the bake applies receiver materials and light exclusions", async () => {
    const { scene, document, sync, host } = await fixture();
    const session = new BakedSceneSession(scene);
    disposers.push(() => session.dispose());
    const mesh = sync.meshForComponent("receiver", "mesh")!;
    const original = mesh.material;
    const light = scene.getLightByName("authoredLight:lamp")!;
    const baselineReady = scene.isReady();
    session.apply(document, host);
    expect(session.sessionState).toBe("pending");
    expect(scene.isReady()).toBe(false);
    await waitForState(session, "applied");
    expect(session.bakedLighting.bindingFor(mesh)).toBeTruthy();
    expect(mesh.material).not.toBe(original);
    expect(mesh.material!.name.startsWith("baked:")).toBe(true);
    expect(light.excludedMeshes).toContain(mesh);
    expect(scene.isReady()).toBe(baselineReady);
  });

  it("waits for unrealized receivers instead of admitting realtime lighting", async () => {
    const { document, host } = await fixture();
    const { scene } = engineScene();
    const sync = new EditorSceneSync(scene);
    disposers.push(() => sync.dispose());
    const freshHost: BakedSceneHost = {
      ...host,
      meshForComponent: (actorId, componentId) =>
        sync.meshForComponent(actorId, componentId),
      lightForComponent: (actorId) =>
        scene.getLightByName(`authoredLight:${actorId}`),
    };
    const session = new BakedSceneSession(scene);
    disposers.push(() => session.dispose());
    session.apply(document, freshHost);
    expect(session.sessionState).toBe("pending");
    expect(scene.isReady()).toBe(false);
    sync.apply(document);
    expect(scene.isReady()).toBe(false);
    await waitForState(session, "applied");
    const mesh = sync.meshForComponent("receiver", "mesh")!;
    expect(session.bakedLighting.bindingFor(mesh)).toBeTruthy();
    expect(
      scene.getLightByName("authoredLight:lamp")!.excludedMeshes,
    ).toContain(mesh);
  });

  it("releases materials, exclusions and atlas references when superseded", async () => {
    const { scene, document, sync, host } = await fixture();
    const session = new BakedSceneSession(scene);
    disposers.push(() => session.dispose());
    const mesh = sync.meshForComponent("receiver", "mesh")!;
    const original = mesh.material;
    const light = scene.getLightByName("authoredLight:lamp")!;
    session.apply(document, host);
    await waitForState(session, "applied");
    const variant = mesh.material!;
    const next = structuredClone(document);
    next.settings.bakedLightingAssetGuid = null;
    session.apply(next, host);
    expect(session.sessionState).toBe("idle");
    expect(mesh.material).toBe(original);
    expect(light.excludedMeshes).not.toContain(mesh);
    expect(scene.materials).not.toContain(variant);
    expect(session.bakedLighting.bindingFor(mesh)).toBeUndefined();
  });

  it("marks a missing bake asset stale and re-admits realtime lighting", async () => {
    const { scene, document, sync, host } = await fixture();
    const session = new BakedSceneSession(scene);
    disposers.push(() => session.dispose());
    const mesh = sync.meshForComponent("receiver", "mesh")!;
    const original = mesh.material;
    const baselineReady = scene.isReady();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    session.apply(document, { ...host, readAsset: async () => undefined });
    await waitForState(session, "stale");
    expect(session.staleReason).toBeTruthy();
    expect(mesh.material).toBe(original);
    expect(scene.isReady()).toBe(baselineReady);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[render]"));
  });

  it("marks a rejected bake read stale and renders the scene unbaked", async () => {
    const { scene, document, sync, host } = await fixture();
    const session = new BakedSceneSession(scene);
    disposers.push(() => session.dispose());
    const mesh = sync.meshForComponent("receiver", "mesh")!;
    const original = mesh.material;
    const baselineReady = scene.isReady();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    session.apply(document, {
      ...host,
      readAsset: async () => {
        throw new Error("packed payload missing");
      },
    });
    await waitForState(session, "stale");
    expect(session.staleReason).toBeTruthy();
    expect(mesh.material).toBe(original);
    expect(scene.isReady()).toBe(baselineReady);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[render]"));
  });

  it("fails stale within the pending budget when receivers never realize", async () => {
    const { document, host } = await fixture();
    const { scene } = engineScene();
    const sync = new EditorSceneSync(scene);
    disposers.push(() => sync.dispose());
    const freshHost: BakedSceneHost = {
      ...host,
      meshForComponent: (actorId, componentId) =>
        sync.meshForComponent(actorId, componentId),
      lightForComponent: (actorId) =>
        scene.getLightByName(`authoredLight:${actorId}`),
    };
    const session = new BakedSceneSession(scene, undefined, 50);
    disposers.push(() => session.dispose());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The document is never applied, so the receiver mesh never exists.
    session.apply(document, freshHost);
    expect(session.sessionState).toBe("pending");
    expect(scene.isReady()).toBe(false);
    // The stale transition is driven by the readiness probe; poll isReady.
    await vi.waitFor(
      () => {
        expect(scene.isReady()).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );
    expect(session.sessionState).toBe("stale");
    expect(session.staleReason).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[render]"));
  });

  it("restores realtime lighting when the session is disposed mid-flight", async () => {
    const { scene, document, sync, host } = await fixture();
    const session = new BakedSceneSession(scene);
    const mesh = sync.meshForComponent("receiver", "mesh")!;
    const original = mesh.material;
    const baselineReady = scene.isReady();
    session.apply(document, host);
    await waitForState(session, "applied");
    session.dispose();
    expect(mesh.material).toBe(original);
    expect(scene.isReady()).toBe(baselineReady);
  });
});
