import {
  createActor,
  identitySerializedTransform,
  type SerializedComponent,
} from "./scene";
import type { QuaternionTuple } from "./euler";

/** Babylon CubeTexture face order: +X, +Y, +Z, -X, -Y, -Z. */
export const SKYBOX_FACE_KEYS = [
  "px",
  "py",
  "pz",
  "nx",
  "ny",
  "nz",
] as const;

export type SkyboxFaceKey = (typeof SKYBOX_FACE_KEYS)[number];

export type SkyboxFaces = Record<SkyboxFaceKey, string | null>;

export const DEFAULT_SKYBOX_SIZE = 1000;

export function parseSkyboxSize(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SKYBOX_SIZE;
}

export function emptySkyboxFaces(): SkyboxFaces {
  return { px: null, py: null, pz: null, nx: null, ny: null, nz: null };
}

export function parseSkyboxFaces(value: unknown): SkyboxFaces {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const faces = emptySkyboxFaces();
  for (const key of SKYBOX_FACE_KEYS) {
    const entry = source[key];
    faces[key] =
      typeof entry === "string" && entry.trim() ? entry.trim() : null;
  }
  return faces;
}

export function skyboxFaceGuids(faces: SkyboxFaces): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const key of SKYBOX_FACE_KEYS) {
    const guid = faces[key];
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    guids.push(guid);
  }
  return guids;
}

export function createSkyboxComponent(
  id: string,
  size = DEFAULT_SKYBOX_SIZE,
): SerializedComponent {
  return {
    id,
    classId: "SkyboxComponent",
    properties: { size, faces: emptySkyboxFaces() },
    parentId: null,
    transform: identitySerializedTransform(),
  };
}

/** Nested `faces.px` keys write into the faces object; other keys stay flat. */
export function patchComponentProperties(
  properties: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  if (key.startsWith("faces.")) {
    const face = key.slice("faces.".length) as SkyboxFaceKey;
    const faces = parseSkyboxFaces(properties.faces);
    if ((SKYBOX_FACE_KEYS as readonly string[]).includes(face)) {
      faces[face] = typeof value === "string" && value.trim() ? value.trim() : null;
    }
    return { ...properties, faces };
  }
  return { ...properties, [key]: value };
}

export const DEFAULT_SCENE_SKYBOX_ACTOR_ID = "actor-skybox";
export const DEFAULT_SCENE_SUN_ACTOR_ID = "actor-sun";
export const DEFAULT_SCENE_SUN_COMPONENT_ID = "component-sun";
export const DEFAULT_SCENE_SKYBOX_COMPONENT_ID = "component-skybox";

/** Warm daylight for the painterly default sky. */
export const DEFAULT_SCENE_SUN_COLOR: [number, number, number] = [
  1, 0.96, 0.88,
];
export const DEFAULT_SCENE_SUN_INTENSITY = 1.5;

/**
 * Light sits above-right so the editor billboard is visible. Rotation aims
 * Babylon local +Z toward the origin (high-sun direction).
 */
export const DEFAULT_SCENE_SUN_POSITION: [number, number, number] = [
  0.35, 1, 0.2,
];

export function createDefaultSkyboxActor() {
  return createActor(DEFAULT_SCENE_SKYBOX_ACTOR_ID, "Skybox", {
    locked: true,
    components: [
      createSkyboxComponent(DEFAULT_SCENE_SKYBOX_COMPONENT_ID),
    ],
  });
}

export function createDefaultSunActor(rotation: QuaternionTuple) {
  return createActor(DEFAULT_SCENE_SUN_ACTOR_ID, "Directional Light", {
    transform: {
      position: DEFAULT_SCENE_SUN_POSITION,
      rotation,
      scale: [1, 1, 1],
    },
    components: [
      {
        id: DEFAULT_SCENE_SUN_COMPONENT_ID,
        classId: "LightComponent",
        properties: {
          intensity: DEFAULT_SCENE_SUN_INTENSITY,
          color: DEFAULT_SCENE_SUN_COLOR,
          lightKind: "directional",
          range: 10,
          outerAngle: 45,
          innerAngle: 30,
          enabled: true,
          castShadows: true,
        },
        parentId: null,
        transform: identitySerializedTransform(),
      },
    ],
  });
}
