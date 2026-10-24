import { identitySerializedTransform, type SerializedComponent, type SerializedTransform } from "./scene";

export const REFLECTION_PROBE_CLASS_ID = "ReflectionProbeComponent";

/** Cube face sizes a probe captures at; larger is sharper and costs more GPU memory and capture time. */
export const REFLECTION_PROBE_RESOLUTIONS = [64, 128, 256] as const;
export type ReflectionProbeResolution = (typeof REFLECTION_PROBE_RESOLUTIONS)[number];

export type ReflectionProbeProperties = {
  enabled: boolean;
  /** Full local box extents: surfaces whose centre lies inside reflect this probe, projected onto this box. */
  size: [number, number, number];
  resolution: ReflectionProbeResolution;
};

export function parseReflectionProbeProperties(value: unknown): ReflectionProbeProperties {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const size = Array.isArray(source.size) ? source.size : [];
  const dimension = (entry: unknown): number =>
    typeof entry === "number" && Number.isFinite(entry) && entry > 0 ? entry : 10;
  return {
    enabled: source.enabled !== false,
    size: [dimension(size[0]), dimension(size[1]), dimension(size[2])],
    resolution: REFLECTION_PROBE_RESOLUTIONS.includes(source.resolution as ReflectionProbeResolution)
      ? source.resolution as ReflectionProbeResolution
      : 128,
  };
}

export type ReflectionProbeBinding = {
  id: string;
  properties: ReflectionProbeProperties;
  /** Component-local transforms from probe to actor origin; actor world is separate. */
  transforms: SerializedTransform[];
  error?: string;
};

/** Preserve attachments through non-rendering components without applying actor world twice. */
export function reflectionProbeBindings(components: readonly SerializedComponent[]): ReflectionProbeBinding[] {
  const probes = components.filter((component) => component.classId === REFLECTION_PROBE_CLASS_ID);
  if (!probes.length) return [];
  const byId = new Map(components.map((component) => [component.id, component]));
  return probes.map((component) => {
    const binding: ReflectionProbeBinding = {
      id: component.id,
      properties: parseReflectionProbeProperties(component.properties),
      transforms: [],
    };
    const visited = new Set<string>();
    let current: SerializedComponent | undefined = component;
    while (current) {
      if (visited.has(current.id)) {
        binding.error = "Reflection Probe has a cyclic component attachment.";
        break;
      }
      visited.add(current.id);
      binding.transforms.push(current.transform ?? identitySerializedTransform());
      if (current.parentId && !byId.has(current.parentId)) {
        binding.error = "Reflection Probe has a missing component attachment.";
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return binding;
  });
}

/**
 * Components that never move or animate what an actor draws. Anything else
 * (movement, physics bodies that are not static, animation, particles, cables,
 * ragdolls, deformers, runtime meshes, water) may change between captures.
 */
const STATIC_COMPONENTS: ReadonlySet<string> = new Set([
  "MeshComponent", "LandscapeComponent", "FoliageComponent", "Text3DComponent", "SpriteComponent",
  "TilemapComponent", "SkyboxComponent", "LightComponent", "AreaRectLightComponent",
  "HemisphericFillLightComponent", "FogVolumeComponent", "OutlineComponent", "ColliderComponent",
  "BlockingVolumeComponent", "NavMeshComponent", "NavMeshBlockerComponent", "AudioComponent",
  "SplineComponent", "CameraComponent", "RenderTargetCaptureComponent", "SaveGameComponent",
  REFLECTION_PROBE_CLASS_ID,
]);

/** The engine's logic-free actor class; any other class may run scripts that move it. */
const PLAIN_ACTOR_CLASS_ID = "Actor";

type ProbeActor = {
  id: string;
  classId: string;
  parentId: string | null;
  components: readonly { classId: string; properties?: Record<string, unknown>; destroyed?: boolean }[];
};

/**
 * Whether an actor's visuals stay still for a reflection probe's capture: a
 * logic-free actor with only non-moving components, under a static parent.
 */
export function reflectionProbeStaticActors(actors: readonly ProbeActor[]): Set<string> {
  const byId = new Map(actors.map((actor) => [actor.id, actor]));
  const verdicts = new Map<string, boolean>();
  const isStatic = (actor: ProbeActor, depth: number): boolean => {
    const known = verdicts.get(actor.id);
    if (known !== undefined) return known;
    let result = actor.classId === PLAIN_ACTOR_CLASS_ID && depth < 64 && actor.components.every((component) => {
      if (component.destroyed) return true;
      if (component.classId === "RigidBodyComponent") return component.properties?.motionType === "static";
      return STATIC_COMPONENTS.has(component.classId);
    });
    const parent = actor.parentId ? byId.get(actor.parentId) : undefined;
    if (result && actor.parentId) result = !!parent && isStatic(parent, depth + 1);
    verdicts.set(actor.id, result);
    return result;
  };
  const statics = new Set<string>();
  for (const actor of actors) if (isStatic(actor, 0)) statics.add(actor.id);
  return statics;
}
