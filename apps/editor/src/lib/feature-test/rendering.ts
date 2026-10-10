import {
  createDefaultRenderTargetCaptureProperties,
  createDefaultScene,
  createDefaultSunActor,
  createSkyboxComponent,
  DEFAULT_SCENE_SUN_ACTOR_ID,
  DEFAULT_SCENE_SUN_POSITION,
  lookAtRotation,
  normalizeRenderEffectsSettings,
  normalizeShadowSettings,
  parseAreaRectLightProperties,
  parseDeformerProperties,
  parseFogVolumeProperties,
  parseOutlineProperties,
  parseSpringArmProperties,
  RENDER_TARGET_MODE_LABELS,
  SKYBOX_FACE_KEYS,
  type ProjectSettings,
  type RenderTargetMode,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
  type SkyboxFaces,
} from "@babylonslate/core";
import { engineScriptApiFor } from "@babylonslate/object-model";
import { createDefaultMaterialDocument } from "@babylonslate/shader-graph";
import {
  actor,
  comp,
  meshComp,
  requireRef,
  SCENE_SAVE_ORDER,
  tf,
  type FeatureTestClassRef,
  type FeatureTestContext,
  type Vec3,
} from "./context";
import {
  classGraph,
  gChain,
  gExec,
  getVar,
  gNode,
  gWire,
  varMember,
  type GraphNode,
} from "./graph";
import { FEATURE_TEST_MAIN_CAMERA, type FeatureTestZoneId } from "./layout";

/**
 * Rendering area: lights and shadows, effects (fog volume, outline, lattice
 * deformer, 3D text, dynamic runtime mesh, spring arm), render targets, the
 * automatic Model LOD lane, the main camera / sky / sun, project render
 * settings, scalability console commands and the `FT_Clustered` scene.
 */

const RENDER_FOLDER = "Rendering";
const SKY_FOLDER = "Sky";
const SCENES_FOLDER = "Scenes";

/** One capture per Render Target mode; WorldNormal captures on request only. */
const CAPTURES: ReadonlyArray<{ mode: RenderTargetMode; size: number; everyFrame: boolean; x: number; y: number }> = [
  { mode: "SceneColor", size: 512, everyFrame: true, x: -7, y: 3 },
  { mode: "DepthPass", size: 256, everyFrame: true, x: 0, y: 4 },
  { mode: "WorldNormal", size: 256, everyFrame: false, x: 7, y: 3 },
];

/** Horizontal distances (m) from the LOD Lane Camera to each menorah instance. */
const LOD_DISTANCES = [4, 8, 16, 32, 48] as const;
const LOD_MODEL_SCALE = 3;
const LOD_CAMERA_X = -27;

/** Unshadowed point lights in `FT_Clustered` (8 × 6 grid). */
const CLUSTER_COLUMNS = 8;
const CLUSTER_ROWS = 6;
const CLUSTER_SPACING = 3;
const CLUSTER_CAMERA = { position: [0, 16, -18] as Vec3, target: [0, 0, 6] as Vec3 };

const POST_PROCESS_ENTRY_ID = "ft-render-post-process";

interface RenderingRefs {
  targets: Record<RenderTargetMode, { renderTarget: string; monitorMaterial: string }>;
  springArm: PlacedClass;
  dynamicMesh: PlacedClass;
  manualCapture: PlacedClass;
}

/** A Class plus the prefab components its scene instances copy. */
interface PlacedClass {
  ref: FeatureTestClassRef;
  components: SerializedComponent[];
}

const refsByContext = new WeakMap<FeatureTestContext, RenderingRefs>();

/**
 * Create rendering assets: Skybox Creator, Render Targets with their sampler
 * Textures and monitor Materials, the spring arm / dynamic mesh / manual
 * capture Classes, the `ft_*` scalability commands and the `FT_Clustered` scene.
 */
export async function buildFeatureTestRendering(ctx: FeatureTestContext): Promise<void> {
  await createSkyboxCreator(ctx);
  const targets = await createRenderTargets(ctx);
  const springArm = await saveSpringArmRig(ctx);
  const dynamicMesh = await saveDynamicMesh(ctx);
  const manualCapture = await saveManualCapture(ctx, targets.WorldNormal.renderTarget);
  await saveScalabilityCommands(ctx);
  await addClusteredScene(ctx);
  refsByContext.set(ctx, { targets, springArm, dynamicMesh, manualCapture });
}

/**
 * Place the main camera, sky, sun and every rendering zone in the main scene,
 * then queue the project render settings.
 */
export async function placeFeatureTestRendering(ctx: FeatureTestContext): Promise<void> {
  const refs = refsByContext.get(ctx);
  if (!refs) throw new Error("FeatureTest rendering assets must be built before placement.");
  placeGlobals(ctx);
  placeLights(ctx);
  placeEffects(ctx, refs);
  placeRenderTargets(ctx, refs);
  placeLodLane(ctx);
  ctx.patchSettings((settings) => applyRenderSettings(settings, ctx.assets.textures.colorGradingLut));
}

// ---------------------------------------------------------------------------
// Assets

