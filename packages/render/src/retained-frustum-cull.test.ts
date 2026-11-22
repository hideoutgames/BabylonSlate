import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { FrameGraph } from "@babylonjs/core/FrameGraph/frameGraph";
import { FrameGraphCullObjectsTask } from "@babylonjs/core/FrameGraph/Tasks/Misc/cullObjectsTask";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { cullSceneByWhatShows } from "./cull-accuracy";
import { createPrimitiveMesh } from "./scene-component-mesh";
import { RENDERING_GROUP } from "./sorting";
import { allowSceneOcclusionCulling, forceOcclusionEveryFrame } from "./view-occlusion";
import { ForwardSceneFrameGraph } from "./framegraph-forward-scene";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { setMeshRenderingGroup, setSceneInstancing } from "./instance-pool";
import { applyMaterialBounds } from "./material-bounds";
import { joinPooledPrimitiveGroup } from "./pooled-primitive-visual";
import { noteRenderChange, openRenderChangeReader, RenderChange } from "./render-change-journal";
import { RETAINED_CULL_MIN_MESHES, RetainedFrustumCull, verifyRetainedFrustumCull, type RetainedFrustumCullWork } from "./retained-frustum-cull";
import { skinnedRig, skinnedStrip } from "./skinned-test-fixtures";
import { hideUntilReady, noteRevealProbe } from "./reveal-pending";

const disposers: Array<() => void> = [];
beforeEach(() => verifyRetainedFrustumCull(true));
afterEach(() => {
  verifyRetainedFrustumCull(false);
  while (disposers.length) disposers.pop()!();
});

/** Babylon announces a new mesh on a later task. */
const announced = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function nullEngine(): NullEngine {
  const engine = adaptNullEngineFrameGraph(new NullEngine({ renderWidth: 320, renderHeight: 180, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1 }));
  engine.getCaps().instancedArrays = true;
  return engine;
}

/**
 * A world view looking along +z from the origin (at z = 10 its view reaches x = ±8.3 and y = ±4.7), culling by what
 * shows as every view does. While verifying (every test unless it says otherwise), each frame's retained cull also runs
 * Babylon's own loop and reads every copy again: a list or copy that differs throws from `frame`.
 */
async function world({ occlusion = false } = {}) {
  const engine = nullEngine();
  const scene = new Scene(engine);
  const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
  camera.minZ = 0.1;
  camera.maxZ = 500;
  camera.setTarget(new Vector3(0, 0, 1));
  scene.activeCamera = camera;
  cullSceneByWhatShows(scene);
  const graph = new ForwardSceneFrameGraph(scene, { occlusion });
  disposers.push(() => { graph.dispose(); scene.dispose(); engine.dispose(); });
  const cull = () => (graph as unknown as { cull: { outputObjectList: { meshes: AbstractMesh[] | null } } }).cull;
  const box = (name: string, x: number, y = 0, z = 10, size = 1) => {
    const mesh = MeshBuilder.CreateBox(name, { size }, scene);
    mesh.position.set(x, y, z);
    return mesh;
  };
  const work = (): RetainedFrustumCullWork => graph.diagnostics().frustumCull!;
  /** Draws one frame whose cull runs (preparing the graph first when it asks) and returns the names it kept, in order. */
  const frame = async (): Promise<string[]> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = work().retainedFrames + work().stockFrames;
      // An Engine frame: what follows it once a frame (pose bounds) takes this one.
      engine.beginFrame();
      let result: ReturnType<typeof graph.render>;
      try {
        result = graph.render(camera);
      } finally {
        engine.endFrame();
      }
      if (work().retainedFrames + work().stockFrames > before) return (cull().outputObjectList.meshes ?? []).map((mesh) => mesh.name);
      if (result.reason) await graph.prepare(camera);
    }
    throw new Error("The view did not cull.");
  };
  /** Lets Babylon announce the meshes made since, and draws until their first readiness probes are behind. */
  const settle = async (): Promise<string[]> => {
    await announced();
    await frame();
    return frame();
  };
  await graph.prepare(camera);
  /** Disabled meshes enough for the list to reach the retained cull's minimum without verifying. */
  const fill = () => {
    const filler = box("filler", 0, 0, 10, 0.1);
    filler.setEnabled(false);
    for (let index = 1; index < RETAINED_CULL_MIN_MESHES; index++) filler.createInstance(`filler ${index}`).setEnabled(false);
  };
  return { engine, scene, camera, graph, box, fill, frame, settle, work };
}

