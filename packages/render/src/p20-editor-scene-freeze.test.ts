import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Mesh,
  NullEngine,
  PBRMaterial,
  ScenePerformancePriority,
  ShaderMaterial,
} from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  DEFAULT_SCENE_SKYBOX_ACTOR_ID,
  DEFAULT_SCENE_SUN_ACTOR_ID,
  DEFAULT_SCENE_SUN_COMPONENT_ID,
} from "@babylonslate/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createEngine } from "./create-engine";
import { isEngineDefaultMaterial } from "./default-material";
import { GRID_MESH_NAME } from "./editor-grid";
import { encodeTriangleGlb } from "./model-mesh";
import { editorComponentMeshName, editorMeshName } from "./scene-loader";
import { visualMeshes } from "./visual-meshes";

class FakeCanvas {
  width = 256;
  height = 256;
  clientWidth = 256;
  clientHeight = 256;
  readonly listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      width: this.clientWidth,
      height: this.clientHeight,
    };
  }
}

function activeMeshesOf(scene: {
  getActiveMeshes: () => { data: unknown[]; length: number };
}): unknown[] {
  const active = scene.getActiveMeshes();
  return active.data.slice(0, active.length);
}

function sceneMaps(scene: { useMaterialMeshMap: boolean; useClonedMeshMap: boolean }) {
  const geometries = (scene as unknown as { _geometriesByUniqueId: unknown })
    ._geometriesByUniqueId;
  return {
    materials: scene.useMaterialMeshMap,
    clones: scene.useClonedMeshMap,
    geometries: geometries != null,
  };
}

