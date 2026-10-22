import { BoundingBox, Camera, FreeCamera, Frustum, Matrix, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { fogVolumeBindings, identitySerializedTransform, type SerializedComponent } from "@haptic/core";
import { afterEach, expect, it, vi } from "vitest";
import {
  hasFogVolumes,
  removeFogVolumes,
  selectFogVolumes,
  setFogVolumesVisible,
  upsertFogVolumes,
} from "./fog-volumes";
import { sceneRenderingSettings } from "./render-settings";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); vi.restoreAllMocks(); });

function fixture(rightHanded = false) {
  const engine = new NullEngine({ renderWidth: 128, renderHeight: 128, textureSize: 128, deterministicLockstep: false, lockstepMaxSteps: 1 });
  engines.push(engine);
  const scene = new Scene(engine);
  scene.useRightHandedSystem = rightHanded;
  const camera = new FreeCamera("camera", Vector3.Zero(), scene);
  camera.minZ = 0.1;
  camera.maxZ = 100;
  const root = new TransformNode("fog actor", scene);
  return { scene, camera, root };
}

function component(id: string, position: [number, number, number], properties: Record<string, unknown> = {}): SerializedComponent {
  return {
    id,
    classId: "FogVolumeComponent",
    properties: { size: [1, 1, 1], ...properties },
    transform: { ...identitySerializedTransform(), position },
  };
}

it("preserves the full parent/component transform and updates moving or degenerate roots", () => {
  const { scene, camera, root } = fixture();
  const parent = new TransformNode("nonuniform parent", scene);
  parent.scaling.set(2, 1, 1);
  root.parent = parent;
  root.rotation.z = Math.PI / 4;
  root.position.z = 10;
  upsertFogVolumes(scene, "actor", root, fogVolumeBindings([
    component("fog", [1, 0, 0], { size: [2, 4, 6] }),
  ]));
  const volume = selectFogVolumes(scene, camera, 30)[0]!;
  const localX = Vector3.TransformCoordinates(new Vector3(2 * Math.SQRT2, Math.SQRT2, 10), volume.inverseWorld);
  expect(localX.x).toBeCloseTo(1);
  expect(localX.y).toBeCloseTo(0);
  expect(localX.z).toBeCloseTo(0);
  const localY = Vector3.TransformCoordinates(new Vector3(-Math.SQRT2, 3 / Math.SQRT2, 10), volume.inverseWorld);
  expect(localY.x).toBeCloseTo(0);
  expect(localY.y).toBeCloseTo(1);

  // A second view or editor edit can request fog again within the same frame.
  parent.position.x = 1;
  const moved = selectFogVolumes(scene, camera, 30)[0]!;
  const point = Vector3.TransformCoordinates(new Vector3(1 + 2 * Math.SQRT2, Math.SQRT2, 10), moved.inverseWorld);
  expect(point.x).toBeCloseTo(1);
  expect(point.y).toBeCloseTo(0);
  root.scaling.x = 0;
  expect(selectFogVolumes(scene, camera, 30)).toHaveLength(0);
  root.scaling.x = 1;
  expect(selectFogVolumes(scene, camera, 30)).toHaveLength(1);
});

it("admits the nearest eight visible volumes and rejects disabled, invalid and distant sources", () => {
  const { scene, camera, root } = fixture();
  const components = Array.from({ length: 10 }, (_, index) => component(`fog-${10 - index}`, [0, 0, 10 - index]));
  components.push(
    component("offscreen", [100, 0, 1]),
    component("behind", [0, 0, -2]),
    component("distant", [0, 0, 90]),
    component("disabled", [0, 0, 0.5], { enabled: false }),
    component("empty", [0, 0, 0.5], { density: 0 }),
    { ...component("bad-parent", [0, 0, 0.5]), parentId: "missing" },
  );
  upsertFogVolumes(scene, "actor", root, fogVolumeBindings(components));
  expect(selectFogVolumes(scene, camera, 20).map((entry) => entry.id)).toEqual([
    "fog-1", "fog-2", "fog-3", "fog-4", "fog-5", "fog-6", "fog-7", "fog-8",
  ]);
  root.setEnabled(false);
  expect(selectFogVolumes(scene, camera, 20)).toHaveLength(0);
});

it.each([false, true])("keeps camera-containing and orthographic edge volumes without out-of-range crowding (right handed: %s)", (rightHanded) => {
  // Babylon captures the scene's forward axis when it constructs the camera.
  const { scene, camera, root } = fixture(rightHanded);
  camera.setTarget(Vector3.Forward());
  upsertFogVolumes(scene, "actor", root, fogVolumeBindings([
    component("inside", [0, 0, 0], { size: [4, 4, 4], shape: "sphere" }),
    component("edge", [50, 0, 5], { shape: "sphere" }),
    // A sliver lies within minZ + Maximum Distance, despite its center being
    // farther away. These off-center rays must survive the eight-volume limit.
    component("range-edge", [50, 0, 10.5]),
    ...Array.from({ length: 8 }, (_, index) => component(`too-deep-${index}`, [0, 0, 20 + index])),
  ]));
  expect(selectFogVolumes(scene, camera, 10).map((entry) => entry.id)).toEqual(["inside"]);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -60;
  camera.orthoRight = 60;
  camera.orthoBottom = -10;
  camera.orthoTop = 10;
  expect(selectFogVolumes(scene, camera, 10).map((entry) => entry.id)).toEqual(["inside", "edge", "range-edge"]);
});