describe("the retained frustum cull", () => {
  it("keeps what Babylon's loop keeps, in its order, reading each copy once until a change names it", async () => {
    const { box, fill, frame, work } = await world();
    fill();
    box("left", -3); box("behind", 0, 0, -10); box("right", 3); box("far side", 20);
    await announced();
    expect(await frame()).toEqual(["left", "right"]);
    expect(work()).toMatchObject({ boundsReads: 4, flagReads: RETAINED_CULL_MIN_MESHES + 4 });
    await frame();
    verifyRetainedFrustumCull(false);
    expect(await frame()).toEqual(["left", "right"]);
    // Every place comes from the copies, but those the rotating check reads again (one in 32).
    expect(work()).toMatchObject({ boundsReads: 0, tested: 4, live: 0 });
    expect(work().flagReads).toBeLessThanOrEqual(Math.ceil((RETAINED_CULL_MIN_MESHES + 4) / 32));
  });

  it("culls a list shorter than the minimum with Babylon's loop, and a long one over its copies", async () => {
    verifyRetainedFrustumCull(false);
    const { box, frame, work } = await world();
    for (let index = 0; index < RETAINED_CULL_MIN_MESHES - 1; index++) box(`filler ${index}`, -50, 0, 10, 0.1);
    await announced();
    await frame();
    expect(work()).toMatchObject({ retainedFrames: 0 });
    const stock = work().stockFrames;
    box("last", 0);
    await announced();
    expect((await frame()).at(-1)).toBe("last");
    expect(work()).toMatchObject({ retainedFrames: 1, stockFrames: stock, listed: RETAINED_CULL_MIN_MESHES });
  });

  it("follows a frozen mesh moved by a new frozen matrix and by a re-freeze, as Play's snapshots move it", async () => {
    const { box, frame, settle } = await world();
    const mover = box("mover", 0);
    mover.freezeWorldMatrix();
    expect(await settle()).toEqual(["mover"]);
    mover.freezeWorldMatrix(Matrix.Translation(30, 0, 10));
    expect(await frame()).toEqual([]);
    mover.position.set(1, 0, 10);
    mover.freezeWorldMatrix();
    expect(await frame()).toEqual(["mover"]);
  });

  it("follows a moved ancestor, a re-parent, and enabling or disabling a mesh or an ancestor", async () => {
    const { scene, box, frame, settle } = await world();
    const parent = new TransformNode("parent", scene), other = new TransformNode("other", scene);
    other.position.x = 40;
    const child = box("child", 0);
    child.parent = parent;
    expect(await settle()).toEqual(["child"]);
    parent.position.x = 30;
    expect(await frame()).toEqual([]);
    child.parent = other;
    other.position.x = -1;
    expect(await frame()).toEqual(["child"]);
    other.setEnabled(false);
    expect(await frame()).toEqual([]);
    other.setEnabled(true);
    child.setEnabled(false);
    expect(await frame()).toEqual([]);
    child.setEnabled(true);
    expect(await frame()).toEqual(["child"]);
  });

  it("follows isVisible, an inherited isVisible, visibility and the layer mask", async () => {
    const { box, frame, settle } = await world();
    const parent = box("parent", -3), child = box("child", 3);
    child.parent = parent;
    child.position.set(6, 0, 0);
    expect(await settle()).toEqual(["parent", "child"]);
    parent.isVisible = false;
    expect(await frame()).toEqual(["child"]);
    child.inheritVisibility = true;
    expect(await frame()).toEqual([]);
    parent.isVisible = true;
    expect(await frame()).toEqual(["parent", "child"]);
    child.visibility = 0;
    expect(await frame()).toEqual(["parent"]);
    child.visibility = 0.5;
    parent.layerMask = 0x10000000;
    expect(await frame()).toEqual(["child"]);
    parent.layerMask = 0x0fffffff;
    expect(await frame()).toEqual(["parent", "child"]);
  });

  it("reads alwaysSelectAsActiveMesh and a scale written in place, which nothing announces", async () => {
    const { box, frame, settle } = await world();
    const behind = box("behind", 0, 0, -10), squashed = box("squashed", 0), frozen = box("frozen", 2), replaced = box("replaced", -2);
    frozen.freezeWorldMatrix();
    expect(await settle()).toEqual(["squashed", "frozen", "replaced"]);
    behind.alwaysSelectAsActiveMesh = true;
    squashed.scaling.y = 0;
    frozen.scaling.x = 0;
    // A new vector with a zero component: Babylon's frame computes no world matrix for it, so only its setter tells.
    replaced.scaling = new Vector3(1, 0, 1);
    expect(await frame()).toEqual(["behind"]);
    behind.alwaysSelectAsActiveMesh = false;
    squashed.scaling.y = 1;
    frozen.scaling = new Vector3(1, 1, 1);
    replaced.scaling = new Vector3(1, 1, 1);
    expect(await frame()).toEqual(["squashed", "frozen", "replaced"]);
  });

  it("follows geometry replaced or edited in place, thin instances, and a Material's bound padding", async () => {
    const { scene, box, frame, settle } = await world();
    const edited = MeshBuilder.CreateBox("edited", { size: 1, updatable: true }, scene), padded = box("padded", 30), batch = box("batch", 30);
    edited.position.set(0, 0, 10);
    expect(await settle()).toEqual(["edited"]);
    const shifted = (edited.getVerticesData(VertexBuffer.PositionKind) as number[]).map((value, index) => (index % 3 === 0 ? value + 30 : value));
    // Vertices rewritten in place, then the bounds refreshed from them, as a sprite quad's or a painter's resize does.
    edited.updateVerticesData(VertexBuffer.PositionKind, shifted);
    edited.refreshBoundingInfo();
    expect(await frame()).toEqual([]);
    edited.setVerticesData(VertexBuffer.PositionKind, shifted.map((value, index) => (index % 3 === 0 ? value - 30 : value)), true);
    expect(await frame()).toEqual(["edited"]);
    const material = new StandardMaterial("padded", scene);
    material.metadata = { boundsPadding: 31 };
    padded.material = material;
    applyMaterialBounds(padded);
    batch.thinInstanceAdd(Matrix.Translation(-30, 0, 0));
    batch.thinInstanceRefreshBoundingInfo();
    expect(await frame()).toEqual(["edited", "padded", "batch"]);
    material.metadata = { boundsPadding: 0 };
    applyMaterialBounds(padded);
    batch.thinInstanceSetMatrixAt(0, Matrix.Translation(0, 0, 0));
    batch.thinInstanceRefreshBoundingInfo();
    expect(await frame()).toEqual(["edited"]);
  });

  it("follows a skinned mesh's bounds as its skeleton poses it", async () => {
    const { scene, frame, settle } = await world();
    const here = skinnedRig(scene), away = skinnedRig(scene);
    const reaching = skinnedStrip(scene, here.skeleton, "reaching");
    reaching.position.set(30, 0, 10);
    const leaving = skinnedStrip(scene, away.skeleton, "leaving");
    leaving.position.set(0, 0, 10);
    expect(await settle()).toEqual(["leaving"]);
    here.root.position = new Vector3(-30, 0, 0);
    away.root.position = new Vector3(30, 0, 0);
    await frame();
    expect(await frame()).toEqual(["reaching"]);
  });

  it("follows meshes added, removed and disposed, keeping the list's order", async () => {
    const { scene, box, frame, settle } = await world();
    const [a, b] = [box("a", -2), box("b", 0)];
    box("c", 2);
    expect(await settle()).toEqual(["a", "b", "c"]);
    b.dispose();
    box("d", 1);
    expect(await frame()).toEqual(["a", "c", "d"]);
    scene.removeMesh(a);
    scene.addMesh(a);
    expect(await frame()).toEqual(["c", "d", "a"]);
  });

  it("follows instance pool members joining, moving, changing group and leaving", async () => {
    const { scene, frame, settle } = await world();
    setSceneInstancing(scene, true);
    const material = new StandardMaterial("pooled", scene);
    const member = joinPooledPrimitiveGroup(scene, "box", material, "member")!;
    const other = joinPooledPrimitiveGroup(scene, "box", material, "other")!;
    member.position.set(0, 0, 10);
    other.position.set(30, 0, 10);
    const only = (names: string[]) => names.filter((name) => name === "member" || name === "other");
    expect(only(await settle())).toEqual(["member"]);
    other.position.x = 1;
    setMeshRenderingGroup(member, 2);
    expect(only(await frame())).toEqual(["member", "other"]);
    member.dispose();
    expect(only(await frame())).toEqual(["other"]);
  });

  it("tests a mirrored mesh and one with no extent as Babylon does, and again after its Scene is replaced", async () => {
    const first = await world();
    first.box("mirrored", 0).scaling.x = -1;
    first.box("point", 3, 0, 10, 0);
    first.box("point out", 30, 0, 10, 0);
    expect(await first.settle()).toEqual(["mirrored", "point"]);
    while (disposers.length) disposers.pop()!();
    const second = await world();
    second.box("again", 0);
    expect(await second.settle()).toEqual(["again"]);
  });

  it("is Babylon's cull through random scenes, cameras and changes", async () => {
    const { engine, scene, camera, box, frame } = await world();
    let seed = 7;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const range = (span: number) => (random() - 0.5) * span;
    const parents = [0, 1, 2, 3].map((index) => new TransformNode(`parent ${index}`, scene));
    const meshes: AbstractMesh[] = [];
    const spawn = () => {
      const kind = random();
      const mesh = kind < 0.6 ? box(`box ${meshes.length}`, range(40), range(20), range(60), 0.2 + random() * 6)
        : kind < 0.8 ? MeshBuilder.CreateSphere(`sphere ${meshes.length}`, { diameter: 0.5 + random() * 4, segments: 4 }, scene)
          : MeshBuilder.CreateGround(`ground ${meshes.length}`, { width: 1 + random() * 30, height: 0.5 + random() * 3 }, scene);
      mesh.position.set(range(40), range(20), range(60));
      mesh.rotation.set(range(6), range(6), range(6));
      if (random() < 0.3) mesh.parent = parents[Math.floor(random() * parents.length)]!;
      meshes.push(mesh);
    };
    for (let index = 0; index < 120; index++) spawn();
    await announced();
    const changes: Array<(mesh: AbstractMesh) => void> = [
      (mesh) => mesh.position.set(range(40), range(20), range(60)),
      (mesh) => mesh.setEnabled(!mesh.isEnabled(false)),
      (mesh) => { mesh.isVisible = !mesh.isVisible; },
      (mesh) => { mesh.visibility = random() < 0.5 ? 0 : random(); },
      (mesh) => { mesh.layerMask = random() < 0.5 ? 0x10000000 : 0x0fffffff; },
      (mesh) => { mesh.alwaysSelectAsActiveMesh = random() < 0.5; },
      (mesh) => { mesh.scaling.set(random() < 0.2 ? 0 : 0.2 + random() * 3, random() < 0.1 ? -1 : 1, 1); },
      (mesh) => { mesh.parent = random() < 0.5 ? null : parents[Math.floor(random() * parents.length)]!; },
      (mesh) => { if (mesh.isWorldMatrixFrozen) mesh.unfreezeWorldMatrix(); else mesh.freezeWorldMatrix(); },
      (mesh) => { mesh.cullingStrategy = Math.floor(random() * 4); },
      (mesh) => { mesh.getBoundingInfo().scale(0.5 + random()); },
      (mesh) => { mesh.refreshBoundingInfo({}); },
    ];
    for (let step = 0; step < 300; step++) {
      for (let change = 0; change < 6; change++) changes[Math.floor(random() * changes.length)]!(meshes[Math.floor(random() * meshes.length)]!);
      parents[Math.floor(random() * parents.length)]!.position.set(range(20), range(10), range(20));
      if (random() < 0.1) parents[Math.floor(random() * parents.length)]!.setEnabled(random() < 0.7);
      if (random() < 0.1) meshes.splice(Math.floor(random() * meshes.length), 1)[0]!.dispose();
      if (random() < 0.15) spawn();
      if (random() < 0.05) scene.skipFrustumClipping = !scene.skipFrustumClipping;
      if (random() < 0.1) {
        camera.mode = random() < 0.3 ? Camera.ORTHOGRAPHIC_CAMERA : Camera.PERSPECTIVE_CAMERA;
        camera.orthoLeft = -10 - random() * 10; camera.orthoRight = 10 + random() * 10;
        camera.orthoTop = 5 + random() * 5; camera.orthoBottom = -5 - random() * 5;
        camera.fov = 0.3 + random() * 1.5;
      }
      if (random() < 0.05) engine.setSize(100 + Math.floor(random() * 600), 100 + Math.floor(random() * 400));
      // Now and then the camera stands inside a mesh's bounds.
      const inside = random() < 0.1 ? meshes[Math.floor(random() * meshes.length)] : undefined;
      camera.position.copyFrom(inside ? inside.getAbsolutePosition() : new Vector3(range(10), range(4), range(10)));
      camera.setTarget(camera.position.add(new Vector3(range(2), range(1), 1)));
      await frame();
    }
  }, 60_000);
});

