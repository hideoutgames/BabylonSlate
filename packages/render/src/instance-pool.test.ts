import { afterEach, describe, expect, it } from "vitest";
import {
  InstancedMesh,
  Material,
  Mesh,
  MeshBuilder,
  MorphTargetManager,
  NullEngine,
  Scene,
  ShaderMaterial,
  Skeleton,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { drawnMaterialVariants } from "./drawn-variants";
import {
  instancingIneligibility,
  isInstancePoolSource,
  RETAINED_EMPTY_GROUPS,
  sceneInstancePool,
  type InstanceGeometry,
  type InstanceGroupKey,
} from "./instance-pool";
import { noteDrawn } from "./reveal-pending";
import { authoredShadowParticipation, participatesInShadows } from "./shadow-mesh-policy";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function fixture() {
  const engine = new NullEngine();
  engines.push(engine);
  engine.getCaps().instancedArrays = true;
  const scene = new Scene(engine);
  const released: string[] = [];
  /** A primitive template's geometry, cloned per group with its geometry shared. */
  const geometry = (kind: string): InstanceGeometry => {
    const template = MeshBuilder.CreateBox(`template:${kind}`, {}, scene);
    template.setEnabled(false);
    return {
      key: `primitive:${kind}`,
      build: (_scene, name) => {
        const source = template.clone(name, null, true)!;
        source.setEnabled(true);
        return source;
      },
      retain: () => () => released.push(kind),
    };
  };
  const box = geometry("box");
  const surface = new StandardMaterial("surface", scene);
  const key = (overrides: Partial<InstanceGroupKey> = {}): InstanceGroupKey =>
    ({ geometry: box, material: surface, receiveShadows: true, renderingGroupId: 1, ...overrides });
  return { scene, pool: sceneInstancePool(scene), geometry, box, surface, key, released };
}

describe("groups", () => {
  it("draws members that share geometry, Material, receiving and rendering group in one source's batch", () => {
    const { scene, pool, geometry, key } = fixture();
    const [a, b] = [pool.join(key(), "a"), pool.join(key(), "b")];
    expect(a.sourceMesh).toBe(b.sourceMesh);
    // Each of these is read from the source for every instance, so it splits the group.
    const splits = [
      key({ material: new StandardMaterial("other", scene) }), key({ material: null }), key({ receiveShadows: false }),
      key({ renderingGroupId: 2 }), key({ geometry: geometry("sphere") }),
    ].map((other, index) => pool.join(other, `split ${index}`).sourceMesh);
    expect(new Set([a.sourceMesh, ...splits]).size).toBe(6);
    expect(pool.diagnostics()).toMatchObject({ groups: 6, pooled: 7, rekeys: 0 });
  });

  it("builds a hidden source at identity that draws its members' normals for any scaling, never casts and only draws instanced", () => {
    const { pool, key, surface } = fixture();
    const member = pool.join(key({ receiveShadows: true }), "member");
    const source = member.sourceMesh;
    member.scaling.set(1, 3, 1);
    expect({
      visible: source.isVisible, pickable: source.isPickable, material: source.material === surface, receives: source.receiveShadows,
      group: source.renderingGroupId, frozen: source.isWorldMatrixFrozen, identity: source.getWorldMatrix().isIdentity(),
      nonUniform: source.nonUniformScaling, pool: isInstancePoolSource(source), variants: drawnMaterialVariants(source),
      participates: participatesInShadows(source), participation: authoredShadowParticipation(source),
    }).toEqual({
      visible: false, pickable: false, material: true, receives: true, group: 1, frozen: true, identity: true, nonUniform: true,
      pool: true, variants: { plain: false, instanced: true }, participates: true, participation: { castShadows: false, receiveShadows: true },
    });
    // A frozen world matrix never recomputes its scaling state.
    source.computeWorldMatrix(true);
    expect(source.nonUniformScaling).toBe(true);
  });

  it("holds the geometry's owner while the group lives", () => {
    const { pool, key, released } = fixture();
    const member = pool.join(key(), "member");
    expect(released).toEqual([]);
    member.dispose();
    // It never drew: the group goes at once.
    expect(released).toEqual(["box"]);
  });
});

describe("rekey", () => {
  it("moves a member to another group in place, keeping its identity, parent and transform", () => {
    const { scene, pool, key } = fixture();
    const actor = new TransformNode("actor-1", scene);
    const member = pool.join(key(), "member");
    member.parent = actor;
    member.position.set(1, 2, 3);
    const [id, before] = [member.uniqueId, member.sourceMesh];
    const other = new StandardMaterial("other", scene);
    pool.rekey(member, key({ material: other }));
    const after = member.sourceMesh;
    expect({
      sameNode: member.uniqueId === id, parent: member.parent === actor, position: member.position.asArray(),
      material: member.material === other, moved: after !== before, listed: after.instances.includes(member),
      leftBefore: before.instances.includes(member),
      submeshes: member.subMeshes.every((part) => part.getRenderingMesh() === after && part.getMesh() === member),
    }).toEqual({
      sameNode: true, parent: true, position: [1, 2, 3], material: true, moved: true, listed: true, leftBefore: false, submeshes: true,
    });
    expect(pool.diagnostics()).toMatchObject({ groups: 1, pooled: 1, rekeys: 1 });
  });

  it("keeps the other members' places in the source it left", () => {
    const { scene, pool, key } = fixture();
    const members = ["a", "b", "c"].map((name) => pool.join(key(), name));
    const source = members[0]!.sourceMesh;
    pool.rekey(members[0]!, key({ material: new StandardMaterial("other", scene) }));
    // Babylon's removal moves the last instance into the freed slot and records its new index.
    expect(source.instances.map((instance) => [instance.name, instance._indexInSourceMeshInstanceArray]))
      .toEqual([["c", 0], ["b", 1]]);
  });

  it("refuses a geometry change and a mesh outside the pool", () => {
    const { scene, pool, key, geometry } = fixture();
    const member = pool.join(key(), "member");
    expect(() => pool.rekey(member, key({ geometry: geometry("sphere") }))).toThrow("cannot change geometry in place");
    const stranger = MeshBuilder.CreateBox("stranger", {}, scene).createInstance("stranger instance");
    expect(() => pool.rekey(stranger, key())).toThrow("not a member");
  });

  it("relies on Babylon's InstancedMesh keeping its source in `_sourceMesh` (review when the pin moves)", () => {
    const { scene } = fixture();
    const source = MeshBuilder.CreateBox("source", {}, scene);
    const instance = new InstancedMesh("instance", source);
    expect(Object.prototype.hasOwnProperty.call(instance, "_sourceMesh")).toBe(true);
    expect((instance as unknown as { _sourceMesh: Mesh })._sourceMesh).toBe(source);
    expect(typeof (instance as unknown as { _syncSubMeshes: unknown })._syncSubMeshes).toBe("function");
    expect(typeof (source as unknown as { _updateNonUniformScalingState: unknown })._updateNonUniformScalingState).toBe("function");
  });
});

describe("retention", () => {
  it("keeps an emptied group that drew for a respawn, which reuses its source, until the next load releases it", () => {
    const { pool, key, released } = fixture();
    const member = pool.join(key(), "member");
    const source = member.sourceMesh;
    noteDrawn(member);
    member.dispose();
    expect(pool.diagnostics()).toMatchObject({ groups: 0, retained: 1, pooled: 0 });
    const respawn = pool.join(key(), "respawn");
    expect(respawn.sourceMesh).toBe(source);
    expect(pool.diagnostics()).toMatchObject({ groups: 1, retained: 0 });
    noteDrawn(respawn);
    respawn.dispose();
    pool.releaseRetained();
    expect([source.isDisposed(), released, pool.diagnostics().retained]).toEqual([true, ["box"], 0]);
  });

  it("disposes the least recently emptied group beyond its cap", () => {
    const { scene, pool, key } = fixture();
    const sources = Array.from({ length: RETAINED_EMPTY_GROUPS + 1 }, (_, index) => {
      const member = pool.join(key({ material: new StandardMaterial(`m${index}`, scene) }), `member ${index}`);
      noteDrawn(member);
      member.dispose();
      return member.sourceMesh;
    });
    expect(pool.diagnostics().retained).toBe(RETAINED_EMPTY_GROUPS);
    expect(sources.map((source) => source.isDisposed())).toEqual([true, ...Array(RETAINED_EMPTY_GROUPS).fill(false)]);
  });

  it("disposes every group with the Scene", () => {
    const { scene, pool, key, released } = fixture();
    pool.join(key(), "member");
    scene.dispose();
    expect(released).toEqual(["box"]);
    expect(pool.diagnostics()).toMatchObject({ groups: 0, retained: 0 });
  });
});

describe("instancingIneligibility", () => {
  type Arrange = (mesh: Mesh, scene: Scene) => Material | null | void;
  const cases: Array<[string, Arrange]> = [
    ["deforming", (mesh, scene) => { mesh.skeleton = new Skeleton("rig", "rig", scene); }],
    ["deforming", (mesh, scene) => { mesh.morphTargetManager = new MorphTargetManager(scene); }],
    ["deforming", (mesh) => { mesh.material!.metadata = { boundsPadding: 0.5 }; }],
    ["thinInstances", (mesh) => { mesh.thinInstanceAddSelf(); }],
    ["levelsOfDetail", (mesh, scene) => { mesh.addLODLevel(10, MeshBuilder.CreateBox("lod", {}, scene)); }],
    ["instanced", (mesh) => { mesh.createInstance("copy"); }],
    ["drawHooks", (mesh) => { mesh.onBeforeRenderObservable.add(() => {}); }],
    ["partitioned", (mesh) => { mesh.subMeshes.push(mesh.subMeshes[0]!.clone(mesh)); }],
    ["sorted", (mesh) => { mesh.alphaIndex = 3; }],
    ["blended", (mesh) => { mesh.material!.alpha = 0.5; }],
    ["fillMode", (mesh) => { mesh.material!.wireframe = true; }],
    ["vertexStage", (_mesh, scene) => new ShaderMaterial("custom", scene, { vertex: "custom", fragment: "custom" }, {})],
  ];

  it.each(cases)("leaves a mesh unpooled: %s", (reason, arrange) => {
    const { scene } = fixture();
    const mesh = MeshBuilder.CreateBox("mesh", {}, scene);
    mesh.material = new StandardMaterial("surface", scene);
    const material = arrange(mesh, scene);
    expect(instancingIneligibility(mesh, material === undefined ? mesh.material : material)).toBe(reason);
  });

  it("pools an opaque static mesh, the default Material included", () => {
    const { scene } = fixture();
    const mesh = MeshBuilder.CreateBox("mesh", {}, scene);
    expect(instancingIneligibility(mesh, null)).toBeNull();
    expect(instancingIneligibility(mesh, new StandardMaterial("surface", scene))).toBeNull();
  });

  it("counts the meshes left unpooled by reason", () => {
    const { pool } = fixture();
    pool.noteUnpooled("blended");
    pool.noteUnpooled("blended");
    pool.noteUnpooled("deforming");
    expect(pool.diagnostics().unpooled).toEqual({ blended: 2, deforming: 1 });
  });
});

it("places nothing: a member starts at the origin, unparented, whatever the source's transform was built with", () => {
  const { scene, pool } = fixture();
  const geometry: InstanceGeometry = {
    key: "primitive:moved",
    build: (_scene, name) => {
      const source = MeshBuilder.CreateBox(name, {}, scene);
      source.position.set(5, 5, 5);
      source.scaling.set(2, 2, 2);
      return source;
    },
  };
  const member = pool.join({ geometry, material: null, receiveShadows: false, renderingGroupId: 0 }, "member");
  expect([member.position.asArray(), member.scaling.asArray(), member.parent]).toEqual([[0, 0, 0], [1, 1, 1], null]);
  expect(Vector3.Distance(member.sourceMesh.getAbsolutePosition(), Vector3.Zero())).toBe(0);
});
