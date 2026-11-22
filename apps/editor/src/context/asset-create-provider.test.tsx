import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  AssetRegistry,
  projectContentRoot,
} from "@haptic/assets";
import { encodeHasset } from "@haptic/assets/hasset";
import { useAssetCreate, type AssetCreateApi } from "@haptic/editor-kit";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { AssetCreateDocumentsProvider } from "./asset-create-provider";
import { dataGraphAssetCreateOptions } from "../lib/data-graph";

const docs = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("./document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => docs.value));

afterEach(() => {
  cleanup();
});

async function projectRegistry(): Promise<AssetRegistry> {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("test.hproject");
  await storage.mkdir("assets/Levels", true);
  const bytes = await encodeHasset({
    header: {
      dependencyMetadataVersion: 1, requiredDependencies: [],
      guid: "scene-main",
      type: "Scene",
      name: "Main",
      engineVersion: "0.0.0",
      version: 1,
      mode: "thin",
      dependencies: [],
      parentClass: null,
      payload: {},
    },
    chunks: [],
  });
  await storage.writeBinary("assets/Levels/Main.scene.hasset", bytes);
  const registry = new AssetRegistry(storage);
  await registry.mountRoot(projectContentRoot());
  return registry;
}

function renderApi(): AssetCreateApi | null {
  let api: AssetCreateApi | null = null;
  function Probe() {
    api = useAssetCreate();
    return null;
  }
  render(
    <AssetCreateDocumentsProvider>
      <Probe />
    </AssetCreateDocumentsProvider>,
  );
  return api;
}

describe("AssetCreateDocumentsProvider", () => {
  it("seeds a new curve asset with the requested curve", async () => {
    const registry = await projectRegistry();
    docs.value = {
      assetRegistry: registry,
      noteAssetsCreated: vi.fn(),
      refreshAssetRegistry: vi.fn(),
      activeDocumentId: null,
      openDocuments: [],
    };
    const api = renderApi()!;
    // Create Curve From on a Sound Attenuation: the built-in falloff's keys.
    const falloff = {
      Keys: [
        { Time: 0, Value: 1, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 },
        { Time: 1, Value: 0, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 },
      ],
      Before: "constant",
      After: "constant",
    };
    const curve = await api.createAsset({ type: "FloatCurve", name: "Near Falloff", curve: falloff, ownerPath: "assets/Levels/Near.atten.hasset" });
    expect(registry.getByGuid(curve)).toMatchObject({ path: "assets/Levels/Near_Falloff.floatcurve.hasset", header: { payload: { curve: falloff } } });
  });

  it("creates beside the owner (default: the active document) and refreshes before resolving", async () => {
    const registry = await projectRegistry();
    let listedAtRefresh = false;
    const noteAssetsCreated = vi.fn(() => {
      listedAtRefresh = registry
        .list()
        .some((asset) => asset.path === "assets/Levels/Rock.material.hasset");
    });
    const refreshAssetRegistry = vi.fn();
    docs.value = {
      assetRegistry: registry,
      noteAssetsCreated,
      refreshAssetRegistry,
      activeDocumentId: "scene:main",
      openDocuments: [
        {
          id: "scene:main",
          ref: { kind: "scene", path: "assets/Levels/Main.scene.hasset" },
          content: null,
        },
      ],
    };
    const api = renderApi()!;

    expect(api.canCreate("RenderTarget")).toBe(true);
    expect(api.canCreate("Audio")).toBe(false);
    expect(api.canCreate("SkyboxCreator")).toBe(false);
    expect(api.typeLabel("ParticleEmitter")).toBe("Basic Particle Emitter");

    const guid = await api.createAsset({ type: "Material", name: "Rock" });
    expect(registry.getByGuid(guid)?.path).toBe(
      "assets/Levels/Rock.material.hasset",
    );
    expect(listedAtRefresh).toBe(true);
    // Project Settings pickers name no owner document: project content root.
    const global = await api.createAsset({
      type: "Material",
      name: "Global",
      ownerPath: null,
    });
    expect(registry.getByGuid(global)?.path).toBe(
      "assets/Global.material.hasset",
    );

    expect(api.canCreateClass!("GameInstance")).toBe(true);
    expect(api.canCreateClass!("MeshComponent")).toBe(false);
    await expect(
      api.createClass!({ parentClass: "GameInstance", name: "My Game" }),
    ).resolves.toBe("My_Game");
    expect(noteAssetsCreated).toHaveBeenCalledTimes(3);
    // The registry indexed each asset on write; no full remount blocks the pick.
    expect(refreshAssetRegistry).not.toHaveBeenCalled();
    await expect(api.createAsset({ type: "Audio" })).rejects.toThrow(
      /cannot be created/,
    );
  });

  it("offers nothing without a project registry", () => {
    docs.value = {
      assetRegistry: null,
      noteAssetsCreated: vi.fn(),
      refreshAssetRegistry: vi.fn(),
      activeDocumentId: null,
      openDocuments: [],
    };
    expect(renderApi()!.canCreate("Material")).toBe(false);
  });

  it("carries a typed graph picker Definition into the newly created tree", async () => {
    const registry = await projectRegistry();
    docs.value = { assetRegistry: registry, noteAssetsCreated: vi.fn(), activeDocumentId: null, openDocuments: [] };
    const api = renderApi()!;
    const definitionGuid = await api.createAsset({ type: "DataDefinition", name: "Weapon" });
    const guid = await api.createAsset({ type: "DataTree", name: "Weapons",
      ...dataGraphAssetCreateOptions("data.readEntry", "tree", { definitionGuid }),
    });
    expect(registry.getByGuid(guid)?.header.payload).toEqual({ kind: "dataTree", defaultDefinitionGuid: definitionGuid, entries: [] });
    expect(registry.getByGuid(guid)?.header.dependencies).toContain(definitionGuid);
  });
});
