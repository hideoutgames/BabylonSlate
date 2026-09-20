import { Matrix, Quaternion, Vector3, type Mesh } from "@babylonjs/core";
import {
  identitySerializedTransform,
  lightMobility,
  meshBakeParticipation,
  resolveEnvironmentLightingSettings,
  type BakeGeometrySource,
  type BakeAuthoringSettings,
  type BakeInputHashes,
  type BakedLightingSource,
  type BakedReceiverIdentity,
  type EnvironmentLightingSettings,
  type GeneratedBakeTopology,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
  type SerializedTransform,
} from "@babylonslate/core";
import {
  fingerprintBakeGeometry,
  remapBakeGeometry,
  sha256Hex,
  stableStringify,
} from "@babylonslate/assets";
import {
  resolveBakeDiffuseClosure,
  type BakeDiffuseClosure,
  type MaterialDocument,
  type MaterialFunctionDocument,
} from "@babylonslate/shader-graph";
import type {
  BakePrototypeInput,
  BakePrototypeMesh,
} from "./bake-prototype-input";
import { snapshotBakeSourceMesh } from "./bake-mesh-snapshot";

export type SceneBakeSettings = BakeAuthoringSettings;
export interface SceneBakeOwner {
  sceneGuid: string;
  generation: number;
}
export interface PreparedBakeMesh {
  identity: BakedReceiverIdentity;
  receiver: boolean;
  source: BakeGeometrySource;
  world: number[];
  transport: BakePrototypeMesh;
  hashes: Pick<BakeInputHashes, "geometry" | "uv" | "transforms" | "materials">;
}
export interface PreparedSceneBake {
  owner: SceneBakeOwner;
  settings: SceneBakeSettings;
  inputs: BakeInputHashes;
  dependencies: string[];
  meshes: PreparedBakeMesh[];
  sources: BakedLightingSource[];
  /** Sum the physical-E results; Stationary direct remains exclusively realtime. */
  batches: Array<{
    mode: "full" | "indirect";
    sourceIds: string[];
    lights: BakePrototypeInput["lights"];
  }>;
}

export class StaleSceneBakeError extends Error {
  constructor() {
    super(
      "Scene changed during Bake preparation; the previous bake is retained.",
    );
    this.name = "StaleSceneBakeError";
  }
}

/** Attach generated UVs using the same corner conversion as world-space transport. */
export function preparedBakeReceiverTransport(
  mesh: PreparedBakeMesh,
  topology: GeneratedBakeTopology,
): BakePrototypeMesh {
  if (!mesh.receiver)
    throw new Error("Only Static Receivers can own bake atlas coordinates.");
  remapBakeGeometry(mesh.source, topology);
  const order =
    Matrix.FromArray(mesh.world).determinant() < 0 ? [0, 1, 2] : [0, 2, 1];
  const uv2 = new Float32Array(topology.indices.length * 2);
  for (let triangle = 0; triangle < topology.indices.length; triangle += 3) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = topology.indices[triangle + order[corner]];
      uv2[(triangle + corner) * 2] = topology.uv2[vertex * 2];
      uv2[(triangle + corner) * 2 + 1] = topology.uv2[vertex * 2 + 1];
    }
  }
  return {
    positions: mesh.transport.positions.slice(),
    uv2,
    material: {
      ...mesh.transport.material,
      albedo: [...mesh.transport.material.albedo],
    },
  };
}

const hash = (value: unknown) =>
  sha256Hex(new TextEncoder().encode(stableStringify(value)));
const sorted = <T extends { key: string }>(values: T[]) =>
  values.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
function matrix(transform: SerializedTransform): Matrix {
  const values = [
    ...transform.position,
    ...transform.rotation,
    ...transform.scale,
  ];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    transform.scale.some((value) => value === 0)
  )
    throw new Error("Bake transforms must be finite and nonsingular.");
  const quaternion = Quaternion.FromArray(transform.rotation);
  if (Math.abs(quaternion.lengthSquared() - 1) > 1e-4)
    throw new Error("Bake rotations must be normalized quaternions.");
  return Matrix.Compose(
    Vector3.FromArray(transform.scale),
    quaternion,
    Vector3.FromArray(transform.position),
  );
}

