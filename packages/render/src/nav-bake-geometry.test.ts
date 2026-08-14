import { afterEach, describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedScene,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { collectNavBakeGeometry } from "./nav-bake-geometry";

describe("collectNavBakeGeometry", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("merges MeshComponent actors and skips NavMesh / light proxies", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const sync = new EditorSceneSync(handle.scene);
    const sceneData: SerializedScene = {
      ...createDefaultScene(),
      actors: [
        createActor("ground", "Ground", {
          components: [createMeshComponent("mesh", "ground")],
        }),
        createActor("nav", "NavMesh", {
          components: [
            {
              id: "nav",
              classId: "NavMeshComponent",
              properties: { debugOverlay: true },
            },
          ],
        }),
        createActor("lamp", "Lamp", {
          components: [
            {
              id: "light",
              classId: "LightComponent",
              properties: { lightKind: "point" },
            },
          ],
        }),
      ],
    };
    sync.apply(sceneData);
    const geometry = collectNavBakeGeometry(sync, sceneData);
    expect(geometry.positions.length).toBeGreaterThan(9);
    expect(geometry.indices.length).toBeGreaterThan(3);
    sync.dispose();
  });
});
