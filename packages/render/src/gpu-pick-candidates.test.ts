import {
  BoundingInfo,
  FreeCamera,
  Matrix,
  Mesh,
  MeshBuilder,
  MorphTargetManager,
  MultiMaterial,
  NullEngine,
  PBRMaterial,
  Scene,
  ShaderMaterial,
  Skeleton,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AbstractMesh,
} from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { pickFrustumPlanes } from "./gpu-object-id-picker";
import { pickCandidates } from "./gpu-pick-candidates";
import { setLatticeBinding } from "./lattice-deformer-binding";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** A camera 8 units behind the origin looking at it: the centre pixel's ray runs along the z axis. */
function fixture() {
  const engine = new NullEngine({ renderWidth: 240, renderHeight: 160, textureSize: 4, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new Scene(engine);
  const camera = new FreeCamera("camera", new Vector3(0, 0, -8), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;
  cleanups.push(() => { scene.dispose(); engine.dispose(); });
  // Babylon re-reads a world matrix once per render id and nothing here renders, so placing a mesh recomputes it.
  const box = (name: string, x: number, z = 0, y = 0) => {
    const mesh = MeshBuilder.CreateBox(name, {}, scene);
    mesh.position.set(x, y, z);
    mesh.computeWorldMatrix(true);
    mesh.material = new StandardMaterial(`${name} Material`, scene);
    return mesh;
  };
  const planes = () => pickFrustumPlanes(camera.getViewMatrix(), camera.getProjectionMatrix(), 120, 80, 240, 160);
  const candidates = (...meshes: AbstractMesh[]) => pickCandidates(scene, meshes, planes()).map((mesh) => mesh.name);
  return { engine, scene, camera, box, candidates };
}

describe("pickCandidates", () => {
  it("keeps the meshes whose bounds meet the pixel's clip volume and drops the rest", () => {
    const { camera, box, candidates } = fixture();
    const meshes = [
      box("ahead", 0, 0), box("behind the camera", 0, -20), box("beyond the far plane", 0, camera.maxZ + 50),
      box("beside", 3), box("far beside", 50), box("above", 0, 0, 40), box("on the ray, nearer", 0, -3),
    ];
    expect(candidates(...meshes)).toEqual(["ahead", "on the ray, nearer"]);
  });

  it("follows a mesh that moves onto the ray", () => {
    const { box, candidates } = fixture();
    const mover = box("mover", 6);
    expect(candidates(mover)).toEqual([]);
    mover.position.x = 0;
    mover.computeWorldMatrix(true);
    expect(candidates(mover)).toEqual(["mover"]);
  });

  it("treats a PBR surface like a standard one", () => {
    const { scene, box, candidates } = fixture();
    const pbr = box("pbr", 50);
    pbr.material = new PBRMaterial("pbr material", scene);
    expect(candidates(pbr)).toEqual([]);
  });

  it("keeps a mesh with unusable bounds, since nothing can be ruled out", () => {
    const { box, candidates } = fixture();
    const broken = box("broken", 50);
    broken.setBoundingInfo(new BoundingInfo(new Vector3(NaN, 0, 0), new Vector3(NaN, 1, 1)));
    expect(candidates(broken)).toEqual(["broken"]);
  });

  it("keeps everything when points can rasterise wider than their vertex", () => {
    const { scene, box, candidates } = fixture();
    const beside = box("beside", 50);
    scene.forcePointsCloud = true;
    expect(candidates(beside)).toEqual(["beside"]);
  });

  describe("a mesh that can draw outside its bounds is always kept, however far from the ray", () => {
    type Arrange = (mesh: Mesh, context: ReturnType<typeof fixture>) => void;
    const cases: Array<[string, Arrange]> = [
      ["is skinned", (mesh, { scene }) => { mesh.skeleton = new Skeleton("rig", "rig", scene); }],
      ["has morph targets", (mesh, { scene }) => { mesh.morphTargetManager = new MorphTargetManager(scene); }],
      ["has a material with padded bounds", (mesh) => { mesh.material!.metadata = { boundsPadding: 0.5 }; }],
      ["is deformed by a lattice", (mesh) => {
        setLatticeBinding(mesh, { active: true, bindEffect: () => {}, bindBuffer: () => {} });
        cleanups.push(() => setLatticeBinding(mesh));
      }],
      ["is water", (mesh) => { mesh.metadata = { slateWater: true }; }],
      ["has thin instances", (mesh, { engine }) => {
        engine.getCaps().instancedArrays = true;
        mesh.thinInstanceAdd(Matrix.Translation(40, 0, 0));
      }],
      ["follows the camera as a billboard", (mesh) => { mesh.billboardMode = Mesh.BILLBOARDMODE_ALL; }],
      ["hangs below a billboard", (mesh, { scene }) => {
        const holder = new TransformNode("holder", scene);
        holder.billboardMode = Mesh.BILLBOARDMODE_ALL;
        mesh.parent = holder;
      }],
      ["does not keep its bounds in sync", (mesh) => { mesh.doNotSyncBoundingInfo = true; }],
      ["is drawn with a shader-authored material", (mesh, { scene }) => {
        mesh.material = new ShaderMaterial("custom", scene, { vertex: "custom", fragment: "custom" }, {});
      }],
      ["has a shader-authored sub-material", (mesh, { scene }) => {
        const slots = new MultiMaterial("slots", scene);
        slots.subMaterials = [new StandardMaterial("plain", scene), new ShaderMaterial("custom", scene, { vertex: "custom", fragment: "custom" }, {})];
        mesh.material = slots;
      }],
      ["is a point cloud", (mesh) => { mesh.material!.pointsCloud = true; }],
      ["leads a level-of-detail chain", (mesh, { box }) => { mesh.addLODLevel(10, box("lod", 50)); }],
    ];

    it.each(cases)("when it %s", (_name, arrange) => {
      const context = fixture();
      const mesh = context.box("deformed", 50);
      arrange(mesh, context);
      expect(context.candidates(mesh)).toEqual(["deformed"]);
    });

    it("keeps both ends of a regular-instance batch", () => {
      const { box, candidates } = fixture();
      const source = box("source", 50);
      const instance = source.createInstance("instance");
      instance.position.x = -50;
      expect(candidates(source, instance)).toEqual(["source", "instance"]);
    });

    it("keeps the level-of-detail meshes that borrow their master's bounds", () => {
      const { box, candidates } = fixture();
      const master = box("master", 50), level = box("lod", 50);
      master.addLODLevel(10, level);
      expect(candidates(level)).toEqual(["lod"]);
    });
  });
});