/** Authored matrices avoid camera/floating-origin mutations and preserve attachment hierarchy. */
function transforms(actors: readonly SerializedActor[]) {
  const byId = new Map(actors.map((actor) => [actor.id, actor]));
  if (byId.size !== actors.length)
    throw new Error("Bake Scene has duplicate actor identities.");
  const worlds = new Map<string, Matrix>();
  const visiting = new Set<string>();
  const actorWorld = (actor: SerializedActor): Matrix => {
    const cached = worlds.get(actor.id);
    if (cached) return cached;
    if (visiting.has(actor.id))
      throw new Error("Bake Scene has cyclic actor attachments.");
    visiting.add(actor.id);
    let world = matrix(actor.transform);
    if (actor.parentId) {
      const parent = byId.get(actor.parentId);
      if (!parent)
        throw new Error("Bake Scene has a missing actor attachment.");
      world = world.multiply(actorWorld(parent));
    }
    visiting.delete(actor.id);
    worlds.set(actor.id, world);
    return world;
  };
  return (actor: SerializedActor, component: SerializedComponent) => {
    const components = new Map(
      actor.components.map((entry) => [entry.id, entry]),
    );
    if (components.size !== actor.components.length)
      throw new Error("Bake actor has duplicate component identities.");
    const stack = new Set<string>();
    const componentWorld = (entry: SerializedComponent): Matrix => {
      if (stack.has(entry.id))
        throw new Error("Bake Scene has cyclic component attachments.");
      stack.add(entry.id);
      const local = matrix(entry.transform ?? identitySerializedTransform());
      if (!entry.parentId) return local.multiply(actorWorld(actor));
      const parent = components.get(entry.parentId);
      if (!parent)
        throw new Error("Bake Scene has a missing component attachment.");
      return local.multiply(componentWorld(parent));
    };
    return componentWorld(component);
  };
}

function transportPositions(
  source: BakeGeometrySource,
  world: Matrix,
): Float32Array {
  const attribute = source.attributes.find(
    (entry) => entry.name === "position",
  );
  if (
    !attribute ||
    attribute.componentType !== "f32" ||
    attribute.components !== 3 ||
    attribute.normalized
  )
    throw new Error("Bake positions require packed float32 XYZ data.");
  const view = new DataView(
    attribute.data.buffer,
    attribute.data.byteOffset,
    attribute.data.byteLength,
  );
  const result = new Float32Array(source.indices.length * 3);
  const point = new Vector3();
  // Babylon's left-handed primitive winding is opposite the provider's geometric cross product.
  const order = world.determinant() < 0 ? [0, 1, 2] : [0, 2, 1];
  for (let triangle = 0; triangle < source.indices.length; triangle += 3) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = source.indices[triangle + order[corner]];
      point.set(
        view.getFloat32(vertex * 12, true),
        view.getFloat32(vertex * 12 + 4, true),
        view.getFloat32(vertex * 12 + 8, true),
      );
      Vector3.TransformCoordinatesToRef(point, world, point);
      if (
        ![point.x, point.y, point.z].every(
          (value) => Number.isFinite(value) && Math.abs(value) <= 100,
        )
      )
        throw new Error(
          "Bake provider currently supports world coordinates within ±100 units.",
        );
      point.toArray(result, (triangle + corner) * 3);
    }
  }
  return result;
}

