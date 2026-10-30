import {
  Camera,
  NullEngine,
  Scene,
  StandardMaterial,
  UniversalCamera,
  Vector3,
  type AbstractMesh,
  type Effect,
  type Mesh,
} from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackFirstDraws } from "./first-draw-stats";
import { markEditorHelperMesh } from "./helper-mesh";
import { createPrimitiveMesh } from "./scene-component-mesh";
import { RENDERING_GROUP } from "./sorting";
import { OCCLUDER_TRIANGLE_BUDGET, primitiveOccluderShape, setSceneOcclusionCulling, ViewOcclusion } from "./view-occlusion";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const engine of engines.splice(0)) engine.dispose();
});

/** A camera at the origin looking down +Z, a 9 m wall 5 m ahead, and boxes behind and beside it. */
function view() {
  const engine = new NullEngine({ renderWidth: 512, renderHeight: 256, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1 });
  engines.push(engine);
  const scene = new Scene(engine);
  const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
  camera.minZ = 0.1;
  camera.maxZ = 1000;
  scene.activeCamera = camera;
  setSceneOcclusionCulling(scene, true);
  const world = (mesh: Mesh) => {
    mesh.renderingGroupId = RENDERING_GROUP.world;
    return mesh;
  };
  const wall = world(createPrimitiveMesh(scene, "wall", "box"));
  wall.position.set(0, 0, 5);
  wall.scaling.set(6, 4, 0.2);
  const hidden = world(createPrimitiveMesh(scene, "hidden", "box"));
  hidden.position.set(0, 0, 12);
  const beside = world(createPrimitiveMesh(scene, "beside", "box"));
  beside.position.set(9, 0, 12);
  const meshes: AbstractMesh[] = [wall, hidden, beside];
  const occlusion = new ViewOcclusion();
  /** Filters `list` after a frame of the scene, which gives each mesh its colour pass Effect (the first-draw rule). */
  const filter = (list: readonly AbstractMesh[] = meshes) => {
    scene.render();
    return occlusion.filter(list, camera, camera.renderPassId);
  };
  return { engine, scene, camera, wall, hidden, beside, meshes, occlusion, filter, world };
}

const names = (meshes: readonly AbstractMesh[]) => meshes.map((mesh) => mesh.name);

describe("primitiveOccluderShape", () => {
  const min = [-0.75, -0.75, -0.75], max = [0.75, 0.75, 0.75];

  it("is the box itself for a box, inscribed for a sphere and a cylinder, flat and single-sided for a plane", () => {
    expect(primitiveOccluderShape("box", min, max)).toEqual({ min: [-0.75, -0.75, -0.75], max: [0.75, 0.75, 0.75], singleSided: false });
    const sphere = primitiveOccluderShape("sphere", min, max)!;
    // Each corner within the sphere's radius.
    expect(Math.hypot(...sphere.max)).toBeLessThan(0.75);
    const cylinder = primitiveOccluderShape("cylinder", [-0.5, -0.75, -0.5], [0.5, 0.75, 0.5])!;
    expect(Math.hypot(cylinder.max[0], cylinder.max[2])).toBeLessThan(0.5);
    expect(cylinder.max[1]).toBe(0.75);
    expect(primitiveOccluderShape("plane", [-0.75, -0.75, 0], [0.75, 0.75, 0])).toMatchObject({ singleSided: true });
  });

  it("is none for a ground, a sprite or a marker", () => {
    for (const kind of ["ground", "sprite", "tilemap", "pivot"]) expect(primitiveOccluderShape(kind, min, max)).toBeNull();
  });
});

