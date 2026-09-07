import { afterEach, describe, expect, it } from "vitest";
import {
  InputBlock,
  Mesh,
  NullEngine,
  Scene,
  Texture,
  TextureBlock,
} from "@babylonjs/core";
import {
  createDefaultMaterialDocument,
  lowerMaterialDocument,
} from "@babylonslate/shader-graph";
import { compileMaterialPlan } from "./material-compiler";
import { MaterialLibrary } from "./material-library";
import * as snapshots from "./snapshot-apply";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

function host() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  disposers.push(() => {
    scene.dispose();
    engine.dispose();
  });
  return scene;
}

function parameterDocument() {
  const doc = createDefaultMaterialDocument();
  doc.nodes.push({
    id: "roughness",
    type: "param.float",
    position: { x: 0, y: 0 },
    properties: { name: "Roughness", value: [0.5] },
  });
  doc.edges.push({
    id: "roughness-out",
    sourceNodeId: "roughness",
    sourcePinId: "out",
    targetNodeId: "output",
    targetPinId: "roughness",
  });
  return doc;
}

describe("material parameter bindings", () => {
  it("validates pending writes against authored parameter names and types", () => {
    const library = new MaterialLibrary();
    const doc = parameterDocument();
    expect(
      library.acceptsParameter(doc, "Roughness", {
        kind: "float",
        value: 0.8,
      }),
    ).toBe(true);
    expect(
      library.acceptsParameter(doc, "Roughness", {
        kind: "color",
        value: [1, 0, 0, 1],
      }),
    ).toBe(false);
    expect(
      library.acceptsParameter(doc, "Roughness", {
        kind: "float",
        value: Infinity,
      }),
    ).toBe(false);
    expect(
      library.acceptsParameter(doc, "Missing", { kind: "float", value: 0.8 }),
    ).toBe(false);
  });
  it("recompiles saved values for the same asset and retains the last good material on invalid edits", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const doc = parameterDocument();
    const before = library.resolve(scene, "mat", doc)!;
    const edited = parameterDocument();
    edited.nodes.find((node) => node.id === "roughness")!.properties.value = [
      0.8,
    ];
    const after = library.resolve(scene, "mat", edited)!;
    expect(after).not.toBe(before);
    expect(after.getBlockByName("roughness")).toMatchObject({ value: 0.8 });
    const invalid = { ...edited, nodes: [] };
    expect(library.resolve(scene, "mat", invalid)).toBe(after);
  });
  it("keeps RGBA color values mutable while exposing RGB to the surface shader", () => {
    const scene = host();
    const doc = createDefaultMaterialDocument();
    doc.nodes[0] = {
      ...doc.nodes[0]!,
      type: "param.color",
      properties: { name: "Tint", value: [1, 0, 0, 0.4] },
    };
    doc.edges[0]!.sourcePinId = "rgb";
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("Invalid fixture");
    const compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: "color",
    });
    if (!compiled.ok) throw new Error("Compile failed");
    disposers.push(compiled.dispose);
    const pbr = compiled.material.getBlockByName(
      "color_pbr",
    ) as import("@babylonjs/core").PBRMetallicRoughnessBlock;
    expect(pbr.baseColor.connectedPoint?.ownerBlock.getClassName()).toBe(
      "VectorSplitterBlock",
    );
    expect(
      compiled.setParameter("Tint", {
        kind: "color",
        value: [0.1, 0.2, 0.3, 0.6],
      }),
    ).toBe(true);
    const input = compiled.material.getBlockByName("baseColor") as InputBlock;
    expect(input.value.asArray()).toEqual([0.1, 0.2, 0.3, 0.6]);
  });
  it("updates a named float uniform and rejects missing names and mismatched types", () => {
    const scene = host();
    const lowered = lowerMaterialDocument(parameterDocument());
    if (!lowered.ok) throw new Error("Invalid fixture");
    const compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: "parameters",
    });
    if (!compiled.ok) throw new Error("Compile failed");
    disposers.push(compiled.dispose);
    expect(
      compiled.setParameter("Roughness", { kind: "float", value: 0.8 }),
    ).toBe(true);
    const input = compiled.material.getBlockByName("roughness") as InputBlock;
    expect(input.value).toBe(0.8);
    expect(
      compiled.setParameter("Missing", { kind: "float", value: 0.1 }),
    ).toBe(false);
    expect(
      compiled.setParameter("Roughness", {
        kind: "texture",
        textureAssetGuid: null,
      }),
    ).toBe(false);
    expect(
      compiled.setParameter("Roughness", { kind: "float", value: NaN }),
    ).toBe(false);
    expect(input.value).toBe(0.8);
    compiled.dispose();
    expect(
      compiled.setParameter("Roughness", { kind: "float", value: 0.1 }),
    ).toBe(false);
  });

  it("isolates parameter changes by material instance while preserving shared defaults", () => {
    const scene = host();
    const library = new MaterialLibrary();
    disposers.push(() => library.dispose());
    const doc = parameterDocument();
    const shared = library.acquire(scene, "mat", doc);
    const first = library.acquire(scene, "mat", doc, { instanceKey: "1|body" });
    const second = library.acquire(scene, "mat", doc, {
      instanceKey: "2|body",
    });
    if (!shared.ok || !first.ok || !second.ok)
      throw new Error("Compile failed");
    expect(first.material).not.toBe(shared.material);
    expect(
      library.setParameter(
        scene,
        "mat",
        "Roughness",
        { kind: "float", value: 0.9 },
        { instanceKey: "1|body" },
      ),
    ).toBe(true);
    expect(
      (first.material.getBlockByName("roughness") as InputBlock).value,
    ).toBe(0.9);
    expect(
      (second.material.getBlockByName("roughness") as InputBlock).value,
    ).toBe(0.5);
    expect(
      (shared.material.getBlockByName("roughness") as InputBlock).value,
    ).toBe(0.5);
    library.releaseInstance("1|body");
    expect(
      library.materialFor(scene, "mat", { instanceKey: "1|body" }),
    ).toBeNull();
    expect(library.materialFor(scene, "mat")).toBe(shared.material);
  });

  it("rebinds texture samples by parameter name without disposing cached textures", () => {
    const scene = host();
    const first = new Texture(null, scene);
    const second = new Texture(null, scene);
    const doc = parameterDocument();
    doc.nodes.push(
      {
        id: "texture",
        type: "param.texture",
        position: { x: 0, y: 0 },
        properties: { name: "Albedo", textureGuid: "first" },
      },
      {
        id: "sample",
        type: "texture.sample",
        position: { x: 0, y: 0 },
        properties: {},
      },
    );
    doc.edges = doc.edges.filter((edge) => edge.id !== "e-color-output");
    doc.edges.push(
      {
        id: "texture-sample",
        sourceNodeId: "texture",
        sourcePinId: "out",
        targetNodeId: "sample",
        targetPinId: "texture",
      },
      {
        id: "sample-output",
        sourceNodeId: "sample",
        sourcePinId: "rgb",
        targetNodeId: "output",
        targetPinId: "baseColor",
      },
    );
    const lowered = lowerMaterialDocument(doc);
    if (!lowered.ok) throw new Error("Invalid fixture");
    const compiled = compileMaterialPlan(lowered.plan, {
      scene,
      name: "textures",
      resolveTexture: (guid) =>
        guid === "first" ? first : guid === "second" ? second : null,
    });
    if (!compiled.ok) throw new Error("Compile failed");
    disposers.push(compiled.dispose);
    expect(
      compiled.setParameter("Albedo", {
        kind: "texture",
        textureAssetGuid: "second",
      }),
    ).toBe(true);
    const sample = compiled.material.getBlockByName("sample") as TextureBlock;
    expect(sample.texture).toBe(second);
    expect(
      compiled.setParameter("Albedo", {
        kind: "texture",
        textureAssetGuid: "missing",
      }),
    ).toBe(false);
    expect(sample.texture).toBe(second);
    expect(
      compiled.setParameter("Albedo", {
        kind: "texture",
        textureAssetGuid: null,
      }),
    ).toBe(true);
    // On WebGL a null TextureBlock skips binding and can leave the prior sampler active.
    let bound: Texture | null = second;
    sample.bind({
      getEngine: () => scene.getEngine(),
      setFloat: () => undefined,
      setMatrix: () => undefined,
      setTexture: (_name: string, value: Texture) => {
        bound = value;
      },
    } as unknown as import("@babylonjs/core").Effect);
    expect(bound).not.toBe(second);
    expect(bound).not.toBeNull();
    expect(bound!.getSize()).toMatchObject({ width: 1, height: 1 });
  });
});

