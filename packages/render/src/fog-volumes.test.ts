import { Camera, FreeCamera, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { fogVolumeBindings, identitySerializedTransform, type SerializedComponent } from "@babylonslate/core";
import { afterEach, expect, it } from "vitest";
import {
  hasFogVolumes,
  removeFogVolumes,
  selectFogVolumes,
  setFogVolumesVisible,
  upsertFogVolumes,
} from "./fog-volumes";
import { sceneRenderingSettings } from "./render-settings";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

function fixture() {
  const engine = new NullEngine({ renderWidth: 128, renderHeight: 128, textureSize: 128, deterministicLockstep: false, lockstepMaxSteps: 1 });
  engines.push(engine);
  const scene = new Scene(engine);
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

it("keeps camera-containing and orthographic edge volumes in the selection", () => {
  const { scene, camera, root } = fixture();
  upsertFogVolumes(scene, "actor", root, fogVolumeBindings([
    component("inside", [0, 0, 0], { size: [4, 4, 4], shape: "sphere" }),
    component("edge", [50, 0, 5], { shape: "sphere" }),
  ]));
  expect(selectFogVolumes(scene, camera, 10).map((entry) => entry.id)).toEqual(["inside"]);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -60;
  camera.orthoRight = 60;
  camera.orthoBottom = -10;
  camera.orthoTop = 10;
  expect(selectFogVolumes(scene, camera, 10).map((entry) => entry.id)).toEqual(["inside", "edge"]);
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
