import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import type { IndexedAsset } from "@babylonslate/assets";
import { createDefaultWaterDefinition, type WaterDefinition } from "@babylonslate/core";
import { WaterPreviewPanel } from "./water-panels";

const WATER_PATH = "assets/Lake.water.babasset";

type OpenDocument = { id: string; ref: { kind: string; path: string }; content: unknown };
type PreviewHost = { scene: { isDisposed: boolean }; dispose: () => void };
type PreviewMesh = { host: PreviewHost; definition: WaterDefinition; material: unknown };
type MaterialLibraryResult = { documents: Map<string, unknown>; functions: Map<string, unknown>; textureGuids: string[] };

/**
 * The render package is replaced at its scene/mesh boundary: each preview scene is a real Babylon scene on a
 * NullEngine (so the panel's own light works), and the mesh calls record what the panel builds and applies.
 */
const harness = vi.hoisted(() => ({
  documents: [] as OpenDocument[],
  assets: new Map<string, IndexedAsset>(),
  registryVersion: 0,
  engine: { id: "shared-engine" },
  play: null as { ensureSharedEngine: () => unknown } | null,
  hosts: [] as PreviewHost[],
  meshes: [] as PreviewMesh[],
  applied: [] as Array<{ mesh: PreviewMesh; definition: WaterDefinition }>,
  loadLibrary: async (guid: string): Promise<MaterialLibraryResult> => ({ documents: new Map([[guid, {}]]), functions: new Map(), textureGuids: [] }),
}));

vi.mock("@babylonslate/render", async () => {
  const { NullEngine, Scene } = await import("@babylonjs/core");
  const engine = new NullEngine();
  return {
    createParticlePreviewScene: () => {
      const scene = new Scene(engine);
      const host = { scene, camera: {}, dispose: () => scene.dispose() };
      harness.hosts.push(host);
      return host;
    },
    createMaterialPreviewPresenter: () => ({ present: () => {}, dispose: () => {} }),
    createWaterMesh: (scene: unknown, _name: string, _body: unknown, definition: WaterDefinition, material: unknown) => {
      const mesh = { host: harness.hosts.find((host) => host.scene === scene)!, definition: structuredClone(definition), material };
      harness.meshes.push(mesh);
      return mesh;
    },
    updateWaterMeshDefinition: (mesh: PreviewMesh, definition: WaterDefinition) => {
      harness.applied.push({ mesh, definition });
      return true;
    },
    setSceneWaterTime: () => {},
    MaterialLibrary: class {
      acquire(_scene: unknown, guid: string) {
        return { ok: true, material: { customMaterial: guid }, ready: Promise.resolve([]) };
      }
      dispose() {}
    },
    installTextureBytes: (bytes: ReadonlyMap<string, Uint8Array>) => bytes,
    acquireMaterialTexture: () => null,
    resourceCacheForEngine: () => ({}),
  };
});
vi.mock("../context/play-context", () => ({ useOptionalPlay: () => harness.play }));
vi.mock("../context/document-workspace-context", () => ({
  useDocumentWorkspace: () => ({ documentId: `water:${WATER_PATH}` }),
}));
vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    openDocuments: harness.documents,
    assetRegistry: { getByGuid: (guid: string) => harness.assets.get(guid), list: () => [...harness.assets.values()] },
    registryVersion: harness.registryVersion,
    collectPlayMaterialLibrary: (_scene: unknown, _extra: unknown, guids: string[]) => harness.loadLibrary(guids[0]!),
    collectPlayTextureBytes: async () => new Map(),
  }),
}));

function asset(guid: string, type: string, path: string, dependencies: string[] = [], payload: Record<string, unknown> = {}, chunkSha256s: string[] = []): IndexedAsset {
  const chunks = chunkSha256s.map((sha256, index) => ({ id: `chunk-${index}`, kind: "image", mime: "image/png", sha256, locator: { blob: sha256 } }));
  return {
    rootId: "project", path,
    header: { guid, type, name: guid, version: 1, engineVersion: "1", mode: "thin", parentClass: null, payload, dependencies, chunks },
  };
}

/** Replace one open document's content, as an edit does: a new content object in a new list. */
function setDocument(kind: string, path: string, content: unknown) {
  const id = `${kind}:${path}`;
  harness.documents = [...harness.documents.filter((entry) => entry.id !== id), { id, ref: { kind, path }, content }];
}

let water: WaterDefinition;
function editWater(patch: Partial<WaterDefinition>) {
  water = { ...water, ...patch };
  setDocument("water", WATER_PATH, water);
}

function renderPreview() {
  const view = render(<WaterPreviewPanel {...({} as IDockviewPanelProps)} />);
  return () => view.rerender(<WaterPreviewPanel {...({} as IDockviewPanelProps)} />);
}

beforeEach(() => {
  harness.play = { ensureSharedEngine: () => harness.engine };
  water = createDefaultWaterDefinition();
  setDocument("water", WATER_PATH, water);
});