function skyFaces(ctx: FeatureTestContext): SkyboxFaces {
  const faces = { ...ctx.assets.textures.skyFaces };
  for (const key of SKYBOX_FACE_KEYS) requireRef(faces[key], `the ${key} sky face Texture`);
  return faces;
}

/** Decode-free Skybox Creator: the imported net is the source, the six face Textures its outputs. */
async function createSkyboxCreator(ctx: FeatureTestContext): Promise<void> {
  await ctx.createAsset("SkyboxCreator", SKY_FOLDER, "FT_RenderSkyCreator", {
    payload: {
      sourceTextureGuid: requireRef(ctx.assets.textures.skyboxNet, "the Skybox Creator net Texture"),
      sourcePlacement: null,
      generatedFaces: skyFaces(ctx),
    },
  });
}

async function createRenderTargets(ctx: FeatureTestContext): Promise<RenderingRefs["targets"]> {
  const targets = {} as RenderingRefs["targets"];
  for (const { mode, size } of CAPTURES) {
    const renderTarget = await ctx.createAsset("RenderTarget", RENDER_FOLDER, `FT_RenderTarget${mode}`, {
      payload: { mode, width: size, height: size },
    });
    const texture = await ctx.createAsset("RenderTargetTexture", RENDER_FOLDER, `FT_RenderTexture${mode}`, {
      payload: { renderTargetGuid: renderTarget.guid },
    });
    const name = `FT_RenderMonitor${mode}`;
    const monitor = await ctx.createAsset("Material", RENDER_FOLDER, name, {
      payload: monitorMaterial(name, texture.guid),
    });
    targets[mode] = { renderTarget: renderTarget.guid, monitorMaterial: monitor.guid };
  }
  return targets;
}

/** Unlit surface sampling a Render Target Texture into Base Color. */
function monitorMaterial(name: string, textureGuid: string): Record<string, unknown> {
  const doc = createDefaultMaterialDocument(name);
  const output = doc.nodes.find((node) => node.type === "output.surface");
  if (!output) throw new Error("FeatureTest monitor Material has no surface output.");
  doc.shadingModel = "unlit";
  doc.nodes = [
    output,
    { id: "capture", type: "texture.sample", position: { x: 0, y: 0 }, properties: { textureGuid } },
  ];
  doc.edges = [{
    id: `capture:rgb:${output.id}:baseColor`,
    sourceNodeId: "capture",
    sourcePinId: "rgb",
    targetNodeId: output.id,
    targetPinId: "baseColor",
  }];
  return doc as unknown as Record<string, unknown>;
}

/** Class instance rows: `prefab-<suffix>` becomes `<actorId>-<suffix>` with `sourceId` kept. */
function instanceComponents(actorId: string, templates: readonly SerializedComponent[]): SerializedComponent[] {
  const idOf = (id: string) => `${actorId}-${id.replace(/^prefab-/, "")}`;
  return templates.map((template) => ({
    ...structuredClone(template),
    id: idOf(template.id),
    parentId: template.parentId ? idOf(template.parentId) : null,
    sourceId: template.id,
  }));
}

/** Array member getter (the shared helper reads scalars only). */
function getArrayVar(id: string, member: ReturnType<typeof varMember>, x: number, y: number): GraphNode {
  const node = getVar(id, member, x, y);
  node.data.container = "array";
  return node;
}

/** Orbiting rig: Tick yaws the actor, so the off-axis arm shows location and rotation lag. */
async function saveSpringArmRig(ctx: FeatureTestContext): Promise<PlacedClass> {
  const turnRate = varMember("ft-render-var-turn-rate", "TurnRate", "float", 40, { category: "Spring Arm" });
  const components: SerializedComponent[] = [
    { ...meshComp("prefab-post", "cylinder"), transform: tf([0, 0.75, 0], { scale: [0.4, 1, 0.4] }) },
    { ...meshComp("prefab-target", "sphere"), transform: tf([2, 0.75, 0], { scale: [0.6, 0.6, 0.6] }) },
    comp("prefab-arm", "SpringArmComponent", {
      ...parseSpringArmProperties({
        armLength: 4,
        enableLocationLag: true,
        locationLagSpeed: 3,
        enableRotationLag: true,
        rotationLagSpeed: 2.5,
        drawDebugLag: true,
      }),
    }, tf([2, 1, 0], { rotationDeg: [25, 0, 0] })),
    comp("prefab-camera", "CameraComponent", { fieldOfView: 70, farClip: 300 }, undefined, { parentId: "prefab-arm" }),
  ];
  const graph = classGraph({
    members: [turnRate],
    components,
    nodes: [
      gNode("tick", "flow.event.tick", 0, 0),
      getVar("get-turn-rate", turnRate, 0, 160),
      gNode("degrees", "math.mul", 240, 120),
      gNode("yaw", "struct.makeRotator", 460, 120, { "default:pitch": 0, "default:roll": 0 }),
      gNode("self", "actor.getSelf", 240, 300),
      gNode("current", "transform.getRotation", 460, 300),
      gNode("combine", "rotator.combine", 700, 200),
      gNode("turn", "transform.setRotation", 940, 0),
    ],
    edges: [
      gExec("tick", "turn"),
      gWire("tick", "deltaSeconds", "degrees", "a"),
      gWire("get-turn-rate", "value", "degrees", "b"),
      gWire("degrees", "out", "yaw", "yaw"),
      gWire("self", "out", "current", "target"),
      gWire("self", "out", "turn", "target"),
      gWire("current", "out", "combine", "a"),
      gWire("yaw", "out", "combine", "b"),
      gWire("combine", "out", "turn", "rotation"),
    ],
  });
  const ref = await ctx.saveClass({ folder: RENDER_FOLDER, name: "FT_RenderSpringArmRig", parentClass: "Actor", graph });
  return { ref, components };
}

