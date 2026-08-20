import { afterEach, describe, expect, it } from "vitest";
import { NodeMaterial, NodeMaterialModes, NullEngine, Scene } from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
} from "@babylonslate/core";
import {
  applyEditorMaterialFreeze,
  isStructuralEditorChange,
  materialLibraryAssetGuid,
} from "./scene-perf";

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
