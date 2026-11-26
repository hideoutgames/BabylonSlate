import { describe, expect, it, vi } from "vitest";
import { createDefaultScene, createEmptyProject } from "@haptic/core";
import type { IndexedAsset } from "@haptic/assets";
import { exportProjectGameArtifact } from "./export-game-artifact";
import type { ProjectService } from "./project-service";

function indexedAsset(
  guid: string,
  type: IndexedAsset["header"]["type"],
  name: string,
  path: string,
  extra: Partial<IndexedAsset["header"]> = {},
): IndexedAsset {
  return {
    path,
    rootId: "project",
    header: {
      dependencyMetadataVersion: 1,
      requiredDependencies: [],
      guid,
      type,
      name,
      engineVersion: "0.0.0",
      version: 1,
      mode: "thin",
      dependencies: [],
      payload: {},
      chunks: [],
      ...extra,
    },
  };
}

describe("exportProjectGameArtifact reachability-first loading", () => {
  it("skips loading unreached binary assets and unreached scenes while discovering JSON references", async () => {
    const project = createEmptyProject("Reachability Test");
    project.settings.startupSceneGuid = "scene-start";
    project.scenes = ["assets/Start.scene.hasset", "assets/Unused.scene.hasset"];

    const startScene = createDefaultScene("3d");
    // Reference a Texture directly in scene JSON (omitted from header.dependencies) to verify Phase 1 discovers it.
    startScene.actors = [
      {
        id: "actor-1",
        name: "Prop",
        classId: "Actor",
        parentId: null,
        folderId: null,
        visible: true,
        locked: false,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        components: [
          {
            id: "comp-1",
            classId: "SpriteComponent",
            name: "Sprite",
            properties: { textureGuid: "tex-used" },
          },
        ],
      },
    ];

    const assets: IndexedAsset[] = [
      indexedAsset("scene-start", "Scene", "Start", "assets/Start.scene.hasset"),
      indexedAsset("scene-unused", "Scene", "Unused", "assets/Unused.scene.hasset"),
      indexedAsset("tex-used", "Texture", "UsedTex", "assets/UsedTex.texture.hasset", {
        payload: { width: 4, height: 4, usage: "albedo" },
        chunks: [{ id: "pixels", kind: "pixels", mime: "image/png", byteLength: 4, sha256: "a".repeat(64), locator: { inline: { offset: 0, length: 4 } } }],
      }),
      indexedAsset("tex-unused", "Texture", "UnusedTex", "assets/UnusedTex.texture.hasset", {
        payload: { width: 4096, height: 4096, usage: "albedo" },
        chunks: [{ id: "pixels", kind: "pixels", mime: "image/png", byteLength: 1024, sha256: "b".repeat(64), locator: { inline: { offset: 0, length: 1024 } } }],
      }),
      indexedAsset("model-unused", "Model", "UnusedModel", "assets/UnusedModel.model.hasset", {
        chunks: [{ id: "source", kind: "glb", mime: "model/gltf-binary", byteLength: 2048, sha256: "c".repeat(64), locator: { inline: { offset: 0, length: 2048 } } }],
      }),
    ];

    const loadDocument = vi.fn(async (_kind: string, path: string) => {
      if (path === "assets/Start.scene.hasset") return startScene;
      throw new Error(`Unexpected loadDocument for ${path}`);
    });
    const loadDocumentWithChunks = vi.fn(async (_kind: string, path: string) => {
      if (path === "assets/Start.scene.hasset") {
        return {
          document: startScene,
          header: assets[0]!.header,
          chunks: new Map<string, Uint8Array>(),
        };
      }
      if (path === "assets/UsedTex.texture.hasset") {
        return {
          document: assets[2]!.header.payload,
          header: assets[2]!.header,
          chunks: new Map<string, Uint8Array>([["pixels", new Uint8Array([1, 2, 3, 4])]]),
        };
      }
      throw new Error(`Unexpected loadDocumentWithChunks for ${path}`);
    });
    const readAssetChunk = vi.fn(async () => null);

    const projectService = {
      guid: "project-guid",
      plugins: [],
      registry: {
        list: () => assets,
        getByGuid: (guid: string) => assets.find((entry) => entry.header.guid === guid),
      },
      extensions: {
        gameLibraries: async () => [],
        assertTrustGatedNodesAllowed: () => {},
      },
      listExportAssets: async () => assets,
      loadDocument,
      loadDocumentWithChunks,
      readAssetChunk,
    } as unknown as ProjectService;

    const result = await exportProjectGameArtifact(projectService, project, {
      platform: "web",
      playerFiles: new Map([
        ["index.html", new TextEncoder().encode("<html></html>")],
        ["player.js", new TextEncoder().encode("console.log('ok');")],
      ]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.manifest.assets.map((entry) => entry.guid).sort()).toEqual([
      "scene-start",
      "tex-used",
    ]);
    // Unreached assets (Unused scene, UnusedTex, UnusedModel) were never touched.
    const touchedPaths = [
      ...loadDocument.mock.calls.map((call) => call[1]),
      ...loadDocumentWithChunks.mock.calls.map((call) => call[1]),
    ];
    expect(touchedPaths).not.toContain("assets/Unused.scene.hasset");
    expect(touchedPaths).not.toContain("assets/UnusedTex.texture.hasset");
    expect(touchedPaths).not.toContain("assets/UnusedModel.model.hasset");
  });
});