/** Flat-shaded four-sided pyramid (2 m base, 2.2 m tall) wound for outward front faces. */
function pyramidGeometry(): { positions: number[]; indices: number[]; normals: number[]; texCoords: number[] } {
  const corners: Vec3[] = [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]];
  const apex: Vec3 = [0, 2.2, 0];
  const round = (value: number) => Math.round(value * 10000) / 10000;
  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  const texCoords: number[] = [];
  corners.forEach((corner, index) => {
    const triangle = [corner, corners[(index + 1) % corners.length]!, apex];
    const [a, b, c] = triangle as [Vec3, Vec3, Vec3];
    // Same convention as the runtime's computed normals: (a - b) × (c - b).
    const u: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const v: Vec3 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(n[0], n[1], n[2]);
    for (const point of triangle) {
      indices.push(positions.length / 3);
      positions.push(...point);
      normals.push(round(n[0] / length), round(n[1] / length), round(n[2] / length));
    }
    texCoords.push(0, 0, 1, 0, 0.5, 1);
  });
  return { positions, indices, normals, texCoords };
}

/** Begin Play hands the pyramid buffers to Set Geometry; nothing renders until Play. */
async function saveDynamicMesh(ctx: FeatureTestContext): Promise<PlacedClass> {
  const setGeometry = engineScriptApiFor("DynamicRuntimeMeshComponent")?.functions?.find(
    (fn) => fn.name === "Set Geometry",
  );
  if (!setGeometry) throw new Error("DynamicRuntimeMeshComponent has no Set Geometry function.");
  const geometry = pyramidGeometry();
  const array = { container: "array" as const, category: "Geometry" };
  const positions = varMember("ft-render-var-positions", "Positions", "float", geometry.positions, array);
  const indices = varMember("ft-render-var-indices", "Indices", "int", geometry.indices, array);
  const normals = varMember("ft-render-var-normals", "Normals", "float", geometry.normals, array);
  const texCoords = varMember("ft-render-var-tex-coords", "TexCoords", "float", geometry.texCoords, array);
  const components = [
    comp("prefab-dynamic-mesh", "DynamicRuntimeMeshComponent", {
      materialGuid: ctx.assets.materials.surface ?? null,
    }),
  ];
  const graph = classGraph({
    members: [positions, indices, normals, texCoords],
    components,
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      gNode("mesh", "component.getNamed", 0, 160, {
        componentClassId: "DynamicRuntimeMeshComponent",
        implicitSelf: true,
      }),
      getArrayVar("get-positions", positions, 0, 260),
      getArrayVar("get-indices", indices, 0, 360),
      getArrayVar("get-normals", normals, 0, 460),
      getArrayVar("get-tex-coords", texCoords, 0, 560),
      gNode("set-geometry", "functions.call", 420, 0, {
        functionName: setGeometry.name,
        classId: "DynamicRuntimeMeshComponent",
        implicitSelf: false,
        pins: setGeometry.pins.map((pin) => ({ ...pin })),
        runtime: setGeometry.runtime,
      }),
    ],
    edges: [
      gWire("begin", "execOut", "set-geometry", "exec"),
      gWire("mesh", "out", "set-geometry", "target"),
      gWire("get-positions", "value", "set-geometry", "positions"),
      gWire("get-indices", "value", "set-geometry", "indices"),
      gWire("get-normals", "value", "set-geometry", "normals"),
      gWire("get-tex-coords", "value", "set-geometry", "uvs"),
    ],
  });
  const ref = await ctx.saveClass({ folder: RENDER_FOLDER, name: "FT_RenderDynamicMesh", parentClass: "Actor", graph });
  return { ref, components };
}

/** RenderTargetCapture subclass: manual capture once the scene has settled after Begin Play. */
async function saveManualCapture(ctx: FeatureTestContext, renderTargetGuid: string): Promise<PlacedClass> {
  const components = [
    comp("prefab-capture", "RenderTargetCaptureComponent", {
      ...createDefaultRenderTargetCaptureProperties(),
      renderTargetGuid,
      captureEveryFrame: false,
      fieldOfView: 50,
      nearClip: 0.5,
      farClip: 30,
    }),
  ];
  const graph = classGraph({
    components,
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      gNode("settle", "timers.delay", 240, 0, { "default:duration": 0.5 }),
      gNode("self", "actor.getSelf", 240, 180),
      gNode("as-capture", "casting.cast", 480, 0, {
        "default:class": "RenderTargetCapture",
        defaultClassId: "RenderTargetCapture",
        resultKind: "actorRef",
      }),
      gNode("capture", "render-target.capture", 760, 0),
    ],
    edges: [
      ...gChain("begin", "settle", "as-capture", "capture"),
      gWire("self", "out", "as-capture", "object"),
      gWire("as-capture", "result", "capture", "capture"),
    ],
  });
  const ref = await ctx.saveClass({
    folder: RENDER_FOLDER,
    name: "FT_RenderCaptureManual",
    parentClass: "RenderTargetCapture",
    graph,
  });
  return { ref, components };
}

