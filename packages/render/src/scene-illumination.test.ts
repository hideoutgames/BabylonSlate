import {
  Camera,
  DirectionalLight,
  PointLight,
  Quaternion,
  Scene,
  ShadowGenerator,
  SpotLight,
  UniversalCamera,
  Vector3,
} from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createActor,
  createDefaultScene,
  type SerializedScene,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { DEFAULT_LIGHT_INTENSITY, setupDefaultViewport } from "./viewport";
import {
  AUTHORED_CAMERA_PREFIX,
  AUTHORED_FILL_LIGHT_INTENSITY,
  AUTHORED_LIGHT_PREFIX,
  applyAuthoredCameraLens,
  applyAuthoredCameraProperties,
  cameraRenderAspect,
  refreshAuthoredCameraLenses,
  shadowMapSizeFromQuality,
  syncAuthoredIllumination,
} from "./scene-illumination";

const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
  [];

function createHandle() {
  const handle = createTestEngine();
  handles.push(handle);
  return handle;
}

function sceneWith(
  actors: SerializedScene["actors"],
  settings: Partial<SerializedScene["settings"]> = {},
  viewportMode: SerializedScene["viewportMode"] = "3d",
): SerializedScene {
  const base = createDefaultScene();
  return {
    ...base,
    viewportMode,
    settings: { ...base.settings, ...settings },
    actors,
  };
}

function lightActor(
  id: string,
  properties: Record<string, unknown>,
  rotation: [number, number, number, number] = [0, 0, 0, 1],
) {
  return createActor(id, id, {
    transform: {
      position: [1, 2, 3],
      rotation,
      scale: [1, 1, 1],
    },
    components: [
      {
        id: `${id}-light`,
        classId: "LightComponent",
        properties,
      },
    ],
  });
}

function cameraActor(
  id: string,
  properties: Record<string, unknown>,
  rotation: [number, number, number, number] = [0, 0, 0, 1],
) {
  return createActor(id, id, {
    transform: {
      position: [0, 2, -6],
      rotation,
      scale: [1, 1, 1],
    },
    components: [
      {
        id: `${id}-camera`,
        classId: "CameraComponent",
        properties,
      },
    ],
  });
}

afterEach(() => {
  while (handles.length > 0) {
    const handle = handles.pop();
    handle?.scene.dispose();
    handle?.engine.dispose();
  }
});

describe("shadowMapSizeFromQuality", () => {
  it("maps off/512/1024/2048 and defaults unknown to 1024", () => {
    expect(shadowMapSizeFromQuality("off")).toBeNull();
    expect(shadowMapSizeFromQuality("512")).toBe(512);
    expect(shadowMapSizeFromQuality("1024")).toBe(1024);
    expect(shadowMapSizeFromQuality("2048")).toBe(2048);
    expect(shadowMapSizeFromQuality("low")).toBe(1024);
  });
});