describe("ViewOcclusion", () => {
  it("leaves a box hidden behind a wall out of its own list, and keeps the input list as it was", () => {
    const { meshes, filter, occlusion } = view();
    const input = [...meshes];
    const kept = filter();
    expect(names(kept)).toEqual(["wall", "beside"]);
    expect(kept).not.toBe(meshes);
    expect(meshes).toEqual(input);
    expect(occlusion.diagnostics).toMatchObject({ tested: 3, culled: 1, occluders: 3, triangles: 36 });
  });

  it("returns the input list itself when nothing is hidden", () => {
    const { wall, beside, filter } = view();
    const list = [wall, beside];
    expect(filter(list)).toBe(list);
  });

  it("culls nothing while the scene does not, for an orthographic camera, or in a frame drawn without view culling", () => {
    const off = view();
    setSceneOcclusionCulling(off.scene, false);
    expect(off.filter()).toBe(off.meshes);
    const ortho = view();
    ortho.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    expect(ortho.filter()).toBe(ortho.meshes);
    const start = view();
    start.scene.skipFrustumClipping = true;
    expect(start.filter()).toBe(start.meshes);
  });

  it("keeps meshes the view draws whatever it shows", () => {
    const cases: Array<[string, (mesh: Mesh) => void]> = [
      ["always selected", (mesh) => { mesh.alwaysSelectAsActiveMesh = true; }],
      ["in a later rendering group", (mesh) => { mesh.renderingGroupId = RENDERING_GROUP.foreground; }],
      ["an editor helper", (mesh) => markEditorHelperMesh(mesh)],
      ["with its own depth function", (mesh) => {
        const material = new StandardMaterial("xray", mesh.getScene());
        material.depthFunction = 519;
        mesh.material = material;
      }],
      ["infinitely distant", (mesh) => { mesh.infiniteDistance = true; }],
    ];
    for (const [name, change] of cases) {
      const { hidden, filter } = view();
      change(hidden);
      expect(names(filter()), name).toContain("hidden");
    }
  });

  it("hides behind no blended, alpha-tested or single-sided wall, nor one in another rendering group", () => {
    const cases: Array<[string, (wall: Mesh) => void]> = [
      ["blended", (wall) => {
        const material = new StandardMaterial("glass", wall.getScene());
        material.alpha = 0.5;
        wall.material = material;
      }],
      ["see-through", (wall) => { wall.visibility = 0.5; }],
      ["in the background group", (wall) => { wall.renderingGroupId = RENDERING_GROUP.background; }],
    ];
    for (const [name, change] of cases) {
      const { wall, filter } = view();
      change(wall);
      expect(names(filter()), name).toContain("hidden");
    }
  });

  it("hides behind a plane only with back-face culling off", () => {
    const { scene, hidden, beside, filter, world } = view();
    const plane = world(createPrimitiveMesh(scene, "plane", "plane"));
    plane.position.set(0, 0, 5);
    plane.scaling.set(6, 4, 1);
    const material = new StandardMaterial("sheet", scene);
    plane.material = material;
    expect(names(filter([plane, hidden, beside]))).toContain("hidden");
    material.backFaceCulling = false;
    expect(names(filter([plane, hidden, beside]))).not.toContain("hidden");
  });

  it("culls an instance by its own bounds, and an instance of an occluder occludes", () => {
    const { scene, wall, hidden, filter } = view();
    const instance = hidden.createInstance("hidden-instance");
    instance.renderingGroupId = RENDERING_GROUP.world;
    instance.position.set(9, 0, 12);
    const behind = hidden.createInstance("behind-instance");
    behind.renderingGroupId = RENDERING_GROUP.world;
    behind.position.set(0, 0, 14);
    expect(names(filter([wall, hidden, instance, behind]))).toEqual(["wall", "hidden-instance"]);
    // The wall as an instance of a box occluder.
    const source = createPrimitiveMesh(scene, "source", "box");
    source.renderingGroupId = RENDERING_GROUP.world;
    const copy = source.createInstance("wall-instance");
    copy.renderingGroupId = RENDERING_GROUP.world;
    copy.position.set(0, 0, 5);
    copy.scaling.set(6, 4, 0.2);
    expect(names(filter([copy, hidden]))).toEqual(["wall-instance"]);
  });

  it("keeps a mesh whose colour pass Effect has not drawn yet on WebGL2, so its first draw does not wait for it to come into view", () => {
    /** Filters after a frame, with the hidden box's colour pass Effect one its Engine never drew with. */
    const withFreshEffect = ({ scene, hidden, meshes, occlusion, camera }: ReturnType<typeof view>) => {
      scene.render();
      const subMesh = hidden.subMeshes[0]!;
      const fresh = vi.spyOn(subMesh, "_getDrawWrapper").mockReturnValue({ effect: {} as Effect } as ReturnType<typeof subMesh._getDrawWrapper>);
      try {
        return names(occlusion.filter(meshes, camera, camera.renderPassId));
      } finally {
        fresh.mockRestore();
      }
    };
    const tracked = view();
    trackFirstDraws(tracked.engine);
    expect(withFreshEffect(tracked)).toContain("hidden");
    // Once its Effect has drawn, it is culled.
    expect(names(tracked.filter())).not.toContain("hidden");
    // WebGPU: draws are not tracked (a warm draw creates a pipeline whatever the cull lists), so the rule never applies.
    expect(withFreshEffect(view())).not.toContain("hidden");
  });

  it("draws the largest occluders first, up to the triangle budget", () => {
    const { scene, wall, hidden, filter, occlusion, world } = view();
    const small: AbstractMesh[] = [];
    for (let index = 0; index < OCCLUDER_TRIANGLE_BUDGET / 12 + 20; index++) {
      const mesh = world(createPrimitiveMesh(scene, `post-${index}`, "box"));
      mesh.position.set(-40 + (index % 40) * 2, -6, 30 + Math.floor(index / 40) * 2);
      small.push(mesh);
    }
    expect(names(filter([...small, wall, hidden]))).not.toContain("hidden");
    expect(occlusion.diagnostics.triangles).toBeLessThanOrEqual(OCCLUDER_TRIANGLE_BUDGET);
  });
});
