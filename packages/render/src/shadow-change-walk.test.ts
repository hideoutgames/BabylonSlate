import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { Mesh as BabylonMesh, type Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
// Registers thin instances, which the fixture adds.
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { noteRenderChange, openRenderChangeReader, RenderChange, verifyRenderChangeJournal } from "./render-change-journal";
import { ShadowMapRefresh } from "./shadow-map-refresh";

const engines: NullEngine[] = [];
afterEach(() => {
  verifyRenderChangeJournal(false);
  for (const engine of engines.splice(0)) engine.dispose();
});

function placements(count: number, offset = 0): Float32Array {
  const data = new Float32Array(16 * count);
  for (let index = 0; index < count; index++) Matrix.Translation(index * 2 + offset, 0, 0).copyToArray(data, index * 16);
  return data;
}

/**
 * A Scene of casters with every kind of change the walk follows: a mesh of its own, one under two transform nodes, one
 * with a frozen world matrix, a source with an instance, and thin instances. `sync` runs a frame's walk (a new render
 * id, so Babylon recomputes what moved) and reports what it walked and which casters' revisions it bumped.
 */
function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  scene.activeCamera = new UniversalCamera("camera", new Vector3(0, 2, -10), scene);
  const shared = new StandardMaterial("shared", scene);
  const other = new StandardMaterial("other", scene);
  const own = MeshBuilder.CreateBox("own", {}, scene);
  const grand = new TransformNode("grand", scene);
  const parent = new TransformNode("parent", scene);
  parent.parent = grand;
  const child = MeshBuilder.CreateBox("child", {}, scene);
  child.parent = parent;
  const frozen = MeshBuilder.CreateBox("frozen", {}, scene);
  const pose = Matrix.Translation(3, 0, 0);
  frozen.freezeWorldMatrix(pose);
  const source = MeshBuilder.CreateBox("source", {}, scene);
  const instance = source.createInstance("instance");
  const thin = MeshBuilder.CreateBox("thin", {}, scene);
  thin.thinInstanceSetBuffer("matrix", placements(2), 16, true);
  for (const mesh of [own, child, frozen, source, thin]) mesh.material = shared;
  const casters = new Set<AbstractMesh>([own, child, frozen, source, instance, thin]);
  const refresh = new ShadowMapRefresh();
  const named = { own, child, frozen, source, instance, thin } as Record<string, AbstractMesh>;
  const revisions = () => new Map([...casters].map((mesh) => [mesh, refresh.casterState(mesh)?.revision]));
  const sync = () => {
    const before = refresh.journalDiagnostics();
    const was = revisions();
    scene.incrementRenderId();
    refresh.syncCasters(scene, casters);
    const after = refresh.journalDiagnostics();
    const bumped = Object.keys(named).filter((name) => casters.has(named[name]!) && refresh.casterState(named[name]!)?.revision !== was.get(named[name]!));
    return {
      visited: after.visited - before.visited, moved: after.moved - before.moved, mismatches: after.mismatches - before.mismatches,
      bumped, missed: after.missedKinds,
    };
  };
  sync();
  return { scene, shared, other, own, grand, parent, child, frozen, pose, source, instance: instance as InstancedMesh, thin: thin as Mesh, casters, refresh, sync };
}