afterEach(() => {
  cleanup();
  harness.documents = [];
  harness.assets.clear();
  harness.registryVersion = 0;
  harness.hosts.length = 0;
  harness.meshes.length = 0;
  harness.applied.length = 0;
  harness.loadLibrary = async (guid) => ({ documents: new Map([[guid, {}]]), functions: new Map(), textureGuids: [] });
});

describe("WaterPreviewPanel", () => {
  it("applies a Details scrub to the existing preview while Play and other documents churn", () => {
    const rerender = renderPreview();
    expect(harness.meshes).toHaveLength(1);
    for (const waveHeight of [0.5, 0.75, 1]) {
      editWater({ waveHeight });
      // The Play context changes identity on every edit anywhere; so do unrelated open documents.
      harness.play = { ensureSharedEngine: () => harness.engine };
      setDocument("material", "assets/Unrelated.material.babasset", { waveHeight });
      rerender();
      // Each step reaches the preview as it is committed.
      expect(harness.applied.at(-1)!.mesh).toBe(harness.meshes[0]);
      expect(harness.applied.at(-1)!.definition.waveHeight).toBe(waveHeight);
    }
    expect(harness.hosts).toHaveLength(1);
    expect(harness.hosts[0]!.scene.isDisposed).toBe(false);
    expect(harness.meshes).toHaveLength(1);
  });

  it("rebuilds for a Style or Custom Material change and for edits to anything that material reaches", async () => {
    // A closed Material whose saved header calls an open Material Function, which samples a Texture.
    harness.assets.set("mat", asset("mat", "Material", "assets/Mat.material.babasset", ["fn"]));
    harness.assets.set("fn", asset("fn", "MaterialFunction", "assets/Fn.materialfunction.babasset"));
    const texture = (payload: Record<string, unknown>, chunkSha256s: string[]) => asset("tex", "Texture", "assets/Tex.texture.babasset", [], { usage: "albedo", ...payload }, chunkSha256s);
    harness.assets.set("tex", texture({ compressionState: "pending" }, ["source-1"]));
    harness.assets.set("other", asset("other", "Material", "assets/Other.material.babasset"));
    const sample = (name: string) => ({ name, nodes: [{ id: "sample", type: "texture.sample", properties: { textureGuid: "tex" } }] });
    setDocument("material-function", "assets/Fn.materialfunction.babasset", sample("Fn"));
    editWater({ materialGuid: "mat" });
    const rerender = renderPreview();
    await waitFor(() => expect(harness.meshes).toHaveLength(1));
    expect(harness.meshes[0]!.material).toEqual({ customMaterial: "mat" });
    const builds = () => harness.meshes.length;

    setDocument("material", "assets/Other.material.babasset", { name: "Unrelated edit" });
    editWater({ opacity: 0.5 });
    rerender();
    expect(harness.hosts).toHaveLength(1);

    setDocument("material-function", "assets/Fn.materialfunction.babasset", sample("Fn edited"));
    rerender();
    await waitFor(() => expect(builds()).toBe(2));

    // Encode progress re-indexes the Texture without changing the bytes the preview loads.
    for (const progress of [{ compressionState: "encoding" }, { compressionState: "encode_failed", encodeError: "Encoder failed.", encodeWallMs: 12 }]) {
      harness.assets.set("tex", texture(progress, ["source-1"]));
      harness.registryVersion++;
      rerender();
    }
    expect(harness.hosts).toHaveLength(2);

    // A committed encode (or a reimport) changes the saved bytes, which the preview loads from the asset.
    harness.assets.set("tex", texture({ compressionState: "compressed", ktx2Sha256: "ktx2-1" }, ["source-1", "ktx2-1"]));
    harness.registryVersion++;
    rerender();
    await waitFor(() => expect(builds()).toBe(3));

    editWater({ materialGuid: "other" });
    rerender();
    await waitFor(() => expect(builds()).toBe(4));
    expect(harness.meshes[3]!.material).toEqual({ customMaterial: "other" });

    editWater({ style: "stylized" });
    rerender();
    await waitFor(() => expect(builds()).toBe(5));
    expect(harness.hosts.slice(0, -1).every((host) => host.scene.isDisposed)).toBe(true);
    expect(harness.hosts.at(-1)!.scene.isDisposed).toBe(false);
  });

  it("builds a loading Custom Material preview with the edits made while it loaded", async () => {
    harness.assets.set("mat", asset("mat", "Material", "assets/Mat.material.babasset"));
    let finish: (library: MaterialLibraryResult) => void = () => {};
    harness.loadLibrary = () => new Promise((resolve) => { finish = resolve; });
    editWater({ materialGuid: "mat" });
    const rerender = renderPreview();
    editWater({ waveHeight: 2, foamAmount: 0.1 });
    rerender();
    finish({ documents: new Map([["mat", {}]]), functions: new Map(), textureGuids: [] });
    await waitFor(() => expect(harness.meshes).toHaveLength(1));
    expect(harness.meshes[0]!.definition).toMatchObject({ waveHeight: 2, foamAmount: 0.1 });
    expect(harness.hosts).toHaveLength(1);
  });
});