/** Console commands perf agents use to flip shading and render path mid-run. */
async function saveScalabilityCommands(ctx: FeatureTestContext): Promise<void> {
  const commands = [
    { name: "FT_RenderCelCommand", command: "ft_cel", node: "scalability.setRenderMode", data: { "default:mode": "cel" }, report: "Requested CEL shading" },
    { name: "FT_RenderPbrCommand", command: "ft_pbr", node: "scalability.setRenderMode", data: { "default:mode": "pbr" }, report: "Requested PBR shading" },
    { name: "FT_RenderClusterCommand", command: "ft_cluster", node: "scalability.setRenderPath", data: { "default:path": "clusteredForward" }, report: "Requested Clustered Forward" },
    { name: "FT_RenderForwardCommand", command: "ft_forward", node: "scalability.setRenderPath", data: { "default:path": "forward" }, report: "Requested Forward" },
  ];
  for (const entry of commands) {
    const graph = classGraph({
      nodes: [
        gNode("run", "flow.event.commandRun", 0, 0, {
          commandName: entry.command,
          description: `${entry.report} for this Play session`,
          category: "FeatureTest",
          parameters: [],
        }),
        gNode("apply", entry.node, 300, 0, entry.data),
        gNode("report", "debug.reportCommand", 600, 0, { "default:success": true, "default:output": entry.report }),
      ],
      edges: gChain("run", "apply", "report"),
    });
    await ctx.saveClass({ folder: RENDER_FOLDER, name: entry.name, parentClass: "BDebugCommand", graph });
  }
}

// ---------------------------------------------------------------------------
// Actor helpers

type LightProperties = {
  lightKind: "point" | "spot" | "directional";
  color: Vec3;
  intensity: number;
  range?: number;
  innerAngle?: number;
  outerAngle?: number;
  castShadows: boolean;
  shadowPriority?: number;
};

/** One LightComponent per actor; spot lights aim their local +Z at `target`. */
function lightActor(id: string, name: string, position: Vec3, target: Vec3 | null, properties: LightProperties): SerializedActor {
  return actor(id, name, tf(position, target ? { rotation: lookAtRotation(position, target) } : {}), [
    comp(`${id}-light`, "LightComponent", { enabled: true, shadowPriority: 0, ...properties }),
  ]);
}

function primitive(
  id: string,
  name: string,
  kind: "box" | "sphere" | "cylinder" | "plane",
  position: Vec3,
  options: { materialGuid?: string | null; rotationDeg?: Vec3; scale?: Vec3; castShadows?: boolean } = {},
): SerializedActor {
  const mesh = meshComp(`${id}-mesh`, kind, { materialGuid: options.materialGuid ?? null });
  if (options.castShadows === false) mesh.properties.castShadows = false;
  return actor(id, name, tf(position, { rotationDeg: options.rotationDeg, scale: options.scale }), [mesh]);
}

function text3d(id: string, name: string, position: Vec3, text: string, options: { size: number; color: Vec3; fontAssetGuid: string | null; rotationDeg?: Vec3 }): SerializedActor {
  return actor(id, name, tf(position, { rotationDeg: options.rotationDeg }), [
    comp(`${id}-text`, "Text3DComponent", {
      text,
      size: options.size,
      color: options.color,
      alignment: "center",
      fontAssetGuid: options.fontAssetGuid,
    }),
  ]);
}

function zoneAdder(ctx: FeatureTestContext, zone: FeatureTestZoneId) {
  return (next: SerializedActor) => ctx.addActor(next, { zone });
}

// ---------------------------------------------------------------------------
// Main scene placement