describe("p20-editor-scene-freeze", () => {
  const handles: Array<{ dispose: () => void }> = [];
  const engines: NullEngine[] = [];

  afterEach(() => {
    while (handles.length > 0) {
      handles.pop()?.dispose();
    }
    while (engines.length > 0) {
      engines.pop()?.dispose();
    }
  });

  function sharedEngine(): NullEngine {
    const engine = new NullEngine();
    engines.push(engine);
    return engine;
  }

  function editorHandle() {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      editor: true,
    });
    handles.push(handle);
    return handle;
  }

  function playHandle() {
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    const handle = createEngine(canvas, {
      sharedEngine: sharedEngine(),
      playMode: true,
    });
    handles.push(handle);
    return handle;
  }

  it("constructs editor and Play scenes with unique-id lookup maps", () => {
    const editor = editorHandle();
    const play = playHandle();
    expect(sceneMaps(editor.scene)).toEqual({
      materials: true,
      clones: true,
      geometries: true,
    });
    expect(sceneMaps(play.scene)).toEqual({
      materials: true,
      clones: true,
      geometries: true,
    });
    expect(editor.scene.skipPointerMovePicking).toBe(true);
    expect(play.scene.skipPointerMovePicking).toBe(true);
    expect(play.scene.performancePriority).toBe(
      ScenePerformancePriority.Intermediate,
    );
    expect(editor.scene.performancePriority).toBe(
      ScenePerformancePriority.BackwardCompatible,
    );
    expect(play.scene.autoClear).toBe(true);
    expect(editor.scheduler.shouldRender(0)).toBe(true);
  });

  it("freezes idle active meshes after editor load and unfreezes on structural change", () => {
    const handle = editorHandle();
    expect(handle.scene._activeMeshesFrozen).toBe(true);

    const unfreeze = vi.spyOn(handle.scene, "unfreezeActiveMeshes");
    const freeze = vi.spyOn(handle.scene, "freezeActiveMeshes");
    const base = createDefaultScene();
    const actor = base.actors.find((entry) => entry.id === "actor-1");
    expect(actor).toBeDefined();
    actor!.transform = {
      ...actor!.transform,
      position: [3, 0, 0],
    };
    unfreeze.mockClear();
    freeze.mockClear();
    handle.loadScene(base);
    expect(freeze).toHaveBeenCalled();
    expect(handle.scene._activeMeshesFrozen).toBe(true);

    unfreeze.mockClear();
    freeze.mockClear();
    handle.loadScene({
      ...base,
      actors: [...base.actors, createActor("extra", "Extra")],
    });
    expect(unfreeze).toHaveBeenCalled();
    expect(freeze).toHaveBeenCalled();
    expect(handle.scene._activeMeshesFrozen).toBe(true);
  });

  it("includes a box actor in the frozen active-mesh list", () => {
    const handle = editorHandle();
    handle.loadScene({
      ...createDefaultScene(),
      actors: [
        createActor("hero", "Hero", {
          components: [createMeshComponent("c1", "box")],
        }),
      ],
    });
    const mesh = handle.editor?.sync.meshForActor("hero");
    expect(mesh).not.toBeNull();
    expect(handle.scene._activeMeshesFrozen).toBe(true);
    expect(activeMeshesOf(handle.scene)).toContain(mesh);
  });

  it("frames an actor once at a pull-back distance without locking the camera to the mesh", () => {
    const handle = editorHandle();
    handle.loadScene({
      ...createDefaultScene(),
      actors: [
        createActor("hero", "Hero", {
          transform: {
            position: [8, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          components: [createMeshComponent("c1", "box")],
        }),
      ],
    });
    const editor = handle.editor!;
    const mesh = editor.sync.meshForActor("hero")!;
    editor.camera.camera.radius = 0.5;
    editor.frameActor("hero");
    editor.camera.camera.getViewMatrix();

    expect(editor.camera.camera.target).not.toBe(mesh.getAbsolutePosition());
    expect(editor.camera.camera.target.x).toBeCloseTo(8, 1);
    expect(editor.camera.camera.radius).toBeGreaterThanOrEqual(12);
    expect(editor.camera.camera.radius).toBeGreaterThan(editor.camera.camera.minZ);

    const framedTarget = editor.camera.camera.target.clone();
    mesh.position.x = 40;
    mesh.computeWorldMatrix(true);
    editor.camera.camera.getViewMatrix();
    expect(editor.camera.camera.target.x).toBeCloseTo(framedTarget.x, 5);
    expect(editor.camera.camera.target.y).toBeCloseTo(framedTarget.y, 5);
    expect(editor.camera.camera.target.z).toBeCloseTo(framedTarget.z, 5);
  });

  it("re-frames the same actor to the viewing radius after a close zoom", () => {
    const handle = editorHandle();
    handle.loadScene({
      ...createDefaultScene(),
      actors: [
        createActor("hero", "Hero", {
          components: [createMeshComponent("c1", "box")],
        }),
      ],
    });
    const editor = handle.editor!;
    editor.frameActor("hero");
    editor.camera.camera.radius = 0.5;
    editor.frameActor("hero");
    editor.camera.camera.getViewMatrix();
    expect(editor.camera.camera.radius).toBeGreaterThanOrEqual(12);
  });

  it("keeps the editor grid in the frozen active-mesh list after hide", () => {
    const handle = editorHandle();
    const grid = handle.editor?.grid.mesh;
    expect(grid?.name).toBe(GRID_MESH_NAME);
    expect(grid?.alwaysSelectAsActiveMesh).toBe(true);
    expect(handle.scene._activeMeshesFrozen).toBe(true);
    expect(activeMeshesOf(handle.scene)).toContain(grid);

    handle.editor?.grid.setVisible(false);
    expect(grid?.isVisible).toBe(true);
    expect(grid?.visibility).toBe(0);
    expect(
      (grid?.material as ShaderMaterial).serialize().floats.gridVisible,
    ).toBe(0);
    expect(handle.scene._activeMeshesFrozen).toBe(true);
    expect(activeMeshesOf(handle.scene)).toContain(grid);
  });

  it("keeps the editor grid in the frozen active list after hide then show", () => {
    const handle = editorHandle();
    const grid = handle.editor?.grid;
    expect(grid).toBeTruthy();
    grid!.setVisible(false);
    handle.loadScene(createDefaultScene());
    expect(handle.scene._activeMeshesFrozen).toBe(true);
    expect(grid!.mesh.isVisible).toBe(true);
    expect(grid!.mesh.visibility).toBe(0);
    expect(
      (grid!.mesh.material as ShaderMaterial).serialize().floats.gridVisible,
    ).toBe(0);
    grid!.setVisible(true);
    expect(grid!.mesh.isVisible).toBe(true);
    expect(grid!.mesh.visibility).toBe(1);
    expect(
      (grid!.mesh.material as ShaderMaterial).serialize().floats.gridVisible,
    ).toBe(1);
  });

  it("includes instantiated GLB parts in the frozen active-mesh list", async () => {
    const handle = editorHandle();
    const mesh = createMeshComponent("c1", "box");
    mesh.properties.assetGuid = "model-1";
    handle.loadScene({
      ...createDefaultScene(),
      actors: [createActor("hero", "Hero", { components: [mesh] })],
    });
    handle.setMeshAssets({
      modelBytes: new Map([["model-1", encodeTriangleGlb()]]),
    });
    await handle.whenEditorModelsReady();
    const root = handle.editor?.sync.meshForActor("hero");
    expect(root).not.toBeNull();
    const parts = visualMeshes(root!).filter((part) => part.getTotalVertices() > 0);
    expect(parts.length).toBeGreaterThan(0);
    expect(handle.scene._activeMeshesFrozen).toBe(true);
    const active = activeMeshesOf(handle.scene);
    expect(parts.some((part) => active.includes(part))).toBe(true);
  });

  it("freezes static actor world matrices and unfreezes them on gizmo drag", () => {
    const handle = editorHandle();
    const editor = handle.editor;
    expect(editor).not.toBeNull();
    handle.loadScene({
      ...createDefaultScene(),
      actors: [
        createActor("hero", "Hero", {
          components: [createMeshComponent("c1", "box")],
        }),
      ],
    });
    const mesh = editor!.sync.meshForActor("hero");
    expect(mesh).not.toBeNull();
    expect(mesh!.isWorldMatrixFrozen).toBe(true);

    editor!.gizmos.setTool("translate");
    editor!.setSelectedActors(["hero"]);
    editor!.gizmos.positionGizmo.xGizmo.dragBehavior.onDragStartObservable.notifyObservers(
      {} as never,
    );
    expect(mesh!.isWorldMatrixFrozen).toBe(false);

    editor!.gizmos.positionGizmo.xGizmo.dragBehavior.onDragEndObservable.notifyObservers(
      {} as never,
    );
    expect(mesh!.isWorldMatrixFrozen).toBe(true);
  });

  it("does not freeze skybox, billboard, or grid world matrices", () => {
    const handle = editorHandle();
    handle.loadScene(createDefaultScene());
    const skybox = handle.editor?.sync.meshForActor(DEFAULT_SCENE_SKYBOX_ACTOR_ID);
    expect(skybox).not.toBeNull();
    expect(skybox!.isWorldMatrixFrozen).toBe(false);

    const grid = handle.editor?.grid.mesh;
    expect(grid?.name).toBe(GRID_MESH_NAME);
    expect(grid!.isWorldMatrixFrozen).toBe(false);

    const icon = handle.scene.getMeshByName(
      editorComponentMeshName(
        DEFAULT_SCENE_SUN_ACTOR_ID,
        DEFAULT_SCENE_SUN_COMPONENT_ID,
      ),
    );
    expect(icon).not.toBeNull();
    expect(icon!.billboardMode).toBe(Mesh.BILLBOARDMODE_ALL);
    expect(icon!.isWorldMatrixFrozen).toBe(false);
  });

  it("freezes scene materials except those open for editing", () => {
    const handle = editorHandle();
    const document = createDefaultMaterialDocument();
    handle.setMaterialDocuments(new Map([["mat-1", document]]));
    const mesh = createMeshComponent("c1", "box");
    mesh.properties.materialGuid = "mat-1";
    handle.loadScene({
      ...createDefaultScene(),
      actors: [createActor("hero", "Hero", { components: [mesh] })],
    });
    const visual = handle.scene.getMeshByName(editorMeshName("hero"));
    expect(visual?.material).toBeTruthy();
    expect(visual!.material!.isFrozen).toBe(true);
    const def = handle.scene.materials.find(isEngineDefaultMaterial);
    expect(def).toBeInstanceOf(PBRMaterial);
    expect(def!.isFrozen).toBe(true);

    handle.setEditingMaterialGuids(new Set(["mat-1"]));
    expect(visual!.material!.isFrozen).toBe(false);
    expect(def!.isFrozen).toBe(true);

    handle.setEditingMaterialGuids(new Set());
    expect(visual!.material!.isFrozen).toBe(true);
  });

  it("warms compiled and default materials before first draw", async () => {
    const handle = editorHandle();
    const document = createDefaultMaterialDocument();
    handle.setMaterialDocuments(new Map([["mat-1", document]]));
    const mesh = createMeshComponent("c1", "box");
    mesh.properties.materialGuid = "mat-1";
    handle.loadScene({
      ...createDefaultScene(),
      actors: [createActor("hero", "Hero", { components: [mesh] })],
    });
    const visual = handle.scene.getMeshByName(editorMeshName("hero"));
    const assigned = visual?.material;
    const def = handle.scene.materials.find(isEngineDefaultMaterial);
    expect(assigned).toBeTruthy();
    expect(def).toBeTruthy();
    const assignedWarm = vi.spyOn(assigned!, "forceCompilationAsync");
    const defaultWarm = vi.spyOn(def!, "forceCompilationAsync");
    await handle.prewarmSceneMaterials();
    expect(assignedWarm).toHaveBeenCalled();
    expect(defaultWarm).toHaveBeenCalled();
  });
});
