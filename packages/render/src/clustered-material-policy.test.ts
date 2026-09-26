import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LightBlock,
  Mesh,
  MeshBuilder,
  MultiMaterial,
  NodeMaterial,
  NullEngine,
  PBRMaterial,
  PointLight,
  Scene,
  ShaderMaterial,
  Vector3,
} from "@babylonjs/core";
import {
  clusteredSceneMaterialReason,
  registerClusteredSurfaceMaterial,
  registerClusteredUnlitMaterial,
} from "./clustered-material-policy";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.restoreAllMocks();
});

function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const material = new PBRMaterial("surface", scene);
  const mesh = MeshBuilder.CreateBox("mesh", {}, scene);
  mesh.material = material;
  return { scene, material, mesh };
}

describe("clustered material consumers", () => {
  it("does not revisit meshes in an unchanged compatible scene", () => {
    const { scene, mesh } = fixture();
    const meshes = [
      mesh,
      ...Array.from({ length: 31 }, (_, i) => mesh.clone(`copy-${i}`)),
    ];
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    const reads = meshes.flatMap((entry) => [
      vi.spyOn(entry, "material", "get"),
      vi.spyOn(entry, "getTotalVertices"),
    ]);
    for (let frame = 0; frame < 3; frame++)
      expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    for (const read of reads) expect(read).not.toHaveBeenCalled();
  });

  it("tracks immediate additions, assignments, and equal-count mesh replacement", () => {
    const { scene, material } = fixture();
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    const rejected = new ShaderMaterial("custom", scene, {}, {});
    const added = MeshBuilder.CreateBox("added", {}, scene);
    added.material = material;
    // Both queries precede Babylon's deferred added notification.
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    added.material = rejected;
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "custom"');
    scene.removeMesh(added);
    const replacement = MeshBuilder.CreateBox("replacement", {}, scene);
    replacement.material = material;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    added.dispose();
  });

  it("keeps the first drawable rejection in scene order as existing geometry is attached and removed", () => {
    const { scene, mesh } = fixture();
    mesh.dispose();
    const a = new ShaderMaterial("A", scene, {}, {});
    const b = new ShaderMaterial("B", scene, {}, {});
    const empty = new Mesh("empty", scene);
    empty.material = a;
    const first = MeshBuilder.CreateBox("first", {}, scene);
    first.material = b;
    const last = MeshBuilder.CreateBox("last", {}, scene);
    last.material = a;
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "B"');
    last.geometry!.applyToMesh(empty);
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "A"');
    last.geometry!.releaseForMesh(empty);
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "B"');
    first.dispose();
    a.name = "Renamed";
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "Renamed"');
    last.dispose();
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
  });

  it("observes inherited instance assignments and releases detached source observers", () => {
    const { scene, mesh, material } = fixture();
    const instance = mesh.createInstance("instance");
    scene.removeMesh(mesh);
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    mesh.material = new ShaderMaterial("instance source", scene, {}, {});
    expect(clusteredSceneMaterialReason(scene)).toContain(
      'Material "instance source"',
    );
    mesh.material = material;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    instance.dispose();
    expect(mesh.onMaterialChangedObservable.hasObservers()).toBe(false);
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    mesh.dispose();
  });

  it("reads the live default material and lighting switch", () => {
    const { scene, mesh } = fixture();
    mesh.material = null;
    const fallback = scene.defaultMaterial;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    scene.defaultMaterial = new ShaderMaterial("default custom", scene, {}, {});
    expect(clusteredSceneMaterialReason(scene)).toContain(
      'Material "default custom"',
    );
    scene.lightsEnabled = false;
    expect(clusteredSceneMaterialReason(scene)).toContain(
      "does not use lighting",
    );
    scene.lightsEnabled = true;
    scene.defaultMaterial = fallback;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
  });

  it("rechecks child materials and native features without an assignment event", () => {
    const { scene, mesh, material } = fixture();
    const multi = new MultiMaterial("multi", scene);
    multi.subMaterials = [material];
    mesh.material = multi;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    multi.subMaterials[0] = new ShaderMaterial("child", scene, {}, {});
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "multi"');
    multi.subMaterials = [material];
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    material.clearCoat.isEnabled = true;
    expect(clusteredSceneMaterialReason(scene)).toContain("Clear Coat");
    material.clearCoat.isEnabled = false;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
  });

  it("rechecks shader callbacks and owned unlit registration", () => {
    const { scene, mesh, material } = fixture();
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    const binding = material.onBindObservable.add(() => {});
    expect(clusteredSceneMaterialReason(scene)).toContain(
      "no supported clustered lighting contract",
    );
    material.onBindObservable.remove(binding);
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    const resolver = material.customShaderNameResolve;
    material.customShaderNameResolve = () => "custom";
    expect(clusteredSceneMaterialReason(scene)).toContain(
      "no supported clustered lighting contract",
    );
    material.customShaderNameResolve = resolver;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    const helper = new ShaderMaterial("helper", scene, {}, {});
    mesh.material = helper;
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "helper"');
    registerClusteredUnlitMaterial(helper);
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
  });

  it("requires fresh provenance after graph rebuilds and rechecks per-light blocks", async () => {
    const { scene, mesh } = fixture();
    const graph = new NodeMaterial("graph", scene);
    graph.setToDefault();
    const build = async () => {
      const built = new Promise<void>((resolve) =>
        graph.onBuildObservable.addOnce(() => resolve()),
      );
      graph.build();
      await built;
    };
    await build();
    mesh.material = graph;
    registerClusteredSurfaceMaterial(graph);
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    await build();
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "graph"');
    registerClusteredSurfaceMaterial(graph);
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    const block = new LightBlock("bound light");
    graph.attachedBlocks.push(block);
    block.light = new PointLight("light", Vector3.Zero(), scene);
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "graph"');
    block.light = null;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
  });
});