/** Capture all mutable source data before the first await. This operation never publishes or changes live lighting. */
export async function prepareSceneBake(options: {
  owner: SceneBakeOwner;
  current: () => SceneBakeOwner;
  document: SerializedScene;
  /** Resolves the exact component visual, after editor Scene/model readiness. */
  meshForComponent: (actorId: string, componentId: string) => Mesh | null;
  materials: ReadonlyMap<string, MaterialDocument>;
  functions?: Record<string, MaterialFunctionDocument>;
  projectEnvironment?: Partial<EnvironmentLightingSettings>;
  settings: SceneBakeSettings;
  signal?: AbortSignal;
}): Promise<PreparedSceneBake> {
  // Callers may carry live editor methods beside this structural value type.
  // Only stable serializable ownership belongs in the prepared/persisted data.
  const owner: SceneBakeOwner = {
    sceneGuid: options.owner.sceneGuid,
    generation: options.owner.generation,
  };
  const signal = options.signal;
  const current = options.current;
  const check = () => {
    if (signal?.aborted)
      throw new DOMException("Bake preparation cancelled.", "AbortError");
    const now = current();
    if (
      now.sceneGuid !== owner.sceneGuid ||
      now.generation !== owner.generation
    )
      throw new StaleSceneBakeError();
  };
  check();
  if (!owner.sceneGuid || !Number.isSafeInteger(owner.generation))
    throw new Error("Bake needs an authored Scene identity and generation.");
  if (
    options.document.actors.length > 1024 ||
    options.document.actors.reduce(
      (count, actor) => count + actor.components.length,
      0,
    ) > 4096
  )
    throw new Error(
      "Bake preparation admits at most 1024 actors and 4096 components.",
    );
  const document = structuredClone(options.document);
  const settings = { ...options.settings };
  if (document.viewportMode !== "3d")
    throw new Error("Bake Lighting requires a 3D Scene.");
  for (const [key, minimum, maximum] of [
    ["resolution", 16, 128],
    ["paddingTexels", 1, 16],
    ["samples", 1, 4096],
    ["bounces", 2, 8],
  ] as const) {
    if (
      !Number.isInteger(settings[key]) ||
      settings[key] < minimum ||
      settings[key] > maximum
    )
      throw new Error(
        `Bake ${key} must be an integer in ${minimum}..${maximum}.`,
      );
  }
  if (settings.paddingTexels * 2 >= settings.resolution)
    throw new Error("Bake padding leaves no atlas interior.");
  const environment = resolveEnvironmentLightingSettings(
    options.projectEnvironment,
    document.settings.environmentLighting,
  );
  if (environment.enabled && document.settings.environmentTextureGuid)
    throw new Error(
      "Bake environment cube transport and source attribution are not implemented yet; the previous bake is retained.",
    );
  if (document.actors.length > 1024)
    throw new Error("Bake preparation admits at most 1024 actors.");
  const worldOf = transforms(document.actors);
  const actorById = new Map(document.actors.map((actor) => [actor.id, actor]));
  const assertFixedOwner = (actor: SerializedActor) => {
    const visited = new Set<string>();
    let owner: SerializedActor | undefined = actor;
    while (owner) {
      if (visited.has(owner.id))
        throw new Error("Bake Scene has cyclic actor attachments.");
      visited.add(owner.id);
      if (
        owner.components.some(
          (entry) =>
            /Animation/.test(entry.classId) ||
            (entry.classId === "RigidBodyComponent" &&
              entry.properties.motionType !== "static"),
        )
      )
        throw new Error(
          `Bake actor ${actor.name} has potentially moving or animated ownership through ${owner.name}.`,
        );
      owner = owner.parentId ? actorById.get(owner.parentId) : undefined;
    }
  };
  const dependencies = new Set<string>();
  const meshSources: Array<{
    key: string;
    identity: BakedReceiverIdentity;
    receiver: boolean;
    source: BakeGeometrySource;
    world: number[];
    transport: BakePrototypeMesh;
    closure: BakeDiffuseClosure;
  }> = [];
  const lightSources: Array<{
    key: string;
    actorId: string;
    componentId: string;
    mobility: "static" | "stationary";
    light: BakePrototypeInput["lights"][number];
  }> = [];
  let triangles = 0;
  let geometryBytes = 0;
  for (const actor of document.actors) {
    for (const component of actor.components) {
      check();
      const key = stableStringify([actor.id, component.id]);
      if (
        component.classId === "LightComponent" ||
        component.classId === "HemisphericFillLightComponent"
      ) {
        const mobility = lightMobility(component.properties);
        if (
          mobility === "dynamic" ||
          component.properties.enabled === false ||
          component.properties.intensity === 0
        )
          continue;
        assertFixedOwner(actor);
        if (actor.parentId || component.parentId)
          throw new Error(
            `Bake light ${actor.name} needs complete authored attachment parity in the realtime renderer before parented point baking can be enabled.`,
          );
        if (
          actor.components.filter(
            (entry) =>
              entry.classId === "LightComponent" ||
              entry.classId === "HemisphericFillLightComponent",
          ).length > 1
        )
          throw new Error(
            `Bake actor ${actor.name} needs per-component realtime light identity before multiple light components can be baked.`,
          );
        if (
          component.classId !== "LightComponent" ||
          (component.properties.lightKind ?? "point") !== "point"
        )
          throw new Error(
            `Bake light ${actor.name} currently requires Point transport.`,
          );
        const intensity = component.properties.intensity ?? 1;
        const color = component.properties.color ?? [1, 1, 1];
        if (
          typeof intensity !== "number" ||
          !Number.isFinite(intensity) ||
          intensity < 0 ||
          intensity > 100 ||
          !Array.isArray(color) ||
          color.length !== 3 ||
          color.some(
            (value) =>
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              value < 0 ||
              value > 100,
          )
        )
          throw new Error(
            `Bake light ${actor.name} has unsupported intensity or linear RGB values.`,
          );
        const point = Vector3.TransformCoordinates(
          Vector3.Zero(),
          worldOf(actor, component),
        );
        if (point.asArray().some((value) => Math.abs(value) > 100))
          throw new Error("Bake light positions exceed ±100 world units.");
        lightSources.push({
          key,
          actorId: actor.id,
          componentId: component.id,
          mobility,
          light: {
            kind: "point",
            position: [point.x, point.y, point.z],
            color: [...color] as [number, number, number],
            intensity,
          },
        });
      } else if (component.classId === "MeshComponent") {
        // Mesh visibility is authored per actor; lights instead use their own Enabled field.
        if (!actor.visible) continue;
        const participation = meshBakeParticipation(component.properties);
        if (participation === "none") continue;
        if (component.properties.assetGuid)
          throw new Error(
            `Bake model ${actor.name} needs verified source node/mesh/primitive provenance; renderer order cannot identify it.`,
          );
        assertFixedOwner(actor);
        const guid = component.properties.materialGuid;
        if (typeof guid !== "string" || !options.materials.has(guid))
          throw new Error(
            `Bake mesh ${actor.name} needs an authored supported Material; the default checker is not a constant diffuse closure.`,
          );
        const closure = resolveBakeDiffuseClosure(
          options.materials.get(guid)!,
          { functions: options.functions },
        );
        if (closure.emission.some((value) => value !== 0))
          throw new Error(
            "Bake emissive-source attribution is not implemented yet; the previous bake is retained.",
          );
        dependencies.add(guid);
        closure.dependencies.forEach((dependency) =>
          dependencies.add(dependency),
        );
        const mesh = options.meshForComponent(actor.id, component.id);
        if (!mesh) throw new Error(`Bake mesh ${actor.name} is not ready.`);
        if (mesh.getScene().useRightHandedSystem)
          throw new Error(
            "Bake authored primitive extraction currently requires the editor's left-handed Scene.",
          );
        // A receiver whose authored geometry is retained under an applied bake
        // is fingerprinted and transported from that authored source.
        const source = snapshotBakeSourceMesh(mesh);
        geometryBytes +=
          source.indices.byteLength +
          source.attributes.reduce(
            (sum, attribute) => sum + attribute.data.byteLength,
            0,
          );
        if (geometryBytes > 32 * 1024 * 1024)
          throw new Error(
            "Bake Scene geometry exceeds the 32 MiB source snapshot limit.",
          );
        triangles += source.indices.length / 3;
        if (triangles > 512 || meshSources.length >= 128)
          throw new Error(
            "Bake Scene exceeds the current 512-triangle / 128-mesh transport limit.",
          );
        const world = worldOf(actor, component);
        meshSources.push({
          key,
          identity: {
            actorId: actor.id,
            componentId: component.id,
            primitive: { kind: "mesh" },
          },
          receiver: participation === "staticReceiver",
          source,
          world: [...world.asArray()],
          transport: {
            positions: transportPositions(source, world),
            material: { kind: "diffuse", albedo: [...closure.albedo] },
          },
          closure,
        });
      }
    }
  }
  if (!meshSources.some((entry) => entry.receiver))
    throw new Error("Bake needs at least one Static Receiver.");
  if (!lightSources.length || lightSources.length > 16)
    throw new Error(
      "Bake needs 1..16 enabled Static or Stationary point lights.",
    );
  sorted(meshSources);
  sorted(lightSources);
  const meshes = await Promise.all(
    meshSources.map(async (entry): Promise<PreparedBakeMesh> => ({
      identity: entry.identity,
      receiver: entry.receiver,
      source: entry.source,
      world: entry.world,
      transport: entry.transport,
      hashes: {
        geometry: await fingerprintBakeGeometry(entry.source),
        uv: await hash(
          await Promise.all(
            entry.source.attributes
              .filter((attribute) => attribute.name === "uv2")
              .map((attribute) => sha256Hex(attribute.data)),
          ),
        ),
        transforms: await hash(entry.world),
        materials: await hash(entry.closure),
      },
    })),
  );
  check();
  const sources: BakedLightingSource[] = await Promise.all(
    lightSources.map(async (entry) => ({
      id: `light:${await hash(entry.key)}`,
      kind: "light",
      actorId: entry.actorId,
      componentId: entry.componentId,
      mobility: entry.mobility,
      inputHash: await hash({
        light: entry.light,
        mobility: entry.mobility,
        falloff: "inverseSquare",
        intensity: "BabylonAutomaticPointScale1",
      }),
    })),
  );
  check();
  const inputs: BakeInputHashes = {
    geometry: await hash(
      meshes.map((entry) => [
        entry.identity,
        entry.receiver,
        entry.hashes.geometry,
      ]),
    ),
    uv: await hash(meshes.map((entry) => [entry.identity, entry.hashes.uv])),
    transforms: await hash(
      meshes.map((entry) => [entry.identity, entry.hashes.transforms]),
    ),
    materials: await hash(
      meshes.map((entry) => [entry.identity, entry.hashes.materials]),
    ),
    lights: await hash(sources),
    environment: await hash({ kind: "none" }),
    settings: await hash(settings),
    provider: await hash({
      id: "three-gpu-pathtracer",
      version: "0.0.24",
      adapterVersion: "scene-preparation-1",
      jobAdapterVersion: "scene-job-1",
      uv: "xatlasjs-0.2.0-adapter1",
      quantity: "physical-E",
      transport: "two-sided-diffuse-only",
    }),
  };
  check();
  const batches = (["static", "stationary"] as const)
    .map((mobility) => ({
      mode: mobility === "static" ? ("full" as const) : ("indirect" as const),
      sourceIds: sources
        .filter(
          (source) => source.kind === "light" && source.mobility === mobility,
        )
        .map((source) => source.id),
      lights: lightSources
        .filter((source) => source.mobility === mobility)
        .map((source) => source.light),
    }))
    .filter((batch) => batch.lights.length > 0);
  return {
    owner,
    settings,
    inputs,
    dependencies: [...dependencies].sort(),
    meshes,
    sources,
    batches,
  };
}