describe("runtime material parameters", () => {
  function setup() {
    const scene = host();
    const library = new MaterialLibrary();
    const binding = snapshots.createSnapshotSceneBinding();
    const doc = parameterDocument();
    binding.resolveMaterial = (guid, options) =>
      library.resolve(options?.scene ?? scene, guid, doc, options);
    binding.releaseMaterialInstance = (key) => library.releaseInstance(key);
    binding.validateMaterialParameter = (_guid, name, value) =>
      library.acceptsParameter(doc, name, value);
    disposers.push(() => library.dispose());
    return { scene, binding, library };
  }

  it("replays values set before spawning and rebuilding a mesh without changing a sibling", () => {
    const { scene, binding } = setup();
    for (const slotId of [1, 2])
      snapshots.applyAssignMaterial(scene, binding, {
        type: "assignMaterial",
        slotId,
        materialAssetGuid: "mat",
      });
    snapshots.applySetMaterialParameter(binding, {
      type: "setMaterialParameter",
      slotId: 1,
      materialAssetGuid: "mat",
      parameterName: "Roughness",
      parameter: { kind: "float", value: 0.7 },
    });
    for (const slotId of [1, 2]) {
      snapshots.applyAssignMesh(scene, binding, {
        type: "assignMesh",
        slotId,
        meshKind: "box",
        meshAssetGuid: null,
      });
    }
    const first = binding.meshes.get(1)!.material!;
    const second = binding.meshes.get(2)!.material!;
    expect(first).not.toBe(second);
    expect(
      (first as import("@babylonjs/core").NodeMaterial).getBlockByName(
        "roughness",
      ),
    ).toMatchObject({ value: 0.7 });
    expect(
      (second as import("@babylonjs/core").NodeMaterial).getBlockByName(
        "roughness",
      ),
    ).toMatchObject({ value: 0.5 });
    snapshots.applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshKind: "sphere",
      meshAssetGuid: null,
    });
    expect(binding.meshes.get(1)!.material).toBe(first);
    snapshots.retirePlaySlot(binding, 1);
    expect(binding.materialParameters.size).toBe(0);
  });

  it("targets imported descendants of one component and discards updates for replaced materials", () => {
    const { scene, binding, library } = setup();
    const root = new Mesh("actor-1", scene);
    const body = new Mesh("actor-1|body", scene);
    const imported = new Mesh("Imported Model Mesh", scene);
    const hat = new Mesh("actor-1|hat", scene);
    body.parent = root;
    imported.parent = body;
    hat.parent = root;
    binding.meshes.set(1, root);
    for (const componentId of ["body", "hat"])
      snapshots.applyAssignMaterial(scene, binding, {
        type: "assignMaterial",
        slotId: 1,
        componentId,
        materialAssetGuid: "mat",
      });
    snapshots.applySetMaterialParameter(binding, {
      type: "setMaterialParameter",
      slotId: 1,
      componentId: "body",
      materialAssetGuid: "mat",
      parameterName: "Roughness",
      parameter: { kind: "float", value: 0.2 },
    });
    expect(imported.material).toBe(body.material);
    expect(body.material).not.toBe(hat.material);
    snapshots.applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      componentId: "body",
      materialAssetGuid: "replacement",
    });
    snapshots.applySetMaterialParameter(binding, {
      type: "setMaterialParameter",
      slotId: 1,
      componentId: "body",
      materialAssetGuid: "mat",
      parameterName: "Roughness",
      parameter: { kind: "float", value: 0.9 },
    });
    expect(binding.materialParameters.size).toBe(0);
    expect(
      library.materialFor(scene, "mat", { instanceKey: "1|body" }),
    ).toBeNull();
    expect(
      (body.material as import("@babylonjs/core").NodeMaterial).getBlockByName(
        "roughness",
      ),
    ).toMatchObject({ value: 0.5 });
  });

  it("clears a private instance from the mesh when its material assignment is removed", () => {
    const { scene, binding } = setup();
    snapshots.applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshKind: "box",
      meshAssetGuid: null,
    });
    snapshots.applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: "mat",
    });
    snapshots.applySetMaterialParameter(binding, {
      type: "setMaterialParameter",
      slotId: 1,
      materialAssetGuid: "mat",
      parameterName: "Roughness",
      parameter: { kind: "float", value: 0.2 },
    });
    snapshots.applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: null,
    });
    expect(binding.meshes.get(1)!.material).toBeNull();
    expect(binding.materialParameters.size).toBe(0);
  });

  it("retains the last valid value after a rejected write and material recompilation", () => {
    const { scene, binding, library } = setup();
    snapshots.applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshKind: "box",
      meshAssetGuid: null,
    });
    snapshots.applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: "mat",
    });
    const command = {
      type: "setMaterialParameter" as const,
      slotId: 1,
      materialAssetGuid: "mat",
      parameterName: "Roughness",
    };
    snapshots.applySetMaterialParameter(binding, {
      ...command,
      parameter: { kind: "float", value: 0.8 },
    });
    snapshots.applySetMaterialParameter(binding, {
      ...command,
      parameter: { kind: "color", value: [1, 0, 0, 1] },
    });
    library.invalidate();
    snapshots.applyMaterialToActorMeshes(binding, 1, binding.meshes.get(1)!);
    expect(
      (
        binding.meshes.get(1)!
          .material as import("@babylonjs/core").NodeMaterial
      ).getBlockByName("roughness"),
    ).toMatchObject({ value: 0.8 });
  });
});