/** Static main camera, the texture-face skybox and the tuned default sun. */
function placeGlobals(ctx: FeatureTestContext): void {
  const scene = ctx.mainScene;
  const previous = scene.actors.findIndex(
    (entry) => entry.id === scene.settings.mainCameraActorId &&
      entry.components.some((component) => component.classId === "CameraComponent"),
  );
  if (previous >= 0) scene.actors.splice(previous, 1);
  const { actorId, componentId, position, target } = FEATURE_TEST_MAIN_CAMERA;
  ctx.addActor(actor(actorId, "Main Camera", tf(position, { rotation: lookAtRotation(position, target) }), [
    comp(componentId, "CameraComponent", {
      projectionMode: "perspective",
      fieldOfView: 60,
      nearClip: 0.1,
      farClip: 1000,
      attemptPossessViewTarget: true,
    }),
  ]));
  scene.settings.mainCameraActorId = actorId;
  scene.settings.mainCameraComponentId = componentId;

  // Exactly one skybox, drawn from the six imported face Textures.
  const faces = skyFaces(ctx);
  const skies = scene.actors.filter((entry) => entry.components.some((component) => component.classId === "SkyboxComponent"));
  if (skies.length === 0) {
    const sky = createSkyboxComponent("ft-render-skybox-component");
    sky.properties.faces = faces;
    ctx.addActor(actor("ft-render-skybox", "Skybox", tf(), [sky], { locked: true }));
  } else {
    for (const component of skies[0]!.components) {
      if (component.classId === "SkyboxComponent") component.properties = { ...component.properties, faces };
    }
    for (const extra of skies.slice(1)) scene.actors.splice(scene.actors.indexOf(extra), 1);
  }

  // Directional sun: shadowed, admitted before every local shadow caster.
  let sun = scene.actors.find((entry) => entry.id === DEFAULT_SCENE_SUN_ACTOR_ID);
  if (!sun) {
    sun = createDefaultSunActor(lookAtRotation(DEFAULT_SCENE_SUN_POSITION, [0, 0, 0]));
    ctx.addActor(sun);
  }
  for (const component of sun.components) {
    if (component.classId !== "LightComponent") continue;
    component.properties = { ...component.properties, intensity: 1.6, castShadows: true, shadowPriority: 100 };
  }

  scene.settings.fogEnabled = true;
  scene.settings.fogMode = "exponential";
  scene.settings.fogDensity = 0.003;
  scene.settings.fogColor = [0.68, 0.76, 0.86];
  const postProcess = requireRef(ctx.assets.materials.postProcess, "the post-process Material");
  scene.settings.postProcessStack = [
    ...scene.settings.postProcessStack.filter((entry) => entry.id !== POST_PROCESS_ENTRY_ID),
    { id: POST_PROCESS_ENTRY_ID, materialGuid: postProcess, enabled: true, scalable: true },
  ];
}

/** Shadowed spot and point (cube) lights, unshadowed colour lights, an area light and the hemispheric fill. */
function placeLights(ctx: FeatureTestContext): void {
  const zone = ctx.zone("lights");
  const add = zoneAdder(ctx, "lights");
  const surface = ctx.assets.materials.surface ?? null;
  const emissive = ctx.assets.materials.emissive ?? null;
  zone.floor();

  // Spot shadows over a small caster group (left).
  add(lightActor("ft-render-spot-shadowed", "Shadowed Spot Light", zone.at(-6, 7, -7), zone.at(-6, 0, -1), {
    lightKind: "spot", color: [1, 0.92, 0.8], intensity: 3, range: 16, innerAngle: 25, outerAngle: 45,
    castShadows: true, shadowPriority: 50,
  }));
  add(primitive("ft-render-spot-caster-box", "Spot Caster Box", "box", zone.at(-6, 0.75, -1), { materialGuid: surface, rotationDeg: [0, 30, 0] }));
  add(primitive("ft-render-spot-caster-sphere", "Spot Caster Sphere", "sphere", zone.at(-8.5, 0.75, 1.5)));
  add(primitive("ft-render-spot-caster-cylinder", "Spot Caster Cylinder", "cylinder", zone.at(-3.5, 0.75, 1)));

  // Point light cube shadows radiating from a ring of pillars (right).
  const pointCenter = zone.at(6, 2.5, -1);
  add(lightActor("ft-render-point-shadowed", "Shadowed Point Light", pointCenter, null, {
    lightKind: "point", color: [1, 0.8, 0.55], intensity: 2.5, range: 10, castShadows: true, shadowPriority: 40,
  }));
  add(primitive("ft-render-point-bulb", "Point Light Bulb", "sphere", pointCenter, {
    materialGuid: emissive, scale: [0.2, 0.2, 0.2], castShadows: false,
  }));
  [[-2.5, 0], [2.5, 0], [0, -2.5], [0, 2.5]].forEach(([dx, dz], index) => {
    add(primitive(`ft-render-point-pillar-${index + 1}`, `Point Shadow Pillar ${index + 1}`, "cylinder",
      zone.at(6 + dx!, 1.5, -1 + dz!), { scale: [0.6, 2, 0.6] }));
  });

  // Unshadowed colour lights over a row of spheres (back).
  const colors: Vec3[] = [[1, 0.25, 0.2], [0.3, 1, 0.35], [0.3, 0.45, 1]];
  colors.forEach((color, index) => {
    const x = -6 + index * 6;
    add(lightActor(`ft-render-color-light-${index + 1}`, `Color Point Light ${index + 1}`, zone.at(x, 1.8, 7), null, {
      lightKind: "point", color, intensity: 2, range: 6, castShadows: false,
    }));
    add(primitive(`ft-render-color-sphere-${index + 1}`, `Color Lit Sphere ${index + 1}`, "sphere", zone.at(x, 0.75, 8.5)));
  });
  add(lightActor("ft-render-spot-unshadowed", "Unshadowed Spot Light", zone.at(0, 6, -6), zone.at(0, 0, -8), {
    lightKind: "spot", color: [0.55, 0.75, 1], intensity: 3, range: 12, innerAngle: 20, outerAngle: 35, castShadows: false,
  }));

  // Rect area light over open floor; it is unshadowed and emits along local +Z (down).
  add(actor("ft-render-area-light", "Area Rect Light", tf(zone.at(7, 3.2, -8), { rotationDeg: [90, 0, 0] }), [
    comp("ft-render-area-light-rect", "AreaRectLightComponent", {
      ...parseAreaRectLightProperties({ width: 4, height: 1.5, color: [0.65, 0.8, 1], intensity: 5 }),
    }),
  ]));
  add(primitive("ft-render-area-lit-box", "Area Lit Box", "box", zone.at(7, 0.75, -8), { materialGuid: surface }));

  add(actor("ft-render-fill-light", "Hemispheric Fill Light", tf(zone.at(-10, 4, -10)), [
    comp("ft-render-fill-light-hemi", "HemisphericFillLightComponent", {
      intensity: 0.35,
      color: [0.75, 0.85, 1],
      groundColor: [0.25, 0.2, 0.15],
      enabled: true,
    }),
  ]));
}

