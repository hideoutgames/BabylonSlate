/** Test-build-only packed-player fixture: a project carrying a synthetic bake. */
import {
  createDefaultMigrationRegistry,
  encodeAssetDocument,
  bakedGeometryImportResult,
  bakedLightingImportResult,
  encodeBakedGeometryAsset,
  encodeBakedLightingAsset,
  encodeBakeTopology,
  sha256Hex,
} from "@babylonslate/assets";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  MAIN_SCENE_FILE,
  normalizeBakeAuthoringSettings,
  type BakedLightingManifest,
} from "@babylonslate/core";
import {
  createDefaultMaterialDocument,
  normalizeMaterialDocument,
} from "@babylonslate/shader-graph";
import { minimalProjectFiles } from "../../../../packages/assets/src/test-support/minimal-project";
import { createTestEngine } from "../../../../packages/render/src/create-null-engine";
import { EditorSceneSync } from "../../../../packages/render/src/editor-scene-sync";
import { snapshotBakeMesh } from "../../../../packages/render/src/bake-mesh-snapshot";
import { prepareSceneBake } from "../../../../packages/render/src/scene-bake-preparation";

const SCENE_GUID = "00000000-0000-4000-8000-000000000001";
const CLASS_GUID = "00000000-0000-4000-8000-000000000002";
const MATERIAL_GUID = "00000000-0000-4000-8000-000000000010";
const BAKE_GUID = "00000000-0000-4000-8000-000000000011";
const GEOMETRY_GUID = "00000000-0000-4000-8000-000000000012";

/**
 * A project whose Scene references a deterministic synthetic bake: uniform
 * warm physical-E atlas (no path tracing), generated UV2 topology, and a
 * Static point light the receiver excludes when the bake applies. Runs in the
 * test build because hash preparation reads real Babylon vertex data; returns
 * `[path, bytes]` entries the spec seeds into OPFS.
 */
export async function runBakedPlayerFixture(): Promise<
  Array<[string, number[]]>
> {
  const files = await minimalProjectFiles();
  const migrations = createDefaultMigrationRegistry();
  const document = createDefaultScene();
  const mesh = createMeshComponent("mesh", "ground");
  mesh.properties.materialGuid = MATERIAL_GUID;
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
    ...document.actors.filter(
      (actor) => actor.id === document.settings.mainCameraActorId,
    ),
  ];
  document.settings.bakedLightingAssetGuid = BAKE_GUID;
  document.settings.bakeSettings = {
    resolution: 32,
    paddingTexels: 2,
    samples: 1,
    bounces: 2,
  };
  const material = createDefaultMaterialDocument("Flat");
  material.twoSided = true;
  // The packed player normalizes Material payloads; hash the same form.
  const materials = new Map([
    [MATERIAL_GUID, normalizeMaterialDocument(material, "Flat")],
  ]);
  const { engine, scene } = createTestEngine();
  const sync = new EditorSceneSync(scene);
  let bytes: { bake: Uint8Array; geometry: Uint8Array };
  try {
    sync.apply(document);
    const node = sync.meshForComponent("receiver", "mesh")!;
    const prepared = await prepareSceneBake({
      owner: { sceneGuid: SCENE_GUID, generation: 1 },
      current: () => ({ sceneGuid: SCENE_GUID, generation: 1 }),
      document,
      meshForComponent: (actorId, componentId) =>
        sync.meshForComponent(actorId, componentId),
      materials,
      settings: normalizeBakeAuthoringSettings(document.settings.bakeSettings),
    });
    const source = snapshotBakeMesh(node);
    const topology = {
      indices: source.indices.slice(),
      originalVertices: new Uint32Array([0, 1, 2, 3]),
      uv2: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    };
    const contentHash = await sha256Hex(
      encodeBakeTopology(topology, source.vertexCount),
    );
    // Warm diffuse irradiance: realtime white-light shading cannot produce it.
    const atlas = new Uint8Array(2 * 2 * 16);
    const view = new DataView(atlas.buffer);
    for (let texel = 0; texel < 4; texel++) {
      view.setFloat32(texel * 16, 2, true);
      view.setFloat32(texel * 16 + 4, 0.5, true);
      view.setFloat32(texel * 16 + 8, 0.25, true);
      view.setFloat32(texel * 16 + 12, 1, true);
    }
    const receiver = prepared.meshes.find((entry) => entry.receiver)!;
    const manifest: BakedLightingManifest = {
      version: 1,
      sceneGuid: SCENE_GUID,
      inputs: prepared.inputs,
      provider: { id: "spec-fixture", version: "1", adapterVersion: "1" },
      settingsVersion: "1",
      dependencies: [GEOMETRY_GUID],
      sources: prepared.sources,
      receivers: [
        {
          mobility: "static",
          identity: receiver.identity,
          hashes: receiver.hashes,
          generatedGeometry: {
            assetGuid: GEOMETRY_GUID,
            contentHash,
          },
          atlasGuid: "atlas",
          scale: [1, 1],
          offset: [0, 0],
          contributions: [
            {
              sourceId: prepared.sources[0]!.id,
              term: "directAndIndirect",
            },
          ],
        },
      ],
      atlases: [
        {
          guid: "atlas",
          chunkId: "atlas",
          width: 2,
          height: 2,
          sha256: await sha256Hex(atlas),
          encoding: "rgba32float-le",
          colorSpace: "linear",
          quantity: "diffuseIrradiance",
          convention: "physical-E",
          alpha: "coverage",
          rowOrder: "bottomFirst",
          uvSet: 1,
          mipLevels: 1,
          gutterTexels: 0,
        },
      ],
    };
    bytes = {
      geometry: await encodeBakedGeometryAsset(
        await bakedGeometryImportResult({
          guid: GEOMETRY_GUID,
          name: "Geometry",
          topology,
          manifest: {
            version: 1,
            sceneGuid: SCENE_GUID,
            receiver: receiver.identity,
            sourceHash: receiver.hashes.geometry,
            sourceVertexCount: source.vertexCount,
            indexCount: topology.indices.length,
            vertexCount: topology.originalVertices.length,
            contentHash,
            provider: manifest.provider,
            layout: {
              width: 2,
              height: 2,
              paddingTexels: 0,
              uvSet: 1,
              coordinates: "normalized-bottom-first",
              mipLevels: 1,
            },
          },
        }),
      ),
      bake: await encodeBakedLightingAsset(
        await bakedLightingImportResult({
          guid: BAKE_GUID,
          name: "Bake",
          manifest,
          atlases: new Map([["atlas", atlas]]),
        }),
      ),
    };
  } finally {
    sync.dispose();
    scene.dispose();
    engine.dispose();
  }
  files.set(
    MAIN_SCENE_FILE,
    await encodeAssetDocument(
      {
        guid: SCENE_GUID,
        type: "Scene",
        name: "Main",
        version: migrations.currentVersion("Scene"),
        payload: document as unknown as Record<string, unknown>,
      },
      { dependencies: [CLASS_GUID] },
    ),
  );
  files.set(
    "assets/Flat.material.babasset",
    await encodeAssetDocument({
      guid: MATERIAL_GUID,
      type: "Material",
      name: "Flat",
      version: migrations.currentVersion("Material"),
      payload: material as unknown as Record<string, unknown>,
    }),
  );
  files.set(`assets/BakedLighting/${BAKE_GUID}.babasset`, bytes.bake);
  files.set(`assets/BakedGeometry/${GEOMETRY_GUID}.babasset`, bytes.geometry);
  return [...files].map(([path, content]) => [
    path,
    Array.from(content),
  ]);
}
