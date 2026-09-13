import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Mesh,
  MeshBuilder,
  NodeMaterial,
  NodeMaterialModes,
  NullEngine,
  PBRMaterial,
  SpotLight,
  ShadowGenerator,
  Scene,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
} from "@babylonslate/core";
import {
  applyEditorMaterialFreeze,
  isStructuralEditorChange,
  isSceneFrameReady,
  materialLibraryAssetGuid,
  prewarmSceneMaterials,
  SCENE_SHADER_WARM_TIMEOUT_MS,
  freezeEditorActiveMeshes,
  unfreezeEditorActiveMeshes,
} from "./scene-perf";

it("freezes ready editor meshes only in their own floating-origin render frame", () => {
  const engine = new NullEngine();
  vi.spyOn(engine, "supportsUniformBuffers", "get").mockReturnValue(true);
  vi.spyOn(engine, "getCreationOptions").mockReturnValue({ useLargeWorldRendering: true });
  const scene = new Scene(engine);
  scene.activeCamera = new UniversalCamera("editor", new Vector3(2000, 0, -10), scene);
  const previous = new Scene(engine);
  previous.activeCamera = new UniversalCamera("previous", new Vector3(0, 4, -8), previous);
  previous.render();
  previous.dispose();
  const ready = vi.spyOn(scene, "isReady").mockReturnValue(false);
  try {
    freezeEditorActiveMeshes(scene);
    expect(scene._activeMeshesFrozen).toBe(false);
    scene.render();
    expect(scene._activeMeshesFrozen).toBe(false);
    ready.mockReturnValue(true);
    scene.render();
    expect(scene._activeMeshesFrozen).toBe(true);
    expect(scene.skipFrustumClipping).toBe(false);
    expect([...scene.getSceneUniformBuffer().getData()].every(Number.isFinite)).toBe(true);

    freezeEditorActiveMeshes(scene);
    unfreezeEditorActiveMeshes(scene);
    scene.render();
    expect(scene._activeMeshesFrozen).toBe(false);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});

describe("isStructuralEditorChange", () => {
  const base = createDefaultScene();
  const actor = base.actors[0]!;

  it("treats the first apply as structural", () => {
    expect(isStructuralEditorChange(null, base)).toBe(true);
  });

  it("ignores transform-only edits so idle freeze stays in place", () => {
    const moved = {
      ...base,
      actors: [
        {
          ...actor,
          transform: {
            ...actor.transform,
            position: [3, 0, 0] as [number, number, number],
          },
        },
        ...base.actors.slice(1),
      ],
    };
    expect(isStructuralEditorChange(base, moved)).toBe(false);
  });

  it("unfreezes when parent, visibility, or visual fingerprint changes", () => {
    const reparented = {
      ...base,
      actors: [{ ...actor, parentId: "missing-parent" }, ...base.actors.slice(1)],
    };
    const hidden = {
      ...base,
      actors: [{ ...actor, visible: false }, ...base.actors.slice(1)],
    };
    const extra = {
      ...base,
      actors: [...base.actors, createActor("extra", "Extra")],
    };
    const swapped = {
      ...base,
      actors: [createActor("other", actor.name), ...base.actors.slice(1)],
    };
    const mesh = createMeshComponent("mesh-1", "sphere");
    const visual = {
      ...base,
      actors: [
        createActor(actor.id, actor.name, { components: [mesh] }),
        ...base.actors.slice(1),
      ],
    };
    expect(isStructuralEditorChange(base, reparented)).toBe(true);
    expect(isStructuralEditorChange(base, hidden)).toBe(true);
    expect(isStructuralEditorChange(base, extra)).toBe(true);
    expect(isStructuralEditorChange(base, swapped)).toBe(true);
    expect(isStructuralEditorChange(base, visual)).toBe(true);
  });
});

describe("applyEditorMaterialFreeze", () => {
  const engines: NullEngine[] = [];

  afterEach(() => {
    while (engines.length > 0) {
      engines.pop()?.dispose();
    }
  });

  it("skips particle-domain NodeMaterials and unnamed helpers", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    const particle = new NodeMaterial("material:fx-1", scene, {
      emitComments: false,
    });
    particle.mode = NodeMaterialModes.Particle;
    const helper = new NodeMaterial("preview-tmp", scene, { emitComments: false });
    applyEditorMaterialFreeze(scene, new Set());
    expect(particle.isFrozen).toBe(false);
    expect(helper.isFrozen).toBe(false);
    expect(materialLibraryAssetGuid(particle)).toBe("fx-1");
    expect(materialLibraryAssetGuid(helper)).toBeNull();
    scene.dispose();
  });
});