/** 2 × 2 × 2 cage: the top four corners pinch inward, rise and twist 35° about Y. */
function latticeTwistOffsets(): number[] {
  const half = 0.75;
  const angle = (35 * Math.PI) / 180;
  const round = (value: number) => Math.round(value * 10000) / 10000;
  const offsets: number[] = [];
  // Index order x + rx * (y + ry * z).
  for (let z = 0; z < 2; z += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        if (y === 0) {
          offsets.push(0, 0, 0);
          continue;
        }
        const px = (x * 2 - 1) * half;
        const pz = (z * 2 - 1) * half;
        const tx = (px * Math.cos(angle) + pz * Math.sin(angle)) * 0.6;
        const tz = (-px * Math.sin(angle) + pz * Math.cos(angle)) * 0.6;
        offsets.push(round(tx - px), 0.25, round(tz - pz));
      }
    }
  }
  return offsets;
}

/** Fog volume, outlines (x-ray through a wall), lattice deformer, dynamic mesh, spring arm, 3D text, ortho camera. */
function placeEffects(ctx: FeatureTestContext, refs: RenderingRefs): void {
  const zone = ctx.zone("effects");
  const add = zoneAdder(ctx, "effects");
  const surface = ctx.assets.materials.surface ?? null;
  zone.floor();

  add(actor("ft-render-fog-volume", "Fog Volume", tf(zone.at(-7, 1.5, -6)), [
    comp("ft-render-fog-volume-box", "FogVolumeComponent", {
      ...parseFogVolumeProperties({ shape: "box", size: [6, 3, 6], density: 0.3, edgeFalloff: 0.3 }),
    }),
  ]));
  add(primitive("ft-render-fog-glow", "Fog Glow Sphere", "sphere", zone.at(-7, 0.75, -6), {
    materialGuid: ctx.assets.materials.emissive ?? null,
  }));

  // The wall stands between the main camera and the cylinder, so only the x-ray outline shows through.
  add(actor("ft-render-outline-xray", "Outlined Cylinder", tf(zone.at(0, 0.75, -4)), [
    meshComp("ft-render-outline-xray-mesh", "cylinder"),
    comp("ft-render-outline-xray-outline", "OutlineComponent", {
      ...parseOutlineProperties({ color: [1, 0.55, 0], width: 3, throughMeshes: true }),
    }),
  ]));
  add(primitive("ft-render-outline-wall", "Outline Occluder Wall", "box", zone.at(2, 1.5, -5.5), {
    rotationDeg: [0, 127, 0], scale: [2, 2, 0.1],
  }));
  add(actor("ft-render-outline-plain", "Outlined Sphere", tf(zone.at(-1, 0.75, 1)), [
    meshComp("ft-render-outline-plain-mesh", "sphere"),
    comp("ft-render-outline-plain-outline", "OutlineComponent", {
      ...parseOutlineProperties({ color: [0.2, 0.85, 1], width: 2 }),
    }),
  ]));

  add(actor("ft-render-deformer", "Lattice Deformed Box", tf(zone.at(7, 0.75, -6)), [
    meshComp("ft-render-deformer-mesh", "box", { materialGuid: surface }),
    comp("ft-render-deformer-cage", "DeformerComponent", {
      ...parseDeformerProperties({
        targetMeshComponentId: "ft-render-deformer-mesh",
        enabled: true,
        strength: 1,
        resolution: [2, 2, 2],
        offsets: latticeTwistOffsets(),
        fitToMesh: true,
      }),
    }),
  ]));

  add(actor("ft-render-dynamic-mesh", "Dynamic Mesh Pyramid", tf(zone.at(7, 0, 2)),
    instanceComponents("ft-render-dynamic-mesh", refs.dynamicMesh.components),
    { classId: refs.dynamicMesh.ref.classId }));
  add(actor("ft-render-spring-arm", "Spring Arm Rig", tf(zone.at(-6, 0, 6)),
    instanceComponents("ft-render-spring-arm", refs.springArm.components),
    { classId: refs.springArm.ref.classId }));

  const facetype = requireRef(ctx.assets.fonts.facetype, "the facetype Font");
  add(text3d("ft-render-text-facetype", "Facetype Font Text", zone.at(3, 3.4, 9), "Text3D Facetype Font", {
    size: 0.55, color: [0.95, 0.95, 1], fontAssetGuid: facetype,
  }));
  add(text3d("ft-render-text-bundled", "Bundled ASCII Text", zone.at(3, 2.4, 9), "Text3D Bundled ASCII", {
    size: 0.55, color: [0.6, 1, 0.7], fontAssetGuid: null,
  }));

  // Top-down orthographic view of the zone: `possess "Effects Ortho Camera"`.
  add(actor("ft-render-ortho-camera", "Effects Ortho Camera", tf(zone.at(0, 30, 0), { rotationDeg: [90, 0, 0] }), [
    comp("ft-render-ortho-camera-cam", "CameraComponent", {
      projectionMode: "orthographic",
      orthographicSize: 13,
      nearClip: 0.1,
      farClip: 80,
    }),
  ]));
}