describe("the shadow caster walk of the change journal", () => {
  beforeEach(() => verifyRenderChangeJournal(true));

  it("walks no caster and bumps no revision when nothing changed", () => {
    const { sync } = fixture();
    expect(sync()).toEqual({ visited: 0, moved: 0, mismatches: 0, bumped: [], missed: [] });
    expect(sync()).toEqual({ visited: 0, moved: 0, mismatches: 0, bumped: [], missed: [] });
  });

  // Each change walks the casters it reaches, bumps their revisions as the full walk then agrees (no mismatch), and
  // walks no other caster. A caster that only moved reads its world matrix alone (`moved`), with the same result.
  it.each([
    ["its own move", (f: ReturnType<typeof fixture>) => { f.own.position.x += 1; }, ["own"]],
    ["a parent transform node's move", (f: ReturnType<typeof fixture>) => { f.parent.position.y += 1; }, ["child"]],
    ["a grandparent's move", (f: ReturnType<typeof fixture>) => { f.grand.rotation.y += 0.5; }, ["child"]],
    ["a new frozen matrix", (f: ReturnType<typeof fixture>) => { f.frozen.freezeWorldMatrix(Matrix.Translation(4, 0, 0)); }, ["frozen"]],
    ["its frozen matrix rewritten in place", (f: ReturnType<typeof fixture>) => { f.pose.setTranslationFromFloats(5, 0, 0); }, ["frozen"]],
  ] as const)("reads only the world matrix of a caster after %s", (_name, change, expected) => {
    const f = fixture();
    change(f);
    expect(f.sync()).toEqual({ visited: 0, moved: expected.length, mismatches: 0, bumped: expected, missed: [] });
    expect(f.sync()).toMatchObject({ visited: 0, moved: 0, bumped: [] });
  });

  it("reads a moved caster in full when something else changed it too, and bumps nothing for a recompute to the same pose", () => {
    const f = fixture();
    f.own.position.x += 1;
    f.own.isVisible = false;
    expect(f.sync()).toMatchObject({ visited: 1, moved: 0, mismatches: 0, bumped: ["own"] });
    expect(f.refresh.casterState(f.own)!.shown).toBe(false);
    f.own.computeWorldMatrix(true);
    expect(f.sync()).toMatchObject({ visited: 0, moved: 1, mismatches: 0, bumped: [] });
  });

  it.each([
    ["its own isVisible", (f: ReturnType<typeof fixture>) => { f.own.isVisible = false; }, ["own"]],
    ["its visibility", (f: ReturnType<typeof fixture>) => { f.own.visibility = 0.5; }, ["own"]],
    ["its source's visibility, for an instance", (f: ReturnType<typeof fixture>) => { f.source.visibility = 0.5; }, ["source", "instance"]],
    ["its own enabled state", (f: ReturnType<typeof fixture>) => { f.own.setEnabled(false); }, ["own"]],
    ["an ancestor's enabled state", (f: ReturnType<typeof fixture>) => { f.grand.setEnabled(false); }, ["child"]],
    ["a Material swap", (f: ReturnType<typeof fixture>) => { f.own.material = f.other; }, ["own"]],
    ["its source's Material swap, for an instance", (f: ReturnType<typeof fixture>) => { f.source.material = f.other; }, ["source", "instance"]],
    ["a Material depth property", (f: ReturnType<typeof fixture>) => { f.shared.zOffset = 2; }, ["own", "child", "frozen", "source", "instance", "thin"]],
    ["a Material transparency mode", (f: ReturnType<typeof fixture>) => { f.shared.transparencyMode = 2; }, ["own", "child", "frozen", "source", "instance", "thin"]],
    ["a geometry update", (f: ReturnType<typeof fixture>) => {
      const positions = f.own.getVerticesData(VertexBuffer.PositionKind)!.map((value) => value * 2);
      f.own.setVerticesData(VertexBuffer.PositionKind, positions);
    }, ["own"]],
    ["a sub-mesh range", (f: ReturnType<typeof fixture>) => { f.own.subMeshes[0]!.indexCount -= 3; }, ["own"]],
    ["its source's sub-mesh range, for an instance", (f: ReturnType<typeof fixture>) => { f.source.subMeshes[0]!.indexCount -= 3; }, ["source", "instance"]],
    ["a thin-instance count", (f: ReturnType<typeof fixture>) => { f.thin.thinInstanceCount = 1; }, ["thin"]],
    ["a new thin-instance buffer", (f: ReturnType<typeof fixture>) => { f.thin.thinInstanceSetBuffer("matrix", placements(2, 1), 16, true); }, ["thin"]],
    ["vertex alpha on its source", (f: ReturnType<typeof fixture>) => { f.own.hasVertexAlpha = true; }, ["own"]],
  ] as const)("follows %s", (_name, change, expected) => {
    const f = fixture();
    change(f);
    const step = f.sync();
    expect(step.bumped).toEqual(expected);
    expect(step.mismatches).toBe(0);
    expect(step.missed).toEqual([]);
    expect(step.visited).toBe(expected.length);
    expect(f.sync()).toMatchObject({ visited: 0, moved: 0, bumped: [] });
  });

  it("reads which buffers are updatable only after one was replaced or removed, which no geometry update notifies", () => {
    const f = fixture();
    verifyRenderChangeJournal(false);
    const checks = () => f.refresh.journalDiagnostics().bufferChecks;
    let before = checks();
    f.sync();
    expect(checks()).toBe(before);
    // An updatable extra buffer: its owner may rewrite it in place, so the caster is no longer cached.
    f.own.setVerticesData(VertexBuffer.ColorKind, new Float32Array(4 * f.own.getTotalVertices()).fill(1), true);
    before = checks();
    expect(f.sync()).toMatchObject({ bumped: ["own"] });
    expect(checks()).toBe(before + 1);
    expect(f.refresh.casterState(f.own)!.safe).toBe(false);
    // Removing it notifies nothing: its write point is Geometry.removeVerticesData.
    f.own.removeVerticesData(VertexBuffer.ColorKind);
    expect(f.sync()).toMatchObject({ bumped: ["own"] });
    expect(f.refresh.casterState(f.own)!.safe).toBe(true);
  });

  it("reads a Material's part of the shadow cache policy once a walk for every source drawing it", () => {
    const f = fixture();
    verifyRenderChangeJournal(false);
    const before = f.refresh.journalDiagnostics();
    f.sync();
    const after = f.refresh.journalDiagnostics();
    // Five sources share one Material, none with vertex alpha.
    expect(after.polledSources - before.polledSources).toBe(5);
    expect(after.cacheChecks - before.cacheChecks).toBe(1);
    expect(after.sourceChanges - before.sourceChanges).toBe(0);
  });

  it("follows an instance moved to another source, as an instance pool moves its members", () => {
    const f = fixture();
    const next = MeshBuilder.CreateBox("next", { height: 2 }, f.scene);
    next.material = f.shared;
    // As `instance-pool.ts` moves a member between group sources.
    f.source.removeInstance(f.instance);
    (f.instance as unknown as { _sourceMesh: Mesh })._sourceMesh = next;
    next.addInstance(f.instance);
    f.instance._syncSubMeshes();
    expect(f.sync()).toMatchObject({ visited: 1, bumped: ["instance"], mismatches: 0 });
    next.subMeshes[0]!.indexCount -= 3;
    expect(f.sync()).toMatchObject({ visited: 1, bumped: ["instance"], mismatches: 0 });
  });

  it("follows a billboard mode, whose world matrix Babylon then recomputes every frame", () => {
    const f = fixture();
    f.own.billboardMode = 7;
    expect(f.sync()).toMatchObject({ visited: 1, bumped: ["own"], mismatches: 0 });
    expect(f.sync()).toMatchObject({ visited: 0, moved: 1, bumped: [], mismatches: 0 });
  });

  it("follows visibility inherited through inheritVisibility", () => {
    const f = fixture();
    f.child.inheritVisibility = true;
    expect(f.sync()).toMatchObject({ bumped: [], mismatches: 0 });
    f.parent.isVisible = false;
    expect(f.sync()).toMatchObject({ visited: 1, bumped: ["child"], mismatches: 0 });
    expect(f.refresh.casterState(f.child)!.shown).toBe(false);
    f.grand.isVisible = false;
    // The parent does not inherit: the grandparent's visibility does not reach the child.
    expect(f.sync()).toMatchObject({ visited: 0, bumped: [], mismatches: 0 });
  });

  it("walks a caster added, and forgets one removed", () => {
    const f = fixture();
    const added = MeshBuilder.CreateBox("added", {}, f.scene);
    f.casters.add(added);
    expect(f.sync()).toMatchObject({ visited: 1, mismatches: 0 });
    expect(f.refresh.casterState(added)).toBeDefined();
    f.casters.delete(added);
    expect(f.sync()).toMatchObject({ visited: 0, mismatches: 0 });
    expect(f.refresh.casterState(added)).toBeUndefined();
  });

  it("walks every frame a caster whose class redefines what the journal hooks", () => {
    const f = fixture();
    const proxy = MeshBuilder.CreateBox("proxy", {}, f.scene);
    let shown = true;
    Object.defineProperty(proxy, "isVisible", { get: () => shown, set: (value: boolean) => { shown = value; } });
    f.casters.add(proxy);
    f.sync();
    expect(f.sync()).toMatchObject({ visited: 1, bumped: [] });
    shown = false;
    expect(f.sync()).toMatchObject({ visited: 1, mismatches: 0 });
    expect(f.refresh.casterState(proxy)!.shown).toBe(false);
  });

  it("heals a change no write point reached within the full-walk interval, and names it", () => {
    const f = fixture();
    verifyRenderChangeJournal(false);
    // Babylon's own storage, written past the isVisible setter the journal hooks.
    (f.own as unknown as { _nodeDataStorage: { _isVisible: boolean } })._nodeDataStorage._isVisible = false;
    let frames = 0;
    while (f.refresh.casterState(f.own)!.shown && frames < 64) {
      f.sync();
      frames++;
    }
    expect(frames).toBeLessThanOrEqual(32);
    expect(f.refresh.journalDiagnostics()).toMatchObject({ heals: 1, mismatches: 0, missedKinds: ["isVisible"] });
  });

  it("counts a miss while verifying, every frame", () => {
    const f = fixture();
    (f.own as unknown as { _nodeDataStorage: { _isVisible: boolean } })._nodeDataStorage._isVisible = false;
    expect(f.sync()).toMatchObject({ mismatches: 1, missed: ["isVisible"] });
    expect(f.refresh.casterState(f.own)!.shown).toBe(false);
  });
});

