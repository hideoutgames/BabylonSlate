import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  AssetRegistry,
  encodeBabasset,
  projectContentRoot,
} from "@babylonslate/assets";
import { useAssetCreate, type AssetCreateApi } from "@babylonslate/editor-kit";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import { AssetCreateDocumentsProvider } from "./asset-create-provider";

const docs = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock("./document-context", () => ({
  useDocuments: () => docs.value,
}));

afterEach(() => {
  cleanup();
});

async function projectRegistry(): Promise<AssetRegistry> {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("test.babproject");
  await storage.mkdir("assets/Levels", true);
  const bytes = await encodeBabasset({
    header: {
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
  await storage.writeBinary("assets/Levels/Main.scene.babasset", bytes);
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
  it("creates beside the owner (default: the active document) and refreshes before resolving", async () => {
    const registry = await projectRegistry();
    let listedAtRefresh = false;
    const refreshAssetRegistry = vi.fn(async () => {
      listedAtRefresh = registry
        .list()
        .some((asset) => asset.path === "assets/Levels/Rock.material.babasset");
    });
    docs.value = {
      assetRegistry: registry,
      refreshAssetRegistry,
      activeDocumentId: "scene:main",
      openDocuments: [
        {
          id: "scene:main",
          ref: { kind: "scene", path: "assets/Levels/Main.scene.babasset" },
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
      "assets/Levels/Rock.material.babasset",
    );
    expect(listedAtRefresh).toBe(true);
    // Project Settings pickers name no owner document: project content root.
    const global = await api.createAsset({
      type: "Material",
      name: "Global",
      ownerPath: null,
    });
    expect(registry.getByGuid(global)?.path).toBe(
      "assets/Global.material.babasset",
    );

    expect(api.canCreateClass!("GameInstance")).toBe(true);
    expect(api.canCreateClass!("MeshComponent")).toBe(false);
    await expect(
      api.createClass!({ parentClass: "GameInstance", name: "My Game" }),
    ).resolves.toBe("My_Game");
    expect(refreshAssetRegistry).toHaveBeenCalledTimes(3);
    await expect(api.createAsset({ type: "Audio" })).rejects.toThrow(
      /cannot be created/,
    );
  });

  it("offers nothing without a project registry", () => {
    docs.value = {
      assetRegistry: null,
      refreshAssetRegistry: vi.fn(),
      activeDocumentId: null,
      openDocuments: [],
    };
    expect(renderApi()!.canCreate("Material")).toBe(false);
  });
});