describe("its occlusion boxes", () => {
  it("hands the view's occlusion filter the world boxes it holds, each the mesh's own", async () => {
    forceOcclusionEveryFrame(true);
    disposers.push(() => forceOcclusionEveryFrame(false));
    const { scene, graph, frame, settle } = await world({ occlusion: true });
    allowSceneOcclusionCulling(scene, "always");
    const place = (name: string, x: number, z: number) => {
      const mesh = createPrimitiveMesh(scene, name, "box");
      mesh.renderingGroupId = RENDERING_GROUP.world;
      mesh.position.set(x, 0, z);
      return mesh;
    };
    // A wall 6 wide 5 ahead hides what stands behind it out to x = ±7.2 at z = 12.
    place("wall", 0, 5).scaling.set(6, 4, 0.2);
    const hidden = place("hidden", 0, 12), beside = place("beside", 8.3, 12);
    const occluded = () => [...graph.occludedMeshes()].map((mesh) => mesh.name);
    await settle();
    expect(occluded()).toEqual(["hidden"]);
    hidden.position.x = -8.3;
    beside.position.x = 2;
    // While verifying, each box the filter reads from the copies is compared with the mesh's (`checkBoundsCopy`).
    expect(await frame()).toEqual(["wall", "hidden"]);
    expect(occluded()).toEqual(["beside"]);
    expect(await frame()).toEqual(["wall", "hidden"]);
    expect(occluded()).toEqual(["beside"]);
  });

  it("leaves a mesh hidden until ready out of a long list with its box, and lets it in once revealed", async () => {
    verifyRetainedFrustumCull(false);
    forceOcclusionEveryFrame(true);
    disposers.push(() => forceOcclusionEveryFrame(false));
    const { scene, graph, fill, frame, settle, work } = await world({ occlusion: true });
    allowSceneOcclusionCulling(scene, "always");
    fill();
    const place = (name: string, x: number, z: number) => {
      const mesh = createPrimitiveMesh(scene, name, "box");
      mesh.renderingGroupId = RENDERING_GROUP.world;
      mesh.position.set(x, 0, z);
      return mesh;
    };
    place("wall", 0, 5).scaling.set(6, 4, 0.2);
    const pending = place("pending", -6, 10);
    place("behind", 0, 12);
    place("beside", 8.3, 12);
    const occluded = () => [...graph.occludedMeshes()].map((mesh) => mesh.name);
    expect(await settle()).toEqual(["wall", "pending", "beside"]);
    expect(work().retainedFrames).toBeGreaterThan(0);
    hideUntilReady(pending);
    // Left out before occlusion, whose boxes for the meshes after it must move up with them.
    expect(await frame()).toEqual(["wall", "beside"]);
    expect(occluded()).toEqual(["behind"]);
    noteRevealProbe(pending, true);
    expect(await frame()).toEqual(["wall", "pending", "beside"]);
    expect(occluded()).toEqual(["behind"]);
  });
});