describe("the render change journal", () => {
  it("records nothing for a Scene without a reader", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    const mesh = MeshBuilder.CreateBox("mesh", {}, scene);
    const reader = openRenderChangeReader(scene);
    reader.dispose();
    mesh.isVisible = false;
    noteRenderChange(mesh);
    expect((scene as unknown as { _hapticRenderChanges?: unknown })._hapticRenderChanges).toBeUndefined();
  });

  it("gives each reader every change since its own last drain, once per node with the kinds merged", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    const mesh = MeshBuilder.CreateBox("mesh", {}, scene);
    const other = MeshBuilder.CreateBox("other", {}, scene);
    const read = (reader: ReturnType<typeof openRenderChangeReader>) => {
      const seen: Array<[string, number]> = [];
      expect(reader.drain((node, kinds) => seen.push([node.name, kinds]))).toBe(true);
      return seen;
    };
    const first = openRenderChangeReader(scene);
    mesh.isVisible = false;
    mesh.setEnabled(false);
    const second = openRenderChangeReader(scene);
    other.isVisible = false;
    expect(read(first)).toEqual([["mesh", RenderChange.Visibility | RenderChange.Enabled], ["other", RenderChange.Visibility]]);
    // The second reader opened after the mesh changed.
    mesh.isVisible = true;
    expect(read(second)).toEqual([["other", RenderChange.Visibility], ["mesh", RenderChange.Visibility]]);
    expect(read(first)).toEqual([["mesh", RenderChange.Visibility]]);
    // A write that changes nothing is not a change.
    mesh.isVisible = true;
    expect(read(first)).toEqual([]);
    first.dispose();
    second.dispose();
  });

  it("gives a source's Material, visibility and geometry writes to its instances, which read them through getters", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    const source = MeshBuilder.CreateBox("source", {}, scene);
    source.createInstance("instance");
    const reader = openRenderChangeReader(scene);
    const read = () => {
      const seen: Array<[string, number]> = [];
      reader.drain((node, kinds) => seen.push([node.name, kinds]));
      return seen;
    };
    source.material = new StandardMaterial("material", scene);
    expect(read()).toEqual([["source", RenderChange.Material], ["instance", RenderChange.Material]]);
    source.visibility = 0.5;
    expect(read()).toEqual([["source", RenderChange.Visibility], ["instance", RenderChange.Visibility]]);
    source.setVerticesData(VertexBuffer.PositionKind, source.getVerticesData(VertexBuffer.PositionKind)!.map((value) => value * 2));
    // New positions also refit the source's bounds, which recomputes its world matrix.
    expect(read().map(([name, kinds]) => [name, kinds & RenderChange.Geometry])).toEqual([["source", RenderChange.Geometry], ["instance", RenderChange.Geometry]]);
    reader.dispose();
  });

  it("lets a geometry several meshes share be disposed: Babylon then releases a mesh that is not there", () => {
    const engine = new NullEngine();
    engines.push(engine);
    const scene = new Scene(engine);
    const first = MeshBuilder.CreateBox("first", {}, scene);
    const second = new BabylonMesh("second", scene);
    const third = new BabylonMesh("third", scene);
    first.geometry!.applyToMesh(second);
    first.geometry!.applyToMesh(third);
    const reader = openRenderChangeReader(scene);
    // `Geometry.dispose` walks its meshes by index while each release removes one, so it also releases `undefined`.
    expect(() => first.geometry!.dispose()).not.toThrow();
    const seen: string[] = [];
    reader.drain((node, kinds) => { if (kinds & RenderChange.Geometry) seen.push(node.name); });
    expect(seen).toContain("first");
    reader.dispose();
  });
});
