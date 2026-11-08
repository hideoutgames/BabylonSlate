import { afterEach, describe, expect, it } from "vitest";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Meshes/thinInstanceMesh";
// Registers createInstance, which the fixture uses.
import "@babylonjs/core/Meshes/instancedMesh";
import {
  SHARED_OUTLINE_ATTRIBUTE,
  SharedOutlineOwner,
  type SharedOutlineContribution,
} from "./shared-outline";
import { removeOutlineContribution, setOutlineContribution } from "./test-support/shared-outline-contributions";

const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function setup() {
  const engine = new NullEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  const owner = SharedOutlineOwner.forScene(scene);
  return { scene, owner, view: owner.createView("editor") };
}
const style = { kind: "component", color: [1, 0, 0], width: 2 } as const;

describe("shared outline admission", () => {
  it("bounds each mask search by surviving styles and restores wider styles when overrides leave", () => {
    const { scene, view } = setup();
    const target = { key: "actor", meshes: [MeshBuilder.CreateBox("actor", {}, scene)] };
    const widths = () => (["strict", "through", "selection"] as const).map((group) => view.maximumWidthForGroup(group));
    setOutlineContribution(view, "global", { ...style, kind: "global", targets: [target], width: 8,
      distanceFade: { start: 50, end: 100 } });
    setOutlineContribution(view, "component-a", { ...style, targets: [target], width: 1 });
    setOutlineContribution(view, "selection", { ...style, kind: "selection", targets: [target], width: 0.25 });
    // Neither a replaced global width nor a targetless style enlarges any search.
    setOutlineContribution(view, "empty", { ...style, targets: [], width: 8 });
    expect(widths()).toEqual([1, 0, 0.25]);
    expect(view.maximumWidth).toBe(8);
    expect(view.distanceFadeEnabled).toBe(false);

    setOutlineContribution(view, "component-z", { ...style, targets: [target], width: 4, throughMeshes: true });
    expect(widths()).toEqual([0, 4, 0.25]);
    expect(view.groupActive("strict")).toBe(false);
    removeOutlineContribution(view, "component-z");
    expect(widths()).toEqual([1, 0, 0.25]);
    removeOutlineContribution(view, "component-a");
    expect(widths()).toEqual([8, 0, 0.25]);
    expect(view.distanceFadeEnabled).toBe(true);
    removeOutlineContribution(view, "global");
    expect(widths()).toEqual([0, 0, 0.25]);
    removeOutlineContribution(view, "selection");
    expect(widths()).toEqual([0, 0, 0]);
    expect(view.maximumWidth).toBe(0);
  });

  it("rejects collapsed GPU fade ranges without replacing the accepted global style", () => {
    const { view } = setup();
    const global: SharedOutlineContribution = { ...style, kind: "global", targets: [{ key: "actor", meshes: [] }], distanceFade: { start: 50, end: 100 } };
    setOutlineContribution(view, "global", global);
    const revision = view.revision;
    expect(() => setOutlineContribution(view, "global", { ...global, distanceFade: { start: 500_000, end: 500_000.01 } })).toThrow(/distance fade range/);
    expect(view.revision).toBe(revision);
    expect(view.contributions.get("global")?.distanceFade).toEqual({ start: 50, end: 100 });
  });
  it("treats an equal host snapshot as unchanged in any target order, applies any difference, and still rejects an invalid one", () => {
    const { scene, view } = setup();
    const [a, b, c] = ["a", "b", "c"].map((name) => MeshBuilder.CreateBox(name, {}, scene));
    const snapshot = (targets: SharedOutlineContribution["targets"], overrides: Partial<SharedOutlineContribution> = {}) =>
      new Map<string, SharedOutlineContribution>([["global", { ...style, kind: "global", targets, ...overrides }]]);
    const targets = [{ key: "b", meshes: [b!] }, { key: "a", meshes: [a!] }];
    view.replaceContributions(snapshot(targets), null);
    const revision = view.revision;

    // Fresh objects, as a host rebuilds them each sync: same order, then reversed.
    view.replaceContributions(snapshot(targets.map((target) => ({ key: target.key, meshes: [...target.meshes] }))), null);
    view.replaceContributions(snapshot([...targets].reverse()), null);
    expect(view.revision).toBe(revision);

    view.replaceContributions(snapshot([targets[0]!, { key: "a", meshes: [a!, c!] }]), null);
    expect(view.revision).toBe(revision + 1);
    view.replaceContributions(snapshot([targets[0]!, { key: "a", meshes: [a!, c!] }], { width: 3 }), null);
    expect(view.contributions.get("global")?.width).toBe(3);
    expect(view.revision).toBe(revision + 2);

    // An invalid entry is rejected even when everything else matches what is stored.
    expect(() => view.replaceContributions(snapshot([targets[0]!, { key: "a", meshes: [a!, c!] }], { width: 3, color: [2, 0, 0] }), null)).toThrow(/invalid/i);
    expect(view.contributions.get("global")?.color).toEqual([1, 0, 0]);
    expect(view.revision).toBe(revision + 2);
  });
  it("rejects identity overflow without replacing the accepted contribution", () => {
    const { owner, view } = setup();
    const accepted: SharedOutlineContribution = {
      ...style,
      targets: Array.from({ length: 65_535 }, (_, index) => ({ key: `actor-${index}`, meshes: [] })),
    };
    setOutlineContribution(view, "authored", accepted);
    const revision = view.revision;
    expect(() => setOutlineContribution(view, "authored", {
      ...accepted,
      targets: [...accepted.targets, { key: "overflow", meshes: [] }],
    })).toThrow(/capacity/i);
    expect(view.revision).toBe(revision);
    expect(owner.identityForKey("overflow")).toBe(0);
    expect(view.contributions.get("authored")?.targets).toHaveLength(65_535);
  });

  it("rolls back new registrations when another source already owns the attribute", () => {
    const { scene, owner, view } = setup();
    const acceptedSource = MeshBuilder.CreateBox("accepted", {}, scene);
    const accepted = acceptedSource.createInstance("accepted-instance");
    setOutlineContribution(view, "authored", { ...style, targets: [{ key: "accepted", meshes: [accepted] }] });
    const acceptedIdentity = owner.identityFor(accepted);
    const newSource = MeshBuilder.CreateBox("new-source", {}, scene);
    const newInstance = newSource.createInstance("new-instance");
    const occupiedSource = MeshBuilder.CreateBox("occupied", {}, scene);
    const occupied = occupiedSource.createInstance("occupied-instance");
    occupiedSource.registerInstancedBuffer(SHARED_OUTLINE_ATTRIBUTE, 1);
    occupiedSource.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE] = 47;
    const revision = view.revision;

    expect(() => setOutlineContribution(view, "other", { ...style, targets: [
      { key: "new", meshes: [newInstance] },
      { key: "occupied", meshes: [occupied] },
    ] })).toThrow(/another owner/i);
    expect(view.revision).toBe(revision);
    expect(view.contributions.has("other")).toBe(false);
    expect(owner.identityFor(accepted)).toBe(acceptedIdentity);
    expect(accepted.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE]).toBe(acceptedIdentity);
    expect(newSource.instancedBuffers?.[SHARED_OUTLINE_ATTRIBUTE]).toBeUndefined();
    expect(occupiedSource.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE]).toBe(47);
    expect(owner.identityForKey("new")).toBe(0);
  });

  it("leaves a released instance source drawable and admissible again", () => {
    const { scene, owner, view } = setup();
    const source = MeshBuilder.CreateBox("source", {}, scene);
    const instance = source.createInstance("instance");
    const selection: SharedOutlineContribution = {
      ...style, kind: "selection", targets: [{ key: "actor", meshes: [source, instance] }],
    };
    setOutlineContribution(view, "selection", selection);
    removeOutlineContribution(view, "selection");
    expect(source.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE]).toBeUndefined();
    expect(instance.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE]).toBeUndefined();
    expect(() => source._processInstancedBuffers([instance], true)).not.toThrow();
    setOutlineContribution(view, "selection", selection);
    expect(owner.identityFor(source)).toBeGreaterThan(0);
  });

  it("keeps whole-actor thin matrices owned by the mesh when another consumer leaves", () => {
    const { scene, owner, view } = setup();
    const mesh = MeshBuilder.CreateBox("thin-group", {}, scene);
    const matrices = new Float32Array(32);
    Matrix.Translation(-1, 0, 0).copyToArray(matrices, 0);
    Matrix.Translation(1, 0, 0).copyToArray(matrices, 16);
    mesh.thinInstanceSetBuffer("matrix", matrices, 16);
    const target = { key: "actor", meshes: [mesh] };
    setOutlineContribution(view, "component", { ...style, targets: [target] });
    setOutlineContribution(view, "selection", { ...style, kind: "selection", targets: [target] });
    const identity = owner.identityFor(mesh);
    removeOutlineContribution(view, "component");
    expect(owner.identityFor(mesh)).toBe(identity);
    expect(mesh.thinInstanceCount).toBe(2);
    expect(mesh.thinInstanceGetWorldMatrices().map((matrix) => matrix.getTranslation().x)).toEqual([-1, 1]);
    expect(mesh.isVerticesDataPresent(SHARED_OUTLINE_ATTRIBUTE)).toBe(false);
    expect(owner.diagnostics().instanceBufferBytes).toBe(0);
    view.dispose();
    expect(mesh.thinInstanceCount).toBe(2);
  });

  it("admits a late LOD source without replacing its actor identity or foreign buffers", () => {
    const { scene, owner, view } = setup();
    const mesh = MeshBuilder.CreateBox("source", {}, scene);
    const instance = mesh.createInstance("instance");
    setOutlineContribution(view, "component", { ...style, targets: [{ key: "actor", meshes: [instance] }] });
    const identity = owner.identityFor(instance);
    const lod = MeshBuilder.CreateBox("late-lod", {}, scene);
    lod.registerInstancedBuffer("foreign", 1);
    lod.instancedBuffers.foreign = 19;
    mesh.addLODLevel(5, lod);
    owner.prepareRenderSource(lod);
    expect(lod.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE]).toBe(0);
    expect(lod.instancedBuffers.foreign).toBe(19);
    expect(owner.identityFor(instance)).toBe(identity);
    const sources = owner.diagnostics().sourceCount;
    owner.prepareRenderSource(lod);
    expect(owner.diagnostics().sourceCount).toBe(sources);
  });

  it("keeps a source admitted by a mask draw across membership changes until the last outline leaves", () => {
    const { scene, owner, view } = setup();
    const mesh = MeshBuilder.CreateBox("source", {}, scene);
    const instance = mesh.createInstance("instance");
    const other = MeshBuilder.CreateBox("other", {}, scene);
    const occluder = mesh.createInstance("occluder");
    setOutlineContribution(view, "selection", { ...style, kind: "selection", targets: [{ key: "a", meshes: [other] }] });
    // An occluder's source is admitted when its mask draw first needs it.
    owner.prepareRenderSource(mesh);
    const revision = owner.sourceRevision;
    expect(owner.diagnostics().sourceCount).toBe(1);
    // Selecting and deselecting an instance must not release and re-admit the source, which dirties its attributes each time.
    setOutlineContribution(view, "selection", { ...style, kind: "selection", targets: [{ key: "b", meshes: [instance] }] });
    expect(occluder.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE]).toBe(0);
    expect(instance.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE]).toBe(owner.identityForKey("b"));
    setOutlineContribution(view, "selection", { ...style, kind: "selection", targets: [{ key: "a", meshes: [other] }] });
    expect(owner.sourceRevision).toBe(revision);
    expect(owner.diagnostics().sourceCount).toBe(1);
    expect(instance.instancedBuffers[SHARED_OUTLINE_ATTRIBUTE]).toBe(0);
    removeOutlineContribution(view, "selection");
    expect(owner.diagnostics().sourceCount).toBe(0);
  });
});