describe("meshes moved without a setter", () => {
  it("are exact on the next cull: in place, frozen and re-frozen, under a parent moved in place", async () => {
    const { scene, box, frame, settle } = await world();
    const loose = box("loose", 0), frozen = box("frozen", 1);
    frozen.freezeWorldMatrix();
    const parent = new TransformNode("parent", scene);
    const child = box("child", -1), frozenChild = box("frozen child", -2);
    child.parent = frozenChild.parent = parent;
    frozenChild.freezeWorldMatrix();
    expect(await settle()).toEqual(["loose", "frozen", "child", "frozen child"]);
    loose.position.x = 30;
    frozen.position.x = 30;
    parent.position.x = 30;
    // A frozen matrix is not computed again: Babylon keeps culling the frozen meshes where they were frozen.
    expect(await frame()).toEqual(["frozen", "frozen child"]);
    // The snapshot path's re-freeze computes it once.
    frozen.freezeWorldMatrix();
    frozenChild.freezeWorldMatrix();
    expect(await frame()).toEqual([]);
  });

  it("are exact on the next cull: a billboard and an infinitely distant mesh while the camera moves", async () => {
    const { camera, box, frame, settle } = await world();
    const board = box("board", 6);
    board.scaling.set(12, 1, 0.1);
    board.billboardMode = TransformNode.BILLBOARDMODE_ALL;
    const sky = box("sky", 0, 0, 10);
    sky.infiniteDistance = true;
    await settle();
    for (let step = 0; step < 12; step++) {
      camera.position.set(step * 1.5, 0, -step);
      // Babylon computes both matrices from the camera, and only the copies of what it computed may answer.
      expect(await frame()).toContain("sky");
    }
  });

  it("are exact on the next cull: a mesh attached to a bone that moves", async () => {
    const { scene, box, frame, settle } = await world();
    const rig = skinnedRig(scene);
    const strip = skinnedStrip(scene, rig.skeleton, "strip");
    strip.position.set(0, 0, 10);
    const held = box("held", 0, 0, 0, 0.5);
    held.attachToBone(rig.arm, strip);
    expect((await settle()).filter((name) => name === "held")).toEqual(["held"]);
    rig.root.position = new Vector3(30, 0, 0);
    await frame();
    expect((await frame()).filter((name) => name === "held")).toEqual([]);
  });
});

