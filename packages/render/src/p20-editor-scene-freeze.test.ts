import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine, PBRMaterial, ScenePerformancePriority } from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
} from "@babylonslate/core";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { createEngine } from "./create-engine";
import { isEngineDefaultMaterial } from "./default-material";
import { editorMeshName } from "./scene-loader";

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
    expect(unfreeze).not.toHaveBeenCalled();
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