describe("syncAuthoredIllumination", () => {
  it("updates an existing light in place instead of disposing the set", () => {
    const { scene } = createHandle();
    const first = sceneWith([
      lightActor("lamp", {
        lightKind: "point",
        intensity: 1,
        color: [1, 1, 1],
      }),
    ]);
    syncAuthoredIllumination(scene, first, { stealActiveCamera: false });
    const before = scene.getLightByName(`${AUTHORED_LIGHT_PREFIX}lamp`);
    expect(before).toBeInstanceOf(PointLight);
    syncAuthoredIllumination(
      scene,
      sceneWith([
        lightActor("lamp", {
          lightKind: "point",
          intensity: 4,
          color: [1, 0, 0],
        }),
      ]),
      { stealActiveCamera: false },
    );
    const after = scene.getLightByName(`${AUTHORED_LIGHT_PREFIX}lamp`);
    expect(after).toBe(before);
    expect(after!.intensity).toBeCloseTo(4);
    expect(after!.diffuse.r).toBeCloseTo(1);
    expect(after!.diffuse.g).toBeCloseTo(0);
  });

  it("disposes only the authored light whose actor left the document", () => {
    const { scene } = createHandle();
    syncAuthoredIllumination(
      scene,
      sceneWith([
        lightActor("keep", { lightKind: "point", intensity: 1 }),
        lightActor("drop", { lightKind: "point", intensity: 1 }),
      ]),
      { stealActiveCamera: false },
    );
    const keep = scene.getLightByName(`${AUTHORED_LIGHT_PREFIX}keep`);
    syncAuthoredIllumination(
      scene,
      sceneWith([lightActor("keep", { lightKind: "point", intensity: 2 })]),
      { stealActiveCamera: false },
    );
    expect(scene.getLightByName(`${AUTHORED_LIGHT_PREFIX}keep`)).toBe(keep);
    expect(scene.getLightByName(`${AUTHORED_LIGHT_PREFIX}drop`)).toBeNull();
  });

  it("aims directional and spot lights along quaternion times Babylon forward", () => {
    const { scene } = createHandle();
    const half = Math.PI / 4;
    const rotX90: [number, number, number, number] = [
      Math.sin(half),
      0,
      0,
      Math.cos(half),
    ];
    const expected = Vector3.Forward().applyRotationQuaternion(
      new Quaternion(...rotX90),
    );
    syncAuthoredIllumination(
      scene,
      sceneWith([
        lightActor("sun", { lightKind: "directional", intensity: 1 }, rotX90),
        lightActor(
          "spot",
          { lightKind: "spot", intensity: 1, outerAngle: 40, innerAngle: 20 },
          rotX90,
        ),
      ]),
      { stealActiveCamera: false },
    );
    const sun = scene.getLightByName(
      `${AUTHORED_LIGHT_PREFIX}sun`,
    ) as DirectionalLight;
    const spot = scene.getLightByName(`${AUTHORED_LIGHT_PREFIX}spot`) as SpotLight;
    expect(sun.direction.x).toBeCloseTo(expected.x, 5);
    expect(sun.direction.y).toBeCloseTo(expected.y, 5);
    expect(sun.direction.z).toBeCloseTo(expected.z, 5);
    expect(spot.direction.x).toBeCloseTo(expected.x, 5);
    expect(spot.innerAngle).toBeCloseTo((20 * Math.PI) / 180, 5);
    expect(spot.angle).toBeCloseTo((40 * Math.PI) / 180, 5);
  });

  it("creates a detached UniversalCamera using explicit projectionMode", () => {
    const { scene } = createHandle();
    syncAuthoredIllumination(
      scene,
      sceneWith([
        cameraActor("rig", {
          projectionMode: "orthographic",
          orthographicSize: 0,
          fieldOfView: 50,
          nearClip: 0.2,
          farClip: 500,
        }),
      ]),
      { stealActiveCamera: false },
    );
    const camera = scene.getCameraByName(
      `${AUTHORED_CAMERA_PREFIX}rig`,
    ) as UniversalCamera;
    expect(camera).toBeInstanceOf(UniversalCamera);
    expect(camera.getClassName()).toBe("UniversalCamera");
    expect(camera.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
    expect(camera.minZ).toBeCloseTo(0.2);
    expect(camera.maxZ).toBeCloseTo(500);
    expect(camera.inputs.attachedToElement).toBeFalsy();
  });

  it("uses the live render aspect for orthographic extents, not 16:9", () => {
    const { scene, engine } = createHandle();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(800);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(600);
    const camera = new UniversalCamera("lens", Vector3.Zero(), scene);
    applyAuthoredCameraProperties(camera, {
      projectionMode: "orthographic",
      orthographicSize: 5,
    });
    expect(camera.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
    expect(camera.orthoTop).toBeCloseTo(5);
    expect(camera.orthoLeft).toBeCloseTo(-5 * (4 / 3));
    expect(camera.orthoRight).toBeCloseTo(5 * (4 / 3));
  });

  it("switches a live camera from perspective to a non-degenerate ortho box", () => {
    const { scene } = createHandle();
    const camera = new UniversalCamera("switch", Vector3.Zero(), scene);
    applyAuthoredCameraLens(
      camera,
      { projectionMode: "perspective", fieldOfView: 60 },
      16 / 9,
    );
    applyAuthoredCameraLens(
      camera,
      { projectionMode: "orthographic", orthographicSize: 5 },
      4 / 3,
    );
    expect(camera.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA);
    expect(camera.orthoTop).toBeGreaterThan(0);
    expect(camera.orthoLeft).toBeCloseTo(-5 * (4 / 3));
    expect(camera.orthoRight).toBeCloseTo(5 * (4 / 3));
    const matrix = camera.getProjectionMatrix(true).m;
    expect(matrix.every((value) => Number.isFinite(value))).toBe(true);
  });

  it("refreshes authored ortho extents when the render aspect changes", () => {
    const { scene, engine } = createHandle();
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(1920);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(1080);
    syncAuthoredIllumination(
      scene,
      sceneWith([
        cameraActor("rig", {
          projectionMode: "orthographic",
          orthographicSize: 5,
        }),
      ]),
      { stealActiveCamera: false },
    );
    const camera = scene.getCameraByName(
      `${AUTHORED_CAMERA_PREFIX}rig`,
    ) as UniversalCamera;
    vi.spyOn(engine, "getRenderWidth").mockReturnValue(800);
    vi.spyOn(engine, "getRenderHeight").mockReturnValue(600);
    refreshAuthoredCameraLenses(scene);
    expect(camera.orthoLeft).toBeCloseTo(-5 * (4 / 3));
    expect(camera.orthoRight).toBeCloseTo(5 * (4 / 3));
  });

  it("falls back to 16:9 when the canvas has no size so ortho extents stay finite", () => {
    expect(cameraRenderAspect(0, 0)).toBeCloseTo(16 / 9);
    const { scene } = createHandle();
    const camera = new UniversalCamera("empty", Vector3.Zero(), scene);
    applyAuthoredCameraLens(
      camera,
      { projectionMode: "orthographic", orthographicSize: 5 },
      cameraRenderAspect(0, 0),
    );
    expect(Number.isFinite(camera.orthoLeft)).toBe(true);
    expect(camera.orthoLeft).toBeCloseTo(-5 * (16 / 9));
  });

  it("aims the UniversalCamera along actor rotation and zeroes Euler", () => {
    const { scene } = createHandle();
    const yaw: [number, number, number, number] = [
      0,
      Math.SQRT1_2,
      0,
      Math.SQRT1_2,
    ];
    syncAuthoredIllumination(
      scene,
      sceneWith([cameraActor("rig", { projectionMode: "perspective" }, yaw)]),
      { stealActiveCamera: false },
    );
    const camera = scene.getCameraByName(
      `${AUTHORED_CAMERA_PREFIX}rig`,
    ) as UniversalCamera;
    const expected = Vector3.Forward().applyRotationQuaternion(
      new Quaternion(...yaw),
    );
    const forward = camera.getDirection(Vector3.Forward());
    expect(forward.x).toBeCloseTo(expected.x, 5);
    expect(forward.y).toBeCloseTo(expected.y, 5);
    expect(forward.z).toBeCloseTo(expected.z, 5);
    expect(camera.rotation.x).toBeCloseTo(0);
    expect(camera.rotation.y).toBeCloseTo(0);
    expect(camera.rotation.z).toBeCloseTo(0);
  });

  it("does not steal the first camera when stealActiveCamera is false", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);
    const orbit = scene.activeCamera;
    syncAuthoredIllumination(
      scene,
      sceneWith([cameraActor("rig", { projectionMode: "perspective" })]),
      { stealActiveCamera: false },
    );
    expect(scene.activeCamera).toBe(orbit);
  });

  it("steals only the named Default Camera when stealActiveCamera is true", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);
    const orbit = scene.activeCamera;
    const data = sceneWith(
      [
        cameraActor("first", { projectionMode: "perspective" }),
        cameraActor("named", { projectionMode: "perspective" }),
      ],
      {
        mainCameraActorId: "named",
        mainCameraComponentId: "named-camera",
      },
    );
    syncAuthoredIllumination(scene, data, { stealActiveCamera: true });
    expect(scene.activeCamera?.name).toBe(`${AUTHORED_CAMERA_PREFIX}named`);
    expect(scene.activeCamera).not.toBe(orbit);
  });

  it("keeps the existing active camera when Default Camera is missing or stale", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);
    const orbit = scene.activeCamera;
    syncAuthoredIllumination(
      scene,
      sceneWith([cameraActor("rig", { projectionMode: "perspective" })], {
        mainCameraActorId: "gone",
        mainCameraComponentId: "gone-camera",
      }),
      { stealActiveCamera: true },
    );
    expect(scene.activeCamera).toBe(orbit);
  });

  it("applies linear fog and 3D environmentColor as clearColor", () => {
    const { scene } = createHandle();
    syncAuthoredIllumination(
      scene,
      sceneWith([], {
        environmentColor: [0.1, 0.2, 0.3],
        fogEnabled: true,
        fogColor: [0.4, 0.5, 0.6],
        fogStart: 2,
        fogEnd: 40,
      }),
      { stealActiveCamera: false, applyClearColor: true },
    );
    expect(scene.clearColor.r).toBeCloseTo(0.1);
    expect(scene.clearColor.g).toBeCloseTo(0.2);
    expect(scene.clearColor.b).toBeCloseTo(0.3);
    expect(scene.fogEnabled).toBe(true);
    expect(scene.fogMode).toBe(Scene.FOGMODE_LINEAR);
    expect(scene.fogStart).toBeCloseTo(2);
    expect(scene.fogEnd).toBeCloseTo(40);
    expect(scene.fogColor.r).toBeCloseTo(0.4);
  });

  it("keeps chrome clearColor for a 2D editor when applyClearColor is false", () => {
    const { scene } = createHandle();
    const r = scene.clearColor.r;
    syncAuthoredIllumination(
      scene,
      sceneWith([], { environmentColor: [1, 0, 0] }, "2d"),
      { stealActiveCamera: false, applyClearColor: false },
    );
    expect(scene.clearColor.r).toBeCloseTo(r);
  });

  it("attaches one ShadowGenerator to the first castShadows light", () => {
    const { scene } = createHandle();
    const diagnostics: string[] = [];
    syncAuthoredIllumination(
      scene,
      sceneWith([
        lightActor("fill", { lightKind: "point", intensity: 1, castShadows: false }),
        lightActor("key", {
          lightKind: "directional",
          intensity: 1,
          castShadows: true,
        }),
        lightActor("bounce", {
          lightKind: "spot",
          intensity: 1,
          castShadows: true,
        }),
      ]),
      {
        stealActiveCamera: false,
        shadowQuality: "1024",
        onDiagnostic: (message) => diagnostics.push(message),
      },
    );
    const key = scene.getLightByName(`${AUTHORED_LIGHT_PREFIX}key`);
    const bounce = scene.getLightByName(`${AUTHORED_LIGHT_PREFIX}bounce`);
    expect(key?.getShadowGenerator()).toBeInstanceOf(ShadowGenerator);
    expect(
      (key!.getShadowGenerator() as ShadowGenerator).getShadowMap()?.getSize()
        .width,
    ).toBe(1024);
    expect(bounce?.getShadowGenerator()).toBeNull();
    expect(diagnostics.some((line) => /castShadows/i.test(line))).toBe(true);
  });

  it("disables the shadow map when shadowquality is off", () => {
    const { scene } = createHandle();
    const data = sceneWith([
      lightActor("key", {
        lightKind: "directional",
        intensity: 1,
        castShadows: true,
      }),
    ]);
    syncAuthoredIllumination(scene, data, {
      stealActiveCamera: false,
      shadowQuality: "1024",
    });
    const key = scene.getLightByName(`${AUTHORED_LIGHT_PREFIX}key`);
    expect(key?.getShadowGenerator()).toBeTruthy();
    syncAuthoredIllumination(scene, data, {
      stealActiveCamera: false,
      shadowQuality: "off",
    });
    expect(key?.getShadowGenerator()).toBeNull();
  });

  it("dims the unnamed hemispheric fill when an authored light exists", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);
    expect(scene.getLightByName("light")!.intensity).toBe(DEFAULT_LIGHT_INTENSITY);
    syncAuthoredIllumination(
      scene,
      sceneWith([lightActor("lamp", { lightKind: "point", intensity: 1 })]),
      { stealActiveCamera: false },
    );
    expect(scene.getLightByName("light")!.intensity).toBeCloseTo(
      AUTHORED_FILL_LIGHT_INTENSITY,
    );
  });

  it("restores the unnamed hemispheric fill when the last authored light leaves", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);
    syncAuthoredIllumination(
      scene,
      sceneWith([lightActor("lamp", { lightKind: "point", intensity: 1 })]),
      { stealActiveCamera: false },
    );
    syncAuthoredIllumination(scene, sceneWith([]), { stealActiveCamera: false });
    expect(scene.getLightByName("light")!.intensity).toBe(DEFAULT_LIGHT_INTENSITY);
  });

  it("dims the unnamed hemispheric fill when the authored light is disabled", () => {
    const { scene } = createHandle();
    setupDefaultViewport(scene);
    syncAuthoredIllumination(
      scene,
      sceneWith([
        lightActor("lamp", {
          lightKind: "point",
          intensity: 1,
          enabled: false,
        }),
      ]),
      { stealActiveCamera: false },
    );
    expect(scene.getLightByName("light")!.intensity).toBeCloseTo(
      AUTHORED_FILL_LIGHT_INTENSITY,
    );
  });

  it("honors LightComponent enabled", () => {
    const { scene } = createHandle();
    syncAuthoredIllumination(
      scene,
      sceneWith([
        lightActor("lamp", {
          lightKind: "point",
          intensity: 1,
          enabled: false,
        }),
      ]),
      { stealActiveCamera: false },
    );
    expect(
      scene.getLightByName(`${AUTHORED_LIGHT_PREFIX}lamp`)!.isEnabled(),
    ).toBe(false);
  });

  it("places a light at actor transform composed with the component local", () => {
    const { scene } = createHandle();
    syncAuthoredIllumination(
      scene,
      sceneWith([
        createActor("lamp", "Lamp", {
          transform: {
            position: [1, 2, 3],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
          components: [
            {
              id: "lamp-light",
              classId: "LightComponent",
              properties: { lightKind: "point", intensity: 1 },
              transform: {
                position: [2, 0, 0],
                rotation: [0, 0, 0, 1],
                scale: [1, 1, 1],
              },
            },
          ],
        }),
      ]),
      { stealActiveCamera: false },
    );
    const light = scene.getLightByName(
      `${AUTHORED_LIGHT_PREFIX}lamp`,
    ) as PointLight;
    expect(light).toBeInstanceOf(PointLight);
    expect(light.position.x).toBeCloseTo(3);
    expect(light.position.y).toBeCloseTo(2);
    expect(light.position.z).toBeCloseTo(3);
  });
});