describe("a bounding info shared by two meshes", () => {
  it("is tested by Babylon's own reads, in its order: each owner's lazy update rewrites it for the owners after it", async () => {
    const { box, frame, settle } = await world();
    const first = box("first", 0), second = box("second", 3);
    second.setBoundingInfo(first.getBoundingInfo());
    // `second`'s update ran last: both read its world values (x = 3).
    expect(await settle()).toEqual(["first", "second"]);
    first.position.x = 30;
    // `first`'s update, at x = 30, comes first in the pass: both read it.
    expect(await frame()).toEqual([]);
    first.position.x = 1;
    expect(await frame()).toEqual(["first", "second"]);
    second.position.x = 20;
    // `first` is tested before `second`'s update moves the shared values to x = 20, which the next frame reads for both.
    expect(await frame()).toEqual(["first"]);
    expect(await frame()).toEqual([]);
  });
});

describe("its healing", () => {
  it("corrects bounds written behind Babylon's back within one rotation of its check", async () => {
    verifyRetainedFrustumCull(false);
    const { box, fill, frame, settle, work } = await world();
    fill();
    const moved = box("moved", 0);
    expect(await settle()).toEqual(["moved"]);
    // No Babylon code writes world bounds outside `_update`: written directly, nothing is noted.
    const info = moved.getBoundingInfo();
    info.boundingSphere.centerWorld.x += 100;
    for (const corner of info.boundingBox.vectorsWorld) corner.x += 100;
    let frames = 0;
    while ((await frame()).includes("moved")) {
      frames++;
      expect(frames).toBeLessThan(32);
    }
    expect(work().heals).toBe(1);
  });
});

