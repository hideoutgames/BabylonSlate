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
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { CreateGreasedLine } from "@babylonjs/core/Meshes/Builders/greasedLineBuilder";
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
  it("reuses compatible assignments without allocating a default for empty proxies", () => {
    const { scene, mesh } = fixture();
    const materials = [...scene.materials];
    const meshes = [
      mesh,
      ...Array.from({ length: 31 }, (_, i) => mesh.clone(`copy-${i}`)),
    ];
    new Mesh("empty proxy", scene);
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    const reads = meshes.flatMap((entry) => [
      vi.spyOn(entry, "material", "get"),
      vi.spyOn(entry, "getTotalVertices"),
    ]);
    for (let frame = 0; frame < 3; frame++)
      expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(scene.materials).toEqual(materials);
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

  it("keeps watching existing meshes across later additions and removals", () => {
    const { scene, mesh, material } = fixture();
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    const later = MeshBuilder.CreateBox("later", {}, scene);
    later.material = material;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    const removed = MeshBuilder.CreateBox("removed", {}, scene);
    removed.material = material;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    removed.dispose();
    expect(removed.onMaterialChangedObservable.hasObservers()).toBe(false);
    // The original and the earlier addition still notify after churn around them.
    mesh.material = new ShaderMaterial("original custom", scene, {}, {});
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "original custom"');
    mesh.material = material;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    later.material = new ShaderMaterial("later custom", scene, {}, {});
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "later custom"');
  });

  it("keeps a shared instance source observed until its last instance leaves", () => {
    const { scene, mesh, material } = fixture();
    const first = mesh.createInstance("first");
    const second = mesh.createInstance("second");
    scene.removeMesh(mesh);
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    first.dispose();
    expect(mesh.onMaterialChangedObservable.hasObservers()).toBe(true);
    mesh.material = new ShaderMaterial("shared source", scene, {}, {});
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "shared source"');
    mesh.material = material;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    second.dispose();
    expect(mesh.onMaterialChangedObservable.hasObservers()).toBe(false);
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

  it("admits Babylon's light-free line program but not other materials on lines", () => {
    const { scene, mesh } = fixture();
    const points = [Vector3.Zero(), Vector3.Up()];
    const lines = MeshBuilder.CreateLines("lines", { points }, scene);
    MeshBuilder.CreateDashedLines("dashed", { points, dashNb: 4 }, scene);
    MeshBuilder.CreateLineSystem("system", { lines: [points, points] }, scene);
    lines.createInstance("instance");
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    // The program decides, not the name: a lookalike that runs its own shader stays rejected.
    mesh.material = new ShaderMaterial("colorShader", scene, { vertex: "custom", fragment: "custom" }, {});
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "colorShader"');
    mesh.material = null;
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    lines.material = new ShaderMaterial("custom lines", scene, {}, {});
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "custom lines"');
    lines.material = null;
    // GreasedLine's default is a lit StandardMaterial plus a plugin, not the color program.
    CreateGreasedLine("thick", { points }, { createAndAssignMaterial: true }, scene);
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "thick"');
  });

  it("lets only meshes that draw select Forward, rechecking enabled and visible state live", () => {
    const { scene, mesh } = fixture();
    mesh.material = new ShaderMaterial("custom", scene, {}, {});
    const rejected = () => clusteredSceneMaterialReason(scene);
    expect(rejected()).toContain('Material "custom"');
    mesh.setEnabled(false);
    expect(rejected()).toBeUndefined();
    mesh.setEnabled(true);
    expect(rejected()).toContain('Material "custom"');
    mesh.isVisible = false;
    expect(rejected()).toBeUndefined();
    mesh.isVisible = true;
    mesh.visibility = 0;
    expect(rejected()).toBeUndefined();
    mesh.visibility = 1;
    expect(rejected()).toContain('Material "custom"');
    const parent = new TransformNode("parent", scene);
    mesh.parent = parent;
    parent.setEnabled(false);
    expect(rejected()).toBeUndefined();
    parent.setEnabled(true);
    expect(rejected()).toContain('Material "custom"');
  });

  it("counts an enabled instance of a disabled source and a disabled LOD level as drawing", () => {
    const { scene, mesh, material } = fixture();
    mesh.material = new ShaderMaterial("custom", scene, {}, {});
    const instance = mesh.createInstance("instance");
    mesh.setEnabled(false);
    // An instance renders through its source even while the source itself is off.
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "custom"');
    instance.setEnabled(false);
    expect(clusteredSceneMaterialReason(scene)).toBeUndefined();
    // A LOD level draws in place of its master, whatever its own enabled state.
    const master = MeshBuilder.CreateBox("master", {}, scene);
    master.material = material;
    const level = MeshBuilder.CreateBox("level", {}, scene);
    level.material = new ShaderMaterial("level custom", scene, {}, {});
    master.addLODLevel(10, level);
    level.setEnabled(false);
    expect(clusteredSceneMaterialReason(scene)).toContain('Material "level custom"');
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
