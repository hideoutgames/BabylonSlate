import { afterEach, describe, expect, it } from "vitest";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  type SerializedScene,
} from "@babylonslate/core";
import { generateNavMesh } from "@babylonslate/navigation";
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

  it("bakes Recast navmesh bytes from a collected Ground mesh", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const sync = new EditorSceneSync(handle.scene);
    const sceneData: SerializedScene = {
      ...createDefaultScene(),
      actors: [
        createActor("ground", "Ground", {
          components: [createMeshComponent("mesh", "ground")],
        }),
      ],
    };
    sync.apply(sceneData);
    const geometry = collectNavBakeGeometry(sync, sceneData);
    const bytes = await generateNavMesh(geometry);
    expect(bytes.byteLength).toBeGreaterThan(32);
    sync.dispose();
  });

  it("drops 3D meshes whose world AABB is outside bake bounds", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const sync = new EditorSceneSync(handle.scene);
    const near = createActor("near", "Near", {
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      components: [createMeshComponent("mesh", "box")],
    });
    const far = createActor("far", "Far", {
      transform: {
        position: [40, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
      components: [createMeshComponent("mesh-far", "box")],
    });
    const sceneData: SerializedScene = {
      ...createDefaultScene(),
      actors: [near, far],
    };
    sync.apply(sceneData);
    const all = collectNavBakeGeometry(sync, sceneData);
    const clipped = collectNavBakeGeometry(sync, sceneData, {
      bakeBounds: {
        min: { x: -2, y: -2, z: -2 },
        max: { x: 2, y: 2, z: 2 },
      },
    });
    expect(all.positions.length).toBeGreaterThan(clipped.positions.length);
    expect(clipped.positions.length).toBeGreaterThan(0);
    for (let i = 0; i < clipped.positions.length; i += 3) {
      expect(clipped.positions[i]).toBeGreaterThanOrEqual(-3);
      expect(clipped.positions[i]).toBeLessThanOrEqual(3);
    }
    sync.dispose();
  });

  it("includes static NavMeshBlockerComponent solids and skips dynamic ones", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const sync = new EditorSceneSync(handle.scene);
    const ground = createActor("ground", "Ground", {
      components: [createMeshComponent("mesh", "ground")],
    });
    const sceneWithout: SerializedScene = {
      ...createDefaultScene(),
      actors: [ground],
    };
    const sceneWith: SerializedScene = {
      ...createDefaultScene(),
      actors: [
        ground,
        createActor("block", "Blocker", {
          transform: {
            position: [0, 1, 0],
            rotation: [0, 0, 0, 1],
            scale: [4, 2, 4],
          },
          components: [
            {
              id: "blocker",
              classId: "NavMeshBlockerComponent",
              properties: { dynamic: false, kind: "box", area: "unwalkable" },
            },
          ],
        }),
        createActor("door", "Door", {
          components: [
            {
              id: "dyn",
              classId: "NavMeshBlockerComponent",
              properties: { dynamic: true, kind: "box", area: "unwalkable" },
            },
          ],
        }),
      ],
    };
    sync.apply(sceneWith);
    const base = collectNavBakeGeometry(sync, sceneWithout);
    const withBlocker = collectNavBakeGeometry(sync, sceneWith);
    expect(withBlocker.positions.length).toBeGreaterThan(base.positions.length);
    sync.dispose();
  });

  it("builds a Recast walkable quad for 2D scenes without MeshComponent", () => {
    const sceneData: SerializedScene = {
      ...createDefaultScene("2d"),
      viewportMode: "2d",
      actors: [
        createActor("hero", "Hero", {
          transform: {
            position: [1, 2, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        }),
      ],
    };
    const geometry = collectNavBakeGeometry(
      { meshForActor: () => null },
      sceneData,
    );
    expect(geometry.indices).toEqual([0, 3, 2, 0, 2, 1]);
    expect(geometry.positions[1]).toBe(0);
  });

  it("excludes SkyboxComponent meshes from Recast input", () => {
    const handle = createTestEngine();
    handles.push(handle);
    const sync = new EditorSceneSync(handle.scene);
    const ground = createActor("ground", "Ground", {
      components: [createMeshComponent("mesh", "ground")],
    });
    const skybox = createActor("sky", "Skybox", {
      components: [
        {
          id: "sky",
          classId: "SkyboxComponent",
          properties: {
            size: 1000,
            faces: {
              px: null,
              py: null,
              pz: null,
              nx: null,
              ny: null,
              nz: null,
            },
          },
        },
      ],
    });
    const withoutSky: SerializedScene = {
      ...createDefaultScene(),
      actors: [ground],
    };
    const withSky: SerializedScene = {
      ...createDefaultScene(),
      actors: [ground, skybox],
    };
    sync.apply(withoutSky);
    const baseline = collectNavBakeGeometry(sync, withoutSky);
    sync.apply(withSky);
    const withSkybox = collectNavBakeGeometry(sync, withSky);
    expect(withSkybox.positions.length).toBe(baseline.positions.length);
    expect(withSkybox.indices.length).toBe(baseline.indices.length);
    sync.dispose();
  });
});