describe("the render change journal it reads", () => {
  it("never makes a reader that keeps up start over, while readers drain at different points with changes between", () => {
    const engine = nullEngine();
    const scene = new Scene(engine);
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    const [first, second] = [MeshBuilder.CreateBox("first", {}, scene), MeshBuilder.CreateBox("second", {}, scene)];
    const early = openRenderChangeReader(scene, RenderChange.Visibility), late = openRenderChangeReader(scene, RenderChange.Visibility);
    const seen = { early: 0, late: 0 };
    // Each round notes a change after each reader's drain, so the log is never read by both at once: far more entries
    // than the log keeps for a reader that falls behind.
    for (let round = 0; round < 70_000; round++) {
      first.visibility = round % 2 ? 0.5 : 0.25;
      expect(early.drain(() => { seen.early++; })).toBe(true);
      second.visibility = round % 2 ? 0.5 : 0.25;
      expect(late.drain(() => { seen.late++; })).toBe(true);
    }
    // Each reads every change once: the early one its round's first and the last round's second, the late one both.
    expect(seen).toEqual({ early: 139_999, late: 140_000 });
    early.dispose();
    late.dispose();
  });

  it("makes only a reader that fell behind start over", () => {
    const engine = nullEngine();
    const scene = new Scene(engine);
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    const meshes = [0, 1].map((index) => MeshBuilder.CreateBox(`box ${index}`, {}, scene));
    const stalled = openRenderChangeReader(scene, RenderChange.Visibility), active = openRenderChangeReader(scene, RenderChange.Visibility);
    for (let round = 0; round < 70_000; round++) {
      meshes[round % 2]!.visibility = round % 4 < 2 ? 0.5 : 0.25;
      expect(active.drain(() => {})).toBe(true);
    }
    expect(stalled.drain(() => {})).toBe(false);
    stalled.dispose();
    active.dispose();
  });

  it("holds at most the entries a reader may fall behind by while one never drains, and that reader then starts over", () => {
    const engine = nullEngine();
    const scene = new Scene(engine);
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    const meshes = Array.from({ length: 4 }, (_, index) => MeshBuilder.CreateBox(`box ${index}`, {}, scene));
    const journal = () => (scene as unknown as { _hapticRenderChanges: { nodes: unknown[]; last: Map<unknown, number> } })._hapticRenderChanges;
    const hidden = openRenderChangeReader(scene, RenderChange.Visibility), shown = openRenderChangeReader(scene, RenderChange.Visibility);
    let most = 0;
    for (let round = 0; round < 200_000; round++) {
      meshes[round % 4]!.visibility = round % 8 < 4 ? 0.5 : 0.25;
      expect(shown.drain(() => {})).toBe(true);
      most = Math.max(most, journal().nodes.length, journal().last.size);
    }
    expect(most).toBeLessThanOrEqual(65_536);
    expect(hidden.drain(() => {})).toBe(false);
    meshes[0]!.visibility = 1;
    const seen: string[] = [];
    expect(hidden.drain((node) => seen.push(node.name))).toBe(true);
    expect(seen).toEqual(["box 0"]);
    hidden.dispose();
    shown.dispose();
  });

  it("keeps no node it dropped every entry of, while readers drain at different points and it never empties", () => {
    const engine = nullEngine();
    const scene = new Scene(engine);
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    const nodes = Array.from({ length: 3000 }, (_, index) => new TransformNode(`node ${index}`, scene));
    const journal = () => (scene as unknown as { _hapticRenderChanges: { nodes: unknown[]; last: Map<unknown, number> } })._hapticRenderChanges;
    const early = openRenderChangeReader(scene, RenderChange.Other), late = openRenderChangeReader(scene, RenderChange.Other);
    for (let round = 0; round < 12_000; round++) {
      noteRenderChange(nodes[round % nodes.length]!);
      early.drain(() => {});
      noteRenderChange(nodes[(round * 7) % nodes.length]!);
      late.drain(() => {});
      // Every node `last` names has an entry still in the log.
      expect(journal().last.size).toBeLessThanOrEqual(journal().nodes.length);
    }
    early.dispose();
    late.dispose();
  });

  it("reports a node noted again after the entries before it were dropped, with every kind noted since the reader's last drain", () => {
    const engine = nullEngine();
    const scene = new Scene(engine);
    disposers.push(() => { scene.dispose(); engine.dispose(); });
    const [node, ...others] = Array.from({ length: 3 }, (_, index) => MeshBuilder.CreateBox(`box ${index}`, {}, scene));
    const early = openRenderChangeReader(scene, RenderChange.Visibility | RenderChange.Enabled);
    const late = openRenderChangeReader(scene, RenderChange.Visibility | RenderChange.Enabled);
    const read = (reader: typeof early) => {
      const seen = new Map<string, number>();
      reader.drain((target, kinds) => seen.set(target.name, (seen.get(target.name) ?? 0) | kinds));
      return seen;
    };
    node!.visibility = 0.5;
    read(early); read(late);
    // Enough entries, read by both, to drop those before them, the node's included.
    for (let round = 0; round < 3000; round++) {
      others[round % 2]!.visibility = round % 4 < 2 ? 0.5 : 0.25;
      read(early); read(late);
    }
    node!.visibility = 0.25;
    expect(read(early).get("box 0")).toBe(RenderChange.Visibility);
    node!.setEnabled(false);
    expect(read(late).get("box 0")).toBe(RenderChange.Visibility | RenderChange.Enabled);
    expect(read(early).get("box 0")).toBe(RenderChange.Visibility | RenderChange.Enabled);
    early.dispose();
    late.dispose();
  });

  it("gives the shadow walk's and the drawable follower's kinds the same entries whether a cull reader drains between them or not", () => {
    /** One scripted run of changes; each frame drains `readers` at its points, the cull reader (if any) in between. */
    const run = (withCull: boolean) => {
      const engine = nullEngine();
      const scene = new Scene(engine);
      disposers.push(() => { scene.dispose(); engine.dispose(); });
      const meshes = Array.from({ length: 8 }, (_, index) => MeshBuilder.CreateBox(`box ${index}`, {}, scene));
      const walk = openRenderChangeReader(scene, RenderChange.Visibility | RenderChange.Enabled | RenderChange.Material | RenderChange.Other | RenderChange.Style);
      const drawable = openRenderChangeReader(scene, RenderChange.Enabled | RenderChange.Visibility | RenderChange.Geometry);
      const cull = withCull ? openRenderChangeReader(scene, RenderChange.Transform | RenderChange.Bounds | RenderChange.Geometry |
        RenderChange.Enabled | RenderChange.Visibility | RenderChange.Dispatch | RenderChange.Ready) : null;
      const log: string[] = [];
      const record = (label: string) => (node: { name: string }, kinds: number) => log.push(`${label}:${node.name}:${kinds}`);
      for (let frame = 0; frame < 3000; frame++) {
        const mesh = meshes[frame % meshes.length]!;
        mesh.position.x = frame;
        mesh.computeWorldMatrix(true);
        if (frame % 3 === 0) mesh.visibility = (frame % 7) / 7;
        if (frame % 5 === 0) mesh.setEnabled(frame % 10 !== 0);
        drawable.drain(record("drawable"));
        mesh.getBoundingInfo().scale(1);
        cull?.drain(() => {});
        if (frame % 11 === 0) mesh.isVisible = !mesh.isVisible;
        walk.drain(record("walk"));
        log.push("|");
      }
      return log;
    };
    expect(run(true)).toEqual(run(false));
  });
});