it("retains registry ownership across root replacement and releases fog demand on hide/removal/disposal", () => {
  const { scene, camera, root } = fixture();
  const bindings = fogVolumeBindings([component("fog", [0, 0, 5])]);
  upsertFogVolumes(scene, "actor", root, bindings);
  expect(hasFogVolumes(scene)).toBe(true);
  expect(sceneRenderingSettings(scene).effectsPlan?.volumetricLighting).toMatchObject({ density: 0 });
  setFogVolumesVisible(scene, "actor", false);
  expect(selectFogVolumes(scene, camera, 20)).toHaveLength(0);
  expect(hasFogVolumes(scene)).toBe(false);
  const replacement = new TransformNode("replacement", scene);
  upsertFogVolumes(scene, "actor", replacement, bindings);
  root.dispose();
  expect(hasFogVolumes(scene)).toBe(false);
  expect(selectFogVolumes(scene, camera, 20)).toHaveLength(0);
  setFogVolumesVisible(scene, "actor", true);
  expect(selectFogVolumes(scene, camera, 20)).toHaveLength(1);
  expect(removeFogVolumes(scene, "actor")).toBe(true);
  expect(hasFogVolumes(scene)).toBe(false);
  upsertFogVolumes(scene, "actor", replacement, bindings);
  replacement.dispose();
  expect(hasFogVolumes(scene)).toBe(false);
  expect(sceneRenderingSettings(scene).effectsPlan?.volumetricLighting ?? null).toBeNull();
});

/** Positions straddling and clear of every frustum plane of the fixture camera (the sides sit near +-0.42 x depth). */
function frustumLattice(): [number, number, number][] {
  const positions: [number, number, number][] = [];
  for (const z of [-3, 0, 0.05, 0.1, 1, 20, 60, 99, 100, 101, 130])
    for (const sx of [-1.2, -0.9, -0.43, -0.42, -0.3, 0, 0.3, 0.42, 0.43, 0.9, 1.2])
      for (const sy of [-1.2, -0.42, 0, 0.42, 1.2]) positions.push([sx * z, sy * z, z]);
  return positions;
}

/** The exact corner test alone, computed from the volume's transformed unit box. */
function insideFrustum(camera: Camera, root: TransformNode, position: [number, number, number], half: number): boolean {
  const world = Matrix.Scaling(half, half, half).multiply(Matrix.Translation(...position)).multiply(root.computeWorldMatrix(true));
  const box = new BoundingBox(new Vector3(-1, -1, -1), new Vector3(1, 1, 1), world);
  return box.isInFrustum(Frustum.GetPlanes(camera.getTransformationMatrix()));
}

const roots: [string, (root: TransformNode, scene: Scene) => void][] = [
  ["a plain root", () => {}],
  ["a sheared, rotated root", (root, scene) => {
    const parent = new TransformNode("nonuniform parent", scene);
    parent.scaling.set(3, 1, 0.5);
    root.parent = parent;
    root.rotation.set(0.4, 0.6, 0.3);
    root.position.z = 10;
  }],
];

it.each(roots)("selects exactly the volumes whose corners are in the frustum, for %s", (_name, arrange) => {
  const { scene, camera, root } = fixture();
  arrange(root, scene);
  const verdicts = new Set<boolean>();
  for (const position of frustumLattice()) {
    upsertFogVolumes(scene, "actor", root, fogVolumeBindings([component("fog", position, { size: [2, 2, 2] })]));
    const selected = selectFogVolumes(scene, camera, 1e6).length === 1;
    const expected = insideFrustum(camera, root, position, 1);
    expect(selected, `position ${position.join(",")}`).toBe(expected);
    verdicts.add(expected);
  }
  expect([...verdicts].sort()).toEqual([false, true]);
});

it("selects exactly the volumes in an orthographic view that also overlap its depth range", () => {
  const { scene, camera, root } = fixture();
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -10; camera.orthoRight = 10; camera.orthoBottom = -10; camera.orthoTop = 10;
  const maxDistance = 50;
  const verdicts = new Set<boolean>();
  for (const [x, y, z] of frustumLattice().map(([px, py, pz]) => [px / 4, py / 4, pz] as [number, number, number])) {
    upsertFogVolumes(scene, "actor", root, fogVolumeBindings([component("fog", [x, y, z], { size: [2, 2, 2] })]));
    const selected = selectFogVolumes(scene, camera, maxDistance).length === 1;
    const expected = insideFrustum(camera, root, [x, y, z], 1) && z + 1 > camera.minZ && z - 1 < camera.minZ + maxDistance;
    expect(selected, `position ${[x, y, z].join(",")}`).toBe(expected);
    verdicts.add(expected);
  }
  expect([...verdicts].sort()).toEqual([false, true]);
});

it("settles volumes clear of the frustum or wholly inside it without the corner test, leaving only straddlers to it", () => {
  const { scene, camera, root } = fixture();
  const cornerTest = vi.spyOn(BoundingBox.prototype, "isInFrustum");
  const offscreen = Array.from({ length: 40 }, (_, index) => component(`away-${index}`, [1000 + index, 0, 20]));
  upsertFogVolumes(scene, "actor", root, fogVolumeBindings(offscreen));
  expect(selectFogVolumes(scene, camera, 1e6)).toHaveLength(0);
  expect(cornerTest).not.toHaveBeenCalled();
  upsertFogVolumes(scene, "actor", root, fogVolumeBindings([component("centre", [0, 0, 20])]));
  expect(selectFogVolumes(scene, camera, 1e6).map((entry) => entry.id)).toEqual(["centre"]);
  expect(cornerTest).not.toHaveBeenCalled();
  // At depth 20 the right side plane is near x = 8.46, so this volume crosses it.
  upsertFogVolumes(scene, "actor", root, fogVolumeBindings([component("edge", [8.4, 0, 20], { size: [2, 2, 2] })]));
  expect(selectFogVolumes(scene, camera, 1e6).map((entry) => entry.id)).toEqual(["edge"]);
  expect(cornerTest).toHaveBeenCalledTimes(1);
});