/** Three captures (one per mode) aimed at a subject group, each shown on its own monitor. */
function placeRenderTargets(ctx: FeatureTestContext, refs: RenderingRefs): void {
  const zone = ctx.zone("renderTargets");
  const add = zoneAdder(ctx, "renderTargets");
  zone.floor();

  add(primitive("ft-render-subject-sphere", "Capture Subject Sphere", "sphere", zone.at(-2.5, 0.75, -5), {
    materialGuid: ctx.assets.materials.emissive ?? null,
  }));
  add(primitive("ft-render-subject-box", "Capture Subject Box", "box", zone.at(0, 0.75, -5), {
    materialGuid: ctx.assets.materials.surface ?? null, rotationDeg: [0, 30, 0],
  }));
  add(primitive("ft-render-subject-cylinder", "Capture Subject Cylinder", "cylinder", zone.at(2.5, 0.75, -5)));
  add(primitive("ft-render-subject-backdrop", "Capture Backdrop", "box", zone.at(0, 1.5, -9), { scale: [4, 2, 0.2] }));

  const aim = zone.at(0, 0.75, -5);
  for (const { mode, everyFrame, x, y } of CAPTURES) {
    const slug = mode.replace(/[A-Z]/g, (letter, index: number) => `${index ? "-" : ""}${letter.toLowerCase()}`);
    const label = RENDER_TARGET_MODE_LABELS[mode];
    const id = `ft-render-capture-${slug}`;
    const position = zone.at(x, y, 0);
    const transform = tf(position, { rotation: lookAtRotation(position, aim) });
    if (everyFrame) {
      add(actor(id, `${label} Capture`, transform, [
        comp(`${id}-capture`, "RenderTargetCaptureComponent", {
          ...createDefaultRenderTargetCaptureProperties(),
          renderTargetGuid: refs.targets[mode].renderTarget,
          captureEveryFrame: true,
          fieldOfView: 50,
          nearClip: 0.5,
          farClip: mode === "DepthPass" ? 20 : 30,
        }),
      ], { classId: "RenderTargetCapture" }));
    } else {
      add(actor(id, `${label} Manual Capture`, transform,
        instanceComponents(id, refs.manualCapture.components),
        { classId: refs.manualCapture.ref.classId }));
    }
    // Monitors sit behind the captures, outside every capture frustum.
    const monitor = `ft-render-monitor-${slug}`;
    add(primitive(monitor, `${label} Monitor`, "plane", zone.at(x, 3, 7), {
      materialGuid: refs.targets[mode].monitorMaterial, scale: [3, 3, 1], castShadows: false,
    }));
    add(text3d(`${monitor}-caption`, `${label} Caption`, zone.at(x, 0.3, 6.2), everyFrame ? label : `${label} (Manual)`, {
      size: 0.4, color: [0.9, 0.9, 0.9], fontAssetGuid: null,
    }));
  }
}

/** Dense menorah instances at growing distances from a possessable lane camera. */
function placeLodLane(ctx: FeatureTestContext): void {
  const zone = ctx.zone("lod");
  const add = zoneAdder(ctx, "lod");
  const menorah = requireRef(ctx.assets.models["hanukkah-menorah-candles"], "the menorah Model");
  zone.floor();
  const cameraPosition = zone.at(LOD_CAMERA_X, 1.8, 0);
  add(actor("ft-render-lod-camera", "LOD Lane Camera",
    tf(cameraPosition, { rotation: lookAtRotation(cameraPosition, zone.at(0, 1.2, 0)) }), [
      comp("ft-render-lod-camera-cam", "CameraComponent", { fieldOfView: 60, nearClip: 0.1, farClip: 200 }),
    ]));
  LOD_DISTANCES.forEach((distance, index) => {
    const id = `ft-render-lod-menorah-${index + 1}`;
    add(actor(id, `LOD Menorah ${index + 1}`,
      tf(zone.at(LOD_CAMERA_X + distance, 0, 0), {
        rotationDeg: [0, 90, 0],
        scale: [LOD_MODEL_SCALE, LOD_MODEL_SCALE, LOD_MODEL_SCALE],
      }),
      [meshComp(`${id}-mesh`, "box", { assetGuid: menorah })]));
  });
}