describe("its input list", () => {
  /** Babylon's own cull task over a list, run through a retained cull, with world matrices computed as a frame does. */
  async function task() {
    const engine = nullEngine();
    const scene = new Scene(engine);
    const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
    camera.setTarget(new Vector3(0, 0, 1));
    scene.activeCamera = camera;
    const graph = new FrameGraph(scene);
    const cull = new FrameGraphCullObjectsTask("cull", graph, scene);
    cull.camera = camera;
    cull.objectList = { meshes: [], particleSystems: null };
    graph.addTask(cull);
    await graph.buildAsync(false);
    const stock = (cull.passes[0] as unknown as { _executeFunc: () => void })._executeFunc;
    const retained = new RetainedFrustumCull(scene);
    disposers.push(() => { retained.dispose(); graph.dispose(); scene.dispose(); engine.dispose(); });
    const run = (list: AbstractMesh[]): string[] => {
      // As a frame does before its graph: a new render id, the camera's matrices, then every mesh's world matrix.
      scene.incrementRenderId();
      camera.getViewMatrix(true);
      camera.getProjectionMatrix(true);
      for (const mesh of scene.meshes) mesh.computeWorldMatrix();
      cull.objectList = { meshes: list, particleSystems: null };
      retained.execute(cull, stock);
      return (cull.outputObjectList.meshes ?? []).map((mesh) => mesh.name);
    };
    const box = (name: string, x: number) => {
      const mesh = MeshBuilder.CreateBox(name, { size: 1 }, scene);
      mesh.position.set(x, 0, 10);
      return mesh;
    };
    return { run, box, retained };
  }

  it("follows another list, a reordered one and one that changes in place", async () => {
    const { run, box, retained } = await task();
    const [a, b, c, d] = [box("a", -2), box("b", 0), box("c", 2), box("far", 40)];
    expect(run([a, b, c, d])).toEqual(["a", "b", "c"]);
    expect(run([c, a, d])).toEqual(["c", "a"]);
    const list = [b, a, d];
    expect(run(list)).toEqual(["b", "a"]);
    list.splice(1, 1, c, a);
    b.position.x = 30;
    expect(run(list)).toEqual(["c", "a"]);
    expect(retained.work.resyncs).toBe(4);
  });

  it("culls a list holding a mesh twice with Babylon's loop until it changes", async () => {
    const { run, box, retained } = await task();
    const [a, b] = [box("a", -2), box("b", 0)];
    expect(run([a, b, a])).toEqual(["a", "b", "a"]);
    expect(retained.work).toMatchObject({ retainedFrames: 0, stockFrames: 1 });
    expect(run([a, b])).toEqual(["a", "b"]);
    expect(retained.work).toMatchObject({ retainedFrames: 1, stockFrames: 1 });
  });

  it("follows an instance moved to another source, as an instance pool's re-key moves it", async () => {
    const { run, box } = await task();
    const shown = box("shown", 40), faded = box("faded", 40);
    faded.visibility = 0;
    const member = shown.createInstance("member");
    member.position.set(0, 0, 10);
    const list = [shown, faded, member];
    expect(run(list)).toEqual(["member"]);
    // `instance-pool.ts`'s `rekey`: the member reads the new source's visibility from now on.
    shown.removeInstance(member);
    (member as unknown as { _sourceMesh: Mesh })._sourceMesh = faded;
    faded.addInstance(member);
    expect(run(list)).toEqual([]);
  });

  it("follows a mesh that is not ready, and a LOD level, which its master blocks", async () => {
    const { run, box } = await task();
    const loading = box("loading", -2) as Mesh & { _setReady(state: boolean): void };
    const master = box("master", 0), level = box("level", 2);
    const list = [loading, master, level];
    expect(run(list)).toEqual(["loading", "master", "level"]);
    loading._setReady(false);
    master.addLODLevel(50, level);
    expect(run(list)).toEqual(["master"]);
    loading._setReady(true);
    master.removeLODLevel(level);
    expect(run(list)).toEqual(["loading", "master", "level"]);
  });
});
