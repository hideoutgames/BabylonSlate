import { afterEach, describe, expect, it } from "vitest";
import {
  InputBlock,
  Mesh,
  NodeMaterial,
  NullEngine,
  Scene,
} from "@babylonjs/core";
import type { CommandMessage } from "@babylonslate/bridge";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import { MaterialLibrary } from "./material-library";
import {
  applyAssignMaterial,
  applyAssignMesh,
  applySetMaterialParameter,
  createSnapshotSceneBinding,
} from "./snapshot-apply";

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});

function setup() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const library = new MaterialLibrary();
  const binding = createSnapshotSceneBinding();
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
  binding.resolveMaterial = (guid, options) =>
    library.resolve(options?.scene ?? scene, guid, doc, options);
  binding.releaseMaterialInstance = (key) => library.releaseInstance(key);
  disposers.push(() => {
    library.dispose();
    scene.dispose();
    engine.dispose();
  });
  const assign = (id: string, guid: string | null = "mat") =>
    applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      componentId: id,
      materialAssetGuid: guid,
    });
  const set = (id: string, value: number) =>
    applySetMaterialParameter(binding, {
      type: "setMaterialParameter",
      slotId: 1,
      componentId: id,
      materialAssetGuid: "mat",
      parameterName: "Roughness",
      parameter: { kind: "float", value },
    });
  const single = (id: string) => {
    const command: Extract<CommandMessage, { type: "assignMesh" }> & {
      primaryComponentId: string;
    } = {
      type: "assignMesh",
      slotId: 1,
      meshKind: "box",
      meshAssetGuid: null,
      primaryComponentId: id,
    };
    applyAssignMesh(scene, binding, command);
  };
  const parts = (...ids: string[]) =>
    applyAssignMesh(scene, binding, {
      type: "assignMesh",
      slotId: 1,
      meshKind: "box",
      meshAssetGuid: null,
      parts: ids.map((componentId) => ({
        componentId,
        meshKind: "box",
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      })),
    });
  return { scene, binding, library, assign, set, single, parts };
}

function roughness(mesh: Mesh): number {
  expect(mesh.material).toBeInstanceOf(NodeMaterial);
  return (
    (mesh.material as NodeMaterial).getBlockByName("roughness") as InputBlock
  ).value as number;
}

describe("runtime material component identity", () => {
  it("preserves a surviving component through single/multiple/single rebuilds and releases removed instances", () => {
    const { scene, binding, library, assign, set, single, parts } = setup();
    single("body");
    assign("body");
    set("body", 0.2);
    const first = binding.meshes.get(1)!.material;
    expect(roughness(binding.meshes.get(1)!)).toBe(0.2);
    parts("body", "hat");
    assign("body");
    assign("hat");
    set("hat", 0.8);
    const body = scene.getMeshByName("actor-1|body") as Mesh;
    const hat = scene.getMeshByName("actor-1|hat") as Mesh;
    expect(body.material).toBe(first);
    expect(roughness(body)).toBe(0.2);
    expect(roughness(hat)).toBe(0.8);
    single("body");
    assign("body");
    expect(binding.meshes.get(1)!.material).toBe(first);
    expect(roughness(binding.meshes.get(1)!)).toBe(0.2);
    expect(
      library.materialFor(scene, "mat", { instanceKey: "1|hat" }),
    ).toBeNull();
    expect(binding.componentMaterialGuids.has("1|hat")).toBe(false);
    expect(binding.materialParameters.has("1|hat")).toBe(false);
    set("hat", 0.9);
    expect(binding.materialParameters.has("1|hat")).toBe(false);
  });

  it("clears an explicit assignment without detaching a sibling's shared material", () => {
    const { scene, binding, assign, single } = setup();
    single("body");
    assign("body");
    const shared = binding.meshes.get(1)!.material;
    expect(shared).toBeInstanceOf(NodeMaterial);
    const sibling = new Mesh("sibling", scene);
    sibling.material = shared;
    assign("body", null);
    expect(binding.meshes.get(1)!.material).toBeNull();
    expect(sibling.material).toBe(shared);
    expect(scene.materials).toContain(shared);
  });

  it("retains compatibility with legacy whole-actor assignment commands", () => {
    const { scene, binding, single } = setup();
    single("body");
    applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: "mat",
    });
    expect(roughness(binding.meshes.get(1)!)).toBe(0.5);
    applySetMaterialParameter(binding, {
      type: "setMaterialParameter",
      slotId: 1,
      materialAssetGuid: "mat",
      parameterName: "Roughness",
      parameter: { kind: "float", value: 0.3 },
    });
    expect(roughness(binding.meshes.get(1)!)).toBe(0.3);
    applyAssignMaterial(scene, binding, {
      type: "assignMaterial",
      slotId: 1,
      materialAssetGuid: null,
    });
    expect(binding.meshes.get(1)!.material).toBeNull();
  });
});