// ---------------------------------------------------------------------------
// FT_Clustered scene and project settings

/** Plain lit scene with 48 unshadowed point lights so Auto can select Clustered Forward. */
async function addClusteredScene(ctx: FeatureTestContext): Promise<void> {
  const scene: SerializedScene = createDefaultScene("3d");
  scene.name = "FT_Clustered";
  // Basic 3D's empty placeholder actor has no role here.
  scene.actors = scene.actors.filter((entry) => entry.components.length > 0);
  const camera = scene.actors.find((entry) => entry.id === scene.settings.mainCameraActorId);
  if (camera) {
    camera.transform = tf(CLUSTER_CAMERA.position, {
      rotation: lookAtRotation(CLUSTER_CAMERA.position, CLUSTER_CAMERA.target),
    });
  }
  // A dim sun lets the local lights read; the default faces keep the engine sky.
  for (const component of scene.actors.find((entry) => entry.id === DEFAULT_SCENE_SUN_ACTOR_ID)?.components ?? []) {
    if (component.classId === "LightComponent") component.properties = { ...component.properties, intensity: 0.4 };
  }
  const centerZ = ((CLUSTER_ROWS - 1) * CLUSTER_SPACING) / 2;
  const width = CLUSTER_COLUMNS * CLUSTER_SPACING + 8;
  const depth = CLUSTER_ROWS * CLUSTER_SPACING + 8;
  ctx.addActor(actor("ft-render-cluster-floor", "Cluster Floor",
    tf([0, -0.15, centerZ], { scale: [width / 1.5, 0.3 / 1.5, depth / 1.5] }),
    [meshComp("ft-render-cluster-floor-mesh", "box", { collision: "simple" })]), { scene });
  const colors: Vec3[] = [[1, 0.35, 0.3], [0.35, 1, 0.4], [0.35, 0.5, 1], [1, 0.85, 0.35]];
  for (let index = 0; index < CLUSTER_COLUMNS * CLUSTER_ROWS; index += 1) {
    const column = index % CLUSTER_COLUMNS;
    const row = Math.floor(index / CLUSTER_COLUMNS);
    const number = String(index + 1).padStart(2, "0");
    ctx.addActor(lightActor(`ft-render-cluster-light-${number}`, `Cluster Light ${number}`,
      [(column - (CLUSTER_COLUMNS - 1) / 2) * CLUSTER_SPACING, 1.2, row * CLUSTER_SPACING],
      null,
      { lightKind: "point", color: colors[index % colors.length]!, intensity: 2.5, range: 4.5, castShadows: false },
    ), { scene });
  }
  const kinds = ["box", "sphere", "cylinder"] as const;
  [-6, 0, 6].forEach((x, column) => {
    [3, 9].forEach((z, row) => {
      const kind = kinds[(column + row) % kinds.length]!;
      const id = `ft-render-cluster-${kind}-${column + 1}-${row + 1}`;
      ctx.addActor(primitive(id, `Cluster ${kind[0]!.toUpperCase()}${kind.slice(1)} ${column + 1}-${row + 1}`, kind,
        [x, 0.75, z - 1.5]), { scene });
    });
  });
  await ctx.addSceneDocument({
    kind: "scene",
    folder: SCENES_FOLDER,
    name: "FT_Clustered",
    content: scene,
    order: SCENE_SAVE_ORDER.scene,
  });
}

/** Moderate-cost PBR showcase: every effect on at modest resolution scales, FSR below native. */
function applyRenderSettings(settings: ProjectSettings, lut: string | null): ProjectSettings {
  const render = settings.render;
  const effects = normalizeRenderEffectsSettings(render.effects);
  const shadows = normalizeShadowSettings(render.shadows);
  return {
    ...settings,
    render: {
      ...render,
      renderPath: "auto",
      // Clustered Forward is WebGL2-only.
      gpuBackend: "webgl2",
      mode: "pbr",
      shadows: { ...shadows, enabled: true },
      effects: {
        ...effects,
        colorPipeline: { version: 1, mode: "sceneLinear" },
        toneMapping: "aces",
        exposure: 1,
        contrast: 1.05,
        whiteBalance: { ...effects.whiteBalance, enabled: true, temperature: 6800, tint: 0 },
        vignette: { ...effects.vignette, enabled: true, weight: 0.8 },
        bloom: { ...effects.bloom, enabled: true, threshold: 0.9, weight: 0.15, kernel: 64, scale: 0.5 },
        fxaa: true,
        upscaling: { ...effects.upscaling, enabled: true, renderScale: 0.8, sharpness: 0.2 },
        colorGrading: { enabled: lut !== null, lutTextureGuid: lut },
        ambientOcclusion: { ...effects.ambientOcclusion, enabled: true, resolutionScale: 0.5, samples: 12 },
        reflections: {
          ...effects.reflections, enabled: true, resolutionScale: 0.5, maxSteps: 24, maxDistance: 40, strength: 0.5,
        },
        volumetricLighting: {
          ...effects.volumetricLighting, enabled: true, resolutionScale: 0.5, steps: 16, maxLights: 2,
          density: 0.01, maxDistance: 60,
        },
      },
    },
  };
}