describe("prewarmSceneMaterials", () => {
  it("warms shared material consumers separately and includes instanced variants", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const first = MeshBuilder.CreateBox("static", {}, scene);
      const second = MeshBuilder.CreateBox("instanced", {}, scene);
      first.material = second.material = new PBRMaterial("shared", scene);
      second.createInstance("copy");
      const compile = vi.spyOn(first.material, "forceCompilationAsync").mockResolvedValue();
      await prewarmSceneMaterials(scene);
      expect(compile).toHaveBeenCalledWith(first);
      expect(compile).toHaveBeenCalledWith(second);
      expect(compile).toHaveBeenCalledWith(second, { useInstances: true });
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it("rejects a ready world frame while its shadow render target is unready", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const light = new SpotLight("shadow", Vector3.Zero(), Vector3.Down(), 1, 1, scene);
      const generator = new ShadowGenerator(256, light);
      vi.spyOn(scene, "isReady").mockReturnValue(true);
      const ready = vi.spyOn(generator.getShadowMap()!, "isReadyForRendering").mockReturnValue(false);
      expect(isSceneFrameReady(scene)).toBe(false);
      ready.mockReturnValue(true);
      expect(isSceneFrameReady(scene)).toBe(true);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it("probes shadow readiness in its own floating-origin scene after another scene is created", () => {
    const engine = new NullEngine();
    vi.spyOn(engine, "getCreationOptions").mockReturnValue({ useLargeWorldRendering: true });
    const scene = new Scene(engine);
    scene.activeCamera = new UniversalCamera("editor", new Vector3(2000, 3, -10), scene);
    const light = new SpotLight("shadow", new Vector3(2000, 5, 0), Vector3.Down(), 1, 1, scene);
    new ShadowGenerator(256, light);
    // Isolate render-target readiness from NullEngine's uncompiled world effects.
    vi.spyOn(scene, "isReady").mockReturnValue(true);
    // A newly mounted helper/preview owns Babylon's global floating-origin
    // context but has never rendered, so it has no view/projection matrices.
    const sibling = new Scene(engine);
    try {
      expect(() => isSceneFrameReady(scene)).not.toThrow();
    } finally {
      sibling.dispose();
      scene.dispose();
      engine.dispose();
    }
  });

  it("fails readiness when compilation times out and stops the late warm continuation", async () => {
    vi.useFakeTimers();
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mesh = new Mesh("warm-mesh", scene);
    mesh.material = scene.defaultMaterial;
    let finishCompile!: () => void;
    vi.spyOn(scene.defaultMaterial, "forceCompilationAsync").mockReturnValue(
      new Promise((resolve) => { finishCompile = resolve; }),
    );
    const next = new Mesh("next-mesh", scene);
    next.material = new PBRMaterial("next-material", scene);
    const nextCompile = vi.spyOn(next.material, "forceCompilationAsync");
    const done = prewarmSceneMaterials(scene);
    const rejected = expect(done).rejects.toThrow("loading deadline");
    await vi.advanceTimersByTimeAsync(SCENE_SHADER_WARM_TIMEOUT_MS);
    await rejected;
    finishCompile();
    await Promise.resolve();
    expect(nextCompile).not.toHaveBeenCalled();
    scene.dispose();
    engine.dispose();
    vi.useRealTimers();
  });
});
