import {
  createDataDefinitionAsset,
  createDataTreeAsset,
  createDataTreeEntry,
  createDefaultScene,
  createSceneStreamingActor,
  createTag,
  createText3DComponent,
  findTag,
  normalizeInputAssetPayload,
  normalizeTagRegistry,
  validateSaveGameDefinition,
  type DataDefinitionField,
  type GraphClassMember,
  type GraphClassMemberPin,
  type SerializedActor,
  type SerializedComponent,
  type SerializedGraph,
} from "@babylonslate/core";
import { newAssetFileName } from "../content-browser-helpers";
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
  fnGraph,
  fnMember,
  gChain,
  gExec,
  getVar,
  gNode,
  gWire,
  setVar,
  varMember,
  type GraphNode,
} from "./graph";
import { zonePoint } from "./layout";
import { FEATURE_TEST_TAGS } from "./settings";

/**
 * Visual scripting and object model area: every scripting engine base class
 * (BObject, Actor, ActorComponent, Game Instance, both subsystems, Function
 * Library, Editor Function Library, Debug Command, Editor Utility Object,
 * Scene Streaming Actor), Enum / Structure / Script Interface / Data
 * Definition / Data Tree / Save Game / Input assets, a Prefab and the
 * `FT_StreamedRoom` sub-scene. Placed in the Scripting and Scene Streaming
 * zones of the main scene.
 */

const SCRIPT_FOLDER = "Scripting";
const TYPES_FOLDER = "Types";
const DATA_FOLDER = "Data";
const INPUT_FOLDER = "Input";
const PREFAB_FOLDER = "Prefabs";
const EDITOR_FOLDER = "Editor";
const SCENES_FOLDER = "Scenes";

/**
 * Perf knob: Spinner grid in the Scripting zone (columns × rows, metres
 * apart). Each Spinner ticks a short graph with a member function call, a
 * nested static library call, a rotation write and one ticking component.
 */
const SPINNER_GRID = { columns: 4, rows: 4, spacing: 2.5 } as const;

/** Perf knob: `ft_spawn` default count; agents pass a count for heavier spikes. */
const SPAWN_COMMAND_DEFAULT_COUNT = 10;

/** Seconds after Begin Play before the Stream Loader streams `FT_StreamedRoom` in. */
const STREAM_DELAY_SECONDS = 1.5;

/** World offset per tick while an `FT_ScriptNudge` arrow key is held. */
const NUDGE_STEP = 0.05;

const SPEED_MODES = ["Slow", "Medium", "Fast"] as const;
type SpeedMode = (typeof SPEED_MODES)[number];
/** Spin Speed (degrees per second) that Begin Play selects from Speed Mode. */
const SPEED_BY_MODE: Record<SpeedMode, number> = { Slow: 20, Medium: 45, Fast: 120 };

const CLASS = {
  mathLib: "FT_ScriptMathLib",
  dataObject: "FT_ScriptDataObject",
  pulseComponent: "FT_ScriptPulseComponent",
  spawned: "FT_ScriptSpawned",
  spinner: "FT_ScriptSpinner",
  spinnerFast: "FT_ScriptSpinnerFast",
  interfaceProbe: "FT_ScriptInterfaceProbe",
  statsCommand: "FT_ScriptStatsCommand",
  spawnCommand: "FT_ScriptSpawnCommand",
  streamCommand: "FT_ScriptStreamCommand",
  gameInstance: "FT_GameInstance",
  scoreSubsystem: "FT_GameScoreSubsystem",
  sceneWatcher: "FT_GameSceneWatcher",
  dataProbe: "FT_DataProbe",
  saveProbe: "FT_DataSaveProbe",
  streamLoader: "FT_StreamLoader",
  editorProbe: "FT_EditorProbe",
  editorMath: "FT_EditorMath",
} as const;

const STREAMED_ROOM_NAME = "FT_StreamedRoom";
const ZERO_ROTATOR = { pitch: 0, yaw: 0, roll: 0 };

const DESCRIBE_METHOD = "Describe";
const DESCRIBE_PINS: GraphClassMemberPin[] = [{ name: "Label", typeId: "string", direction: "out" }];
const WAVE_PINS: GraphClassMemberPin[] = [
  { name: "Time", typeId: "float", direction: "in" },
  { name: "Value", typeId: "float", direction: "out" },
];

/** Data Definition fields (stable ids; Data Tree values are keyed by name). */
const ITEM_FIELDS: DataDefinitionField[] = [
  { id: "ft-data-field-damage", name: "Damage", typeId: "int", defaultValue: 10, min: 0, max: 999, category: "Combat" },
  { id: "ft-data-field-weight", name: "Weight", typeId: "float", defaultValue: 1, min: 0, category: "Physical" },
  { id: "ft-data-field-label", name: "Label", typeId: "string", defaultValue: "", category: "Display" },
];

const SPIN_CONFIG_FIELDS = [
  { id: "ft-script-field-label", name: "Label", typeId: "string", defaultValue: "Spinner" },
  { id: "ft-script-field-rate", name: "Rate", typeId: "float", defaultValue: 1 },
];

/** Save Game field node data (permanent field id, display name, type). */
const VISITS_FIELD = { fieldId: "visits", fieldName: "Visits", typeId: "int", array: false };

interface ScriptingTypes {
  speedMode: { guid: string; members: Array<{ name: string; value: number }> };
  spinConfig: string;
  describable: string;
  itemStats: string;
  itemsTree: string;
  pulseAction: string;
  nudgeAxis: string;
  tags: { scripting: number; perfHeavy: number };
}

/** A Class plus the prefab components its scene instances copy. */
interface PlacedClass {
  ref: FeatureTestClassRef;
  components: SerializedComponent[];
}

interface ScriptingRefs {
  spinner: PlacedClass;
  interfaceProbe: PlacedClass;
  dataProbe: PlacedClass;
  saveProbe: PlacedClass;
  streamLoader: PlacedClass;
  marker: { guid: string; components: SerializedComponent[] };
  roomGuid: string;
}

const typesByContext = new WeakMap<FeatureTestContext, ScriptingTypes>();
const refsByContext = new WeakMap<FeatureTestContext, ScriptingRefs>();

/**
 * Type and input assets the scripting Classes use: Enum, Structure, Script
 * Interface and Save Game through the New Asset path (their payload embeds the
 * asset guid and the header keeps the full schema), then Data Definition, Data
 * Tree and an Input Action / 2D Input Axis through ProjectService saves.
 */
export async function buildFeatureTestScriptingTypes(ctx: FeatureTestContext): Promise<void> {
  const tags = featureTestTagIds();
  ctx.patchSettings((settings) => {
    // Graph literals store numeric Tag ids; fail loudly if the registry drifts.
    for (const [path, id] of tags) {
      const actual = findTag(settings.tags, path);
      if (actual !== id) {
        throw new Error(`FeatureTest Tag "${path}" has id ${actual}; scripting graphs expect ${id}.`);
      }
    }
    return settings;
  });

  const members = SPEED_MODES.map((name, value) => ({ name, value }));
  const speedMode = await ctx.createAsset("Enum", TYPES_FOLDER, "FT_ScriptSpeedMode", {
    payload: (payload) => ({ ...payload, members }),
  });
  const spinConfig = await ctx.createAsset("Structure", TYPES_FOLDER, "FT_ScriptSpinConfig", {
    payload: (payload) => ({ ...payload, fields: SPIN_CONFIG_FIELDS }),
  });
  const describable = await ctx.createAsset("ScriptInterface", TYPES_FOLDER, "FT_ScriptDescribable", {
    payload: (payload) => ({ ...payload, methods: [{ name: DESCRIBE_METHOD, pins: DESCRIBE_PINS }] }),
  });
  const progress = await ctx.createAsset("SaveGame", DATA_FOLDER, "FT_DataProgress", {
    payload: (payload) => ({
      ...validateSaveGameDefinition({
        ...payload,
        fields: [
          { id: VISITS_FIELD.fieldId, name: VISITS_FIELD.fieldName, type: "int", defaultValue: 0 },
          { id: "best-score", name: "BestScore", type: "float", defaultValue: 0 },
        ],
      }),
    }),
  });
  ctx.patchSettings((settings) => ({
    ...settings,
    // Wiped on every Play so performance runs always start from a missing save.
    saveGame: { definitionGuid: progress.guid, defaultSlot: "featuretest", defaultProfile: "default", wipeOnPlay: true },
  }));

  const itemStats = await saveDocumentGuid(ctx, "data-definition", DATA_FOLDER,
    newAssetFileName("DataDefinition", "FT_DataItemStats"), { ...createDataDefinitionAsset(ITEM_FIELDS) });
  const itemsTree = await saveDocumentGuid(ctx, "data-tree", DATA_FOLDER, newAssetFileName("DataTree", "FT_DataItems"),
    { ...createDataTreeAsset(itemStats, itemEntries(itemStats)) });

  const pulseAction = await saveDocumentGuid(ctx, "input-action", INPUT_FOLDER,
    newAssetFileName("InputAction", "FT_ScriptPulse"), {
      ...normalizeInputAssetPayload("InputAction", {
        bindings: [
          { id: "ft-script-pulse-key", device: "key", code: "KeyP" },
          { id: "ft-script-pulse-pad", device: "gamepadButton", code: "0:3" },
        ],
      }),
    });
  const nudgeAxis = await saveDocumentGuid(ctx, "input-axis", INPUT_FOLDER,
    newAssetFileName("InputAxis", "FT_ScriptNudge"), {
      ...normalizeInputAssetPayload("InputAxis", {
        valueType: "2d",
        bindings: [
          { id: "ft-script-nudge-left", device: "key", code: "ArrowLeft", component: "x", digitalValue: -1 },
          { id: "ft-script-nudge-right", device: "key", code: "ArrowRight", component: "x", digitalValue: 1 },
          { id: "ft-script-nudge-down", device: "key", code: "ArrowDown", component: "y", digitalValue: -1 },
          { id: "ft-script-nudge-up", device: "key", code: "ArrowUp", component: "y", digitalValue: 1 },
        ],
      }),
    });

  typesByContext.set(ctx, {
    speedMode: { guid: speedMode.guid, members },
    spinConfig: spinConfig.guid,
    describable: describable.guid,
    itemStats,
    itemsTree,
    pulseAction,
    nudgeAxis,
    tags: { scripting: tagId(tags, "FeatureTest.Scripting"), perfHeavy: tagId(tags, "FeatureTest.Perf.Heavy") },
  });
}

/**
 * Classes for every scripting base class, the console commands `ft_spawn`,
 * `ft_stream` and `ft_stats`, the editor utility, the `FT_ScriptMarker`
 * Prefab and the `FT_StreamedRoom` sub-scene; selects the Game Instance and
 * registers the Editor Utility Object.
 */
export async function buildFeatureTestScripting(ctx: FeatureTestContext): Promise<void> {
  const types = typesByContext.get(ctx);
  if (!types) throw new Error("FeatureTest scripting types must be built before the scripting Classes.");
  const font = requireRef(ctx.assets.fonts.facetype, "the facetype Font");
  const materials = ctx.assets.materials;

  // Referenced Classes first so header dependencies resolve.
  await saveMathLibrary(ctx);
  await saveScoreSubsystem(ctx);
  await saveDataObject(ctx);
  await savePulseComponent(ctx);
  await saveSpawned(ctx, materials.emissive ?? null);
  const spinner = await saveSpinner(ctx, types, materials.surface ?? null);
  await saveSpinnerFast(ctx, types);
  await saveSceneWatcher(ctx);
  await saveGameInstance(ctx);
  const interfaceProbe = await saveInterfaceProbe(ctx, types, font, materials.surfaceInstance ?? null);
  const dataProbe = await saveDataProbe(ctx, types, font, materials.surfaceInstance ?? null);
  const saveProbe = await saveSaveProbe(ctx, font, materials.surfaceInstance ?? null);
  const streamLoader = await saveStreamLoader(ctx);
  await saveStatsCommand(ctx);
  await saveSpawnCommand(ctx);
  await saveStreamCommand(ctx);
  await saveEditorClasses(ctx);
  const marker = await saveMarkerPrefab(ctx, font, materials.surfaceInstance ?? null);
  const room = await addStreamedRoom(ctx, spinner, font);

  ctx.patchSettings((settings) => ({
    ...settings,
    gameInstanceClass: CLASS.gameInstance,
    editorUtilityObjects: [...new Set([...settings.editorUtilityObjects, CLASS.editorProbe])],
  }));
  refsByContext.set(ctx, { spinner, interfaceProbe, dataProbe, saveProbe, streamLoader, marker, roomGuid: room });
}

/** Scripting zone (Spinner grid, Fast Spinner, probes, Prefab instances) and the Stream Loader. */
export async function placeFeatureTestScripting(ctx: FeatureTestContext): Promise<void> {
  const refs = refsByContext.get(ctx);
  const types = typesByContext.get(ctx);
  if (!refs || !types) throw new Error("FeatureTest scripting assets must be built before placement.");
  placeScriptingZone(ctx, refs, types);
  placeStreamingZone(ctx, refs);
}

// ---------------------------------------------------------------------------
// Types

/** Replays the base FeatureTest Tag registry so graph literals match `settings.ts`. */
function featureTestTagIds(): Map<string, number> {
  let registry = normalizeTagRegistry(undefined);
  for (const path of FEATURE_TEST_TAGS) registry = createTag(registry, path).registry;
  return new Map(registry.tags.map((entry) => [entry.path, entry.id]));
}

function tagId(tags: ReadonlyMap<string, number>, path: string): number {
  const id = tags.get(path);
  if (!id) throw new Error(`FeatureTest Tag "${path}" is not registered.`);
  return id;
}

/**
 * ProjectService save, then the guid the registry indexed (the save assigns
 * it; a guid reserved before the first save is not reused).
 */
async function saveDocumentGuid(
  ctx: FeatureTestContext,
  kind: "data-definition" | "data-tree" | "input-action" | "input-axis" | "prefab",
  folder: string,
  fileName: string,
  content: Record<string, unknown>,
): Promise<string> {
  const { path } = await ctx.saveDocument(kind, folder, fileName, content);
  return requireRef(ctx.registry.getByPath(path)?.header.guid, path);
}

/** Untyped Weapons / Consumables groups; typed entries name the Definition explicitly. */
function itemEntries(definitionGuid: string) {
  const schema = ITEM_FIELDS.map(({ id, name, typeId }) => ({ id, name, typeId }));
  const item = (id: string, name: string, parentId: string, values: Record<string, unknown>) =>
    createDataTreeEntry({ id, name, parentId, definitionGuid, values, schema });
  return [
    createDataTreeEntry({ id: "ft-data-weapons", name: "Weapons", definitionGuid: null, values: {} }),
    item("ft-data-sword", "Sword", "ft-data-weapons", { Damage: 25, Weight: 3.5, Label: "Iron Sword" }),
    item("ft-data-shield", "Shield", "ft-data-weapons", { Damage: 5, Weight: 6, Label: "Oak Shield" }),
    createDataTreeEntry({ id: "ft-data-consumables", name: "Consumables", definitionGuid: null, values: {} }),
    item("ft-data-potion", "Potion", "ft-data-consumables", { Damage: 0, Weight: 0.25, Label: "Health Potion" }),
  ];
}

// ---------------------------------------------------------------------------
// Graph helpers

const fmtArg = (name: string) => `arg:${encodeURIComponent(name)}`;
const outputId = (member: GraphClassMember) => `${member.id}-output`;
const inputId = (member: GraphClassMember) => `${member.id}-input`;

function format(id: string, x: number, y: number, template: string): GraphNode {
  return gNode(id, "string.format", x, y, { "default:format": template });
}

/** Keyed Print String: repeated prints replace one on-screen line. */
function printText(id: string, x: number, y: number, key: string, text?: string, duration = 5): GraphNode {
  return gNode(id, "debug.printString", x, y, {
    ...(text !== undefined ? { "default:inString": text } : {}),
    "default:key": key,
    "default:duration": duration,
  });
}

/** Output Log line (kept in exported builds, unlike Print). */
function logLine(id: string, x: number, y: number, message?: string): GraphNode {
  return gNode(id, "debug.log", x, y, {
    severity: "log",
    category: "FeatureTest",
    ...(message !== undefined ? { "default:message": message } : {}),
  });
}

function delay(id: string, x: number, y: number, seconds: number): GraphNode {
  return gNode(id, "timers.delay", x, y, { "default:duration": seconds });
}

function cast(id: string, x: number, y: number, classId: string, resultKind: "actorRef" | "objectRef"): GraphNode {
  return gNode(id, "casting.cast", x, y, { "default:class": classId, defaultClassId: classId, resultKind });
}

/** Get Variable on another object (Target wired). */
function getVarOn(id: string, member: GraphClassMember, classId: string, x: number, y: number): GraphNode {
  const node = getVar(id, member, x, y);
  node.data.implicitSelf = false;
  node.data.classId = classId;
  return node;
}

/** Call a function on self; exec handles are `exec` / `then`. */
function callSelf(id: string, x: number, y: number, member: GraphClassMember, defaults: Record<string, unknown> = {}): GraphNode {
  return gNode(id, "functions.call", x, y, {
    title: `Call ${member.name}`,
    functionName: member.name,
    implicitSelf: true,
    pins: member.pins,
    ...defaults,
  });
}

/** Static Function Library call (no Target). */
function callStatic(
  id: string,
  x: number,
  y: number,
  classId: string,
  member: GraphClassMember,
  defaults: Record<string, unknown> = {},
): GraphNode {
  return gNode(id, "functions.call", x, y, {
    title: `Call ${member.name}`,
    functionName: member.name,
    classId,
    implicitSelf: true,
    static: true,
    pins: member.pins,
    ...defaults,
  });
}

/** Call a function on a wired Target of `classId`. */
function callOn(
  id: string,
  x: number,
  y: number,
  classId: string,
  member: GraphClassMember,
  defaults: Record<string, unknown> = {},
): GraphNode {
  return gNode(id, "functions.call", x, y, {
    title: `Call ${member.name}`,
    functionName: member.name,
    classId,
    implicitSelf: false,
    pins: member.pins,
    ...defaults,
  });
}

function callEvent(id: string, x: number, y: number, event: GraphClassMember, defaults: Record<string, unknown>): GraphNode {
  return gNode(id, "flow.event.call", x, y, {
    title: `Call ${event.name}`,
    name: event.name,
    implicitSelf: true,
    pins: event.pins,
    ...defaults,
  });
}

function commandRun(name: string, description: string, parameters: unknown[] = []): GraphNode {
  return gNode("run", "flow.event.commandRun", 0, 0, { commandName: name, description, category: "FeatureTest", parameters });
}

function report(id: string, x: number, y: number, success: boolean, output?: string): GraphNode {
  return gNode(id, "debug.reportCommand", x, y, {
    "default:success": success,
    ...(output !== undefined ? { "default:output": output } : {}),
  });
}

/** Function body whose Output pin is a literal (no wire). */
function literalOutput(member: GraphClassMember, pin: string, value: unknown): ReturnType<typeof fnGraph> {
  const graph = fnGraph(member);
  const output = graph.nodes.find((node) => node.id === outputId(member));
  if (output) output.data[`default:${pin}`] = value;
  return graph;
}

function vec(position: Vec3): { x: number; y: number; z: number } {
  return { x: position[0], y: position[1], z: position[2] };
}

function textLabel(id: string, text: string, font: string, position: Vec3, size = 0.3, parentId: string | null = null): SerializedComponent {
  const label = createText3DComponent(id);
  Object.assign(label.properties, { text, size, color: [0.92, 0.95, 1], alignment: "center", fontAssetGuid: font });
  label.parentId = parentId;
  label.transform = tf(position);
  return label;
}

function scaledMesh(
  id: string,
  kind: "box" | "sphere" | "cylinder",
  scale: number,
  materialGuid: string | null,
): SerializedComponent {
  const mesh = meshComp(id, kind, { materialGuid });
  mesh.transform = tf([0, 0, 0], { scale: [scale, scale, scale] });
  return mesh;
}

// ---------------------------------------------------------------------------
// Shared members (Callers keep the same ids and pins as the owning Class).

const LIB_WAVE = fnMember("ft-script-fn-lib-wave", "Wave", [
  { name: "Time", typeId: "float", direction: "in" },
  { name: "Amplitude", typeId: "float", direction: "in" },
  { name: "Value", typeId: "float", direction: "out" },
]);
const SCORE = varMember("ft-game-var-score", "Score", "int", 0, { category: "Score" });
const ADD_SCORE = fnMember("ft-game-fn-add-score", "AddScore", [{ name: "Amount", typeId: "int", direction: "in" }]);
const GI_BOOTED = varMember("ft-game-var-booted", "Booted", "bool", false);
const GI_OBJECT_CLASS = varMember("ft-game-var-object-class", "ObjectClass", "class", CLASS.dataObject, {
  typeClassId: CLASS.dataObject,
});
const COMPUTE_WAVE = fnMember("ft-script-fn-compute-wave", "ComputeWave", WAVE_PINS, { overridable: true, category: "Spin" });

function describeMember(id: string, interfaceGuid: string): GraphClassMember {
  return fnMember(id, DESCRIBE_METHOD, DESCRIBE_PINS, {
    implementsInterface: { assetGuid: interfaceGuid, methodName: DESCRIBE_METHOD },
  });
}

function describeCall(interfaceGuid: string): Record<string, unknown> {
  return {
    title: `Call Interface ${DESCRIBE_METHOD}`,
    interfaceGuid,
    method: DESCRIBE_METHOD,
    implicitSelf: false,
    pins: DESCRIBE_PINS,
  };
}

async function saveClass(
  ctx: FeatureTestContext,
  name: string,
  parentClass: string,
  graph: SerializedGraph,
  folder = SCRIPT_FOLDER,
): Promise<FeatureTestClassRef> {
  return ctx.saveClass({ folder, name, parentClass, graph });
}

// ---------------------------------------------------------------------------
// Classes

/** Function Library: static `Wave(Time, Amplitude)`, called from every Spinner tick. */
async function saveMathLibrary(ctx: FeatureTestContext): Promise<void> {
  const graph = classGraph({
    members: [LIB_WAVE],
    functionGraphs: {
      [LIB_WAVE.id]: fnGraph(LIB_WAVE, {
        nodes: [gNode("wave-sin", "math.sin", 320, 200), gNode("wave-scale", "math.mul", 540, 200)],
        edges: [
          gWire(inputId(LIB_WAVE), "Time", "wave-sin", "in"),
          gWire("wave-sin", "out", "wave-scale", "a"),
          gWire(inputId(LIB_WAVE), "Amplitude", "wave-scale", "b"),
          gWire("wave-scale", "out", outputId(LIB_WAVE), "Value"),
        ],
      }),
    },
  });
  await saveClass(ctx, CLASS.mathLib, "FunctionLibrary", graph);
}

/** Game Subsystem: Score plus `AddScore`, called through Get Subsystem by every Pulse. */
async function saveScoreSubsystem(ctx: FeatureTestContext): Promise<void> {
  const graph = classGraph({
    members: [SCORE, ADD_SCORE],
    nodes: [gNode("init", "flow.event.init", 0, 0), logLine("ready", 240, 0, "FT_GameScoreSubsystem ready")],
    edges: [gExec("init", "ready")],
    functionGraphs: {
      [ADD_SCORE.id]: fnGraph(ADD_SCORE, {
        nodes: [
          getVar("add-get-score", SCORE, 280, 260),
          gNode("add-sum", "math.add_int", 480, 260),
          setVar("add-set-score", SCORE, 520, 120),
        ],
        edges: [
          gWire(inputId(ADD_SCORE), "exec", "add-set-score", "execIn"),
          gWire("add-set-score", "execOut", outputId(ADD_SCORE), "then"),
          gWire("add-get-score", "value", "add-sum", "a"),
          gWire(inputId(ADD_SCORE), "Amount", "add-sum", "b"),
          gWire("add-sum", "out", "add-set-score", "value"),
        ],
      }, false),
    },
  });
  await saveClass(ctx, CLASS.scoreSubsystem, "GameSubsystem", graph);
}

/** BObject: a variable and a function; referenced as a Class variable by the Game Instance. */
async function saveDataObject(ctx: FeatureTestContext): Promise<void> {
  const note = varMember("ft-script-var-note", "Note", "string", "FeatureTest BObject");
  const describe = fnMember("ft-script-fn-describe-object", "DescribeObject", [
    { name: "Text", typeId: "string", direction: "out" },
  ]);
  const graph = classGraph({
    members: [note, describe],
    functionGraphs: {
      [describe.id]: fnGraph(describe, {
        nodes: [getVar("describe-note", note, 360, 240)],
        edges: [gWire("describe-note", "value", outputId(describe), "Text")],
      }),
    },
  });
  await saveClass(ctx, CLASS.dataObject, "BObject", graph);
}

/** Actor Component: Begin Play print and a per-tick counter on every Spinner. */
async function savePulseComponent(ctx: FeatureTestContext): Promise<void> {
  const ticks = varMember("ft-script-var-tick-count", "TickCount", "int", 0);
  const graph = classGraph({
    members: [ticks],
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      printText("ready", 240, 0, "ft-script-component", "FT_ScriptPulseComponent Begin Play"),
      gNode("tick", "flow.event.tick", 0, 200),
      getVar("get-ticks", ticks, 0, 340),
      gNode("next-ticks", "math.add_int", 240, 340, { "default:b": 1 }),
      setVar("set-ticks", ticks, 480, 200),
    ],
    edges: [
      gExec("begin", "ready"),
      gExec("tick", "set-ticks"),
      gWire("get-ticks", "value", "next-ticks", "a"),
      gWire("next-ticks", "out", "set-ticks", "value"),
    ],
  });
  await saveClass(ctx, CLASS.pulseComponent, "ActorComponent", graph);
}

/** Spawn Actor target (Game Instance and `ft_spawn`). */
async function saveSpawned(ctx: FeatureTestContext, materialGuid: string | null): Promise<void> {
  const graph = classGraph({
    components: [scaledMesh("prefab-mesh", "sphere", 0.5, materialGuid)],
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      printText("ready", 240, 0, "ft-script-spawned", "FT_ScriptSpawned entered play", 3),
    ],
    edges: [gExec("begin", "ready")],
  });
  await saveClass(ctx, CLASS.spawned, "Actor", graph);
}

/**
 * The per-tick workload and the variable / event / function / interface /
 * input showcase: Speed Mode (Enum) picks Spin Speed, Config (Structure)
 * scales it, Actor Tags (TagContainer) gate a print, Pulse (custom event)
 * calls the Score subsystem, Tick spins by `ComputeWave` (overridable, calls
 * the static library), `FT_ScriptPulse` pulses and `FT_ScriptNudge` slides.
 */
async function saveSpinner(ctx: FeatureTestContext, types: ScriptingTypes, materialGuid: string | null): Promise<PlacedClass> {
  const spinSpeed = varMember("ft-script-var-spin-speed", "SpinSpeed", "float", SPEED_BY_MODE.Medium, { category: "Spin" });
  const speedMode = varMember("ft-script-var-speed-mode", "SpeedMode", "enum", "Medium", {
    typeClassId: types.speedMode.guid,
    category: "Spin",
  });
  const config = varMember("ft-script-var-config", "Config", "struct", { Label: "Spinner", Rate: 1 }, {
    typeClassId: types.spinConfig,
    category: "Spin",
  });
  const actorTags = varMember("ft-script-var-actor-tags", "ActorTags", "struct", { Tags: [types.tags.scripting] }, {
    typeClassId: "engine:TagContainer",
  });
  const elapsed = varMember("ft-script-var-elapsed", "Elapsed", "float", 0, { category: "Spin" });
  const pulseCount = varMember("ft-script-var-pulse-count", "PulseCount", "int", 0);
  const pulse: GraphClassMember = {
    id: "ft-script-evt-pulse",
    kind: "event",
    name: "Pulse",
    pins: [{ name: "Strength", typeId: "float", direction: "out" }],
  };
  const describable: GraphClassMember = {
    id: "ft-script-iface-describable",
    kind: "interface",
    name: "FT_ScriptDescribable",
    assetGuid: types.describable,
  };
  const describe = describeMember("ft-script-fn-describe", types.describable);
  const structFields = { structGuid: types.spinConfig, fields: SPIN_CONFIG_FIELDS };
  const binding = (name: string, asset: string) => ({ Input: { Name: name, Asset: asset } });

  const components = [
    scaledMesh("prefab-mesh", "box", 0.8, materialGuid),
    comp("prefab-pulse", CLASS.pulseComponent),
  ];
  const graph = classGraph({
    members: [spinSpeed, speedMode, config, actorTags, elapsed, pulseCount, pulse, COMPUTE_WAVE, describable, describe],
    components,
    nodes: [
      // Begin Play: ready print | Speed Mode switch | Tag branch | delayed Pulse.
      gNode("begin", "flow.event.beginPlay", 0, 0),
      gNode("begin-steps", "flow.sequence", 220, 0, { count: 4 }),
      printText("ready", 480, -240, "ft-script-spinner", "FT_ScriptSpinner Begin Play"),
      getVar("get-mode", speedMode, 220, 160),
      gNode("mode-switch", "enum.switch", 480, -60, { enumGuid: types.speedMode.guid, members: types.speedMode.members }),
      ...SPEED_MODES.map((mode, index) =>
        setVar(`speed-${mode.toLowerCase()}`, spinSpeed, 760, -180 + index * 120, SPEED_BY_MODE[mode])),
      getVar("get-tags", actorTags, 220, 420),
      gNode("has-tag", "tags.has", 480, 420, { "default:tag": types.tags.scripting, "default:exact": false }),
      gNode("tag-branch", "flow.branch", 760, 260),
      printText("tagged", 1000, 260, "ft-script-tag", "Spinner tagged FeatureTest.Scripting"),
      delay("pulse-delay", 480, 600, 2),
      callEvent("pulse-call", 760, 600, pulse, { "default:Strength": 2.5 }),
      // Pulse: count, add score through the Game Subsystem, print.
      gNode(pulse.id, "flow.event.custom", 0, 860, { title: "Event Pulse", name: pulse.name, pins: pulse.pins }),
      getVar("get-pulses", pulseCount, 0, 1020),
      gNode("next-pulse", "math.add_int", 220, 1020, { "default:b": 1 }),
      setVar("set-pulses", pulseCount, 440, 860),
      gNode("score-subsystem", "subsystem.get", 440, 1060, { classId: CLASS.scoreSubsystem }),
      callOn("add-score", 700, 860, CLASS.scoreSubsystem, ADD_SCORE, { "default:Amount": 1 }),
      format("pulse-text", 700, 1060, "Pulse {strength} (#{count})"),
      printText("pulse-print", 960, 860, "ft-script-pulse"),
      // Input Action / Axis events (evaluated on Tick).
      gNode("on-pulse", "input.actionEvent", 0, 1300, {
        valueType: "button",
        "default:binding": binding("FT_ScriptPulse", types.pulseAction),
      }),
      callEvent("input-pulse", 260, 1300, pulse, { "default:Strength": 1 }),
      gNode("on-nudge", "input.axisEvent", 0, 1500, {
        valueType: "2d",
        "default:binding": binding("FT_ScriptNudge", types.nudgeAxis),
      }),
      gNode("nudge-axes", "vector.break2", 260, 1620),
      gNode("nudge-vector", "vector.make3", 460, 1620, { "default:y": 0 }),
      gNode("nudge-scale", "vector.scale3", 660, 1620, { "default:s": NUDGE_STEP }),
      gNode("nudge-self", "actor.getSelf", 660, 1780),
      gNode("nudge", "transform.addWorldOffset", 900, 1500),
      // Tick: Elapsed += dt, ComputeWave(Elapsed), yaw += dt * SpinSpeed * Rate * (1 + wave).
      gNode("tick", "flow.event.tick", 0, 1960),
      getVar("get-elapsed", elapsed, 0, 2120),
      gNode("next-elapsed", "math.add", 220, 2120),
      setVar("set-elapsed", elapsed, 440, 1960),
      callSelf("wave", 700, 1960, COMPUTE_WAVE),
      getVar("get-speed", spinSpeed, 0, 2300),
      getVar("get-config", config, 0, 2440),
      gNode("config-fields", "struct.break", 220, 2440, structFields),
      gNode("rate", "math.mul", 440, 2300),
      gNode("step", "math.mul", 660, 2300),
      gNode("factor", "math.add", 880, 2160, { "default:b": 1 }),
      gNode("yaw-step", "math.mul", 1100, 2220),
      gNode("yaw", "struct.makeRotator", 1320, 2220, { "default:pitch": 0, "default:roll": 0 }),
      gNode("spin-self", "actor.getSelf", 1100, 2440),
      gNode("current", "transform.getRotation", 1320, 2440),
      gNode("combined", "rotator.combine", 1540, 2300),
      gNode("turn", "transform.setRotation", 1760, 1960),
    ],
    edges: [
      gExec("begin", "begin-steps"),
      gWire("begin-steps", "then0", "ready", "execIn"),
      gWire("begin-steps", "then1", "mode-switch", "execIn"),
      gWire("begin-steps", "then2", "tag-branch", "execIn"),
      gWire("begin-steps", "then3", "pulse-delay", "execIn"),
      gWire("get-mode", "value", "mode-switch", "value"),
      ...SPEED_MODES.map((mode) => gWire("mode-switch", `case:${mode}`, `speed-${mode.toLowerCase()}`, "execIn")),
      gWire("get-tags", "value", "has-tag", "container"),
      gWire("has-tag", "out", "tag-branch", "condition"),
      gWire("tag-branch", "true", "tagged", "execIn"),
      gExec("pulse-delay", "pulse-call"),

      gExec(pulse.id, "set-pulses"),
      gWire("get-pulses", "value", "next-pulse", "a"),
      gWire("next-pulse", "out", "set-pulses", "value"),
      gWire("set-pulses", "execOut", "add-score", "exec"),
      gWire("score-subsystem", "subsystem", "add-score", "target"),
      gWire("add-score", "then", "pulse-print", "execIn"),
      gWire(pulse.id, "Strength", "pulse-text", fmtArg("strength")),
      gWire("set-pulses", "out", "pulse-text", fmtArg("count")),
      gWire("pulse-text", "out", "pulse-print", "inString"),

      gWire("on-pulse", "started", "input-pulse", "execIn"),
      gWire("on-nudge", "held", "nudge", "execIn"),
      gWire("on-nudge", "value", "nudge-axes", "in"),
      gWire("nudge-axes", "x", "nudge-vector", "x"),
      gWire("nudge-axes", "y", "nudge-vector", "z"),
      gWire("nudge-vector", "out", "nudge-scale", "v"),
      gWire("nudge-scale", "out", "nudge", "offset"),
      gWire("nudge-self", "out", "nudge", "target"),

      gExec("tick", "set-elapsed"),
      gWire("get-elapsed", "value", "next-elapsed", "a"),
      gWire("tick", "deltaSeconds", "next-elapsed", "b"),
      gWire("next-elapsed", "out", "set-elapsed", "value"),
      gWire("set-elapsed", "execOut", "wave", "exec"),
      gWire("set-elapsed", "out", "wave", "Time"),
      gWire("wave", "then", "turn", "execIn"),
      gWire("get-speed", "value", "rate", "a"),
      gWire("get-config", "value", "config-fields", "in"),
      gWire("config-fields", "Rate", "rate", "b"),
      gWire("tick", "deltaSeconds", "step", "a"),
      gWire("rate", "out", "step", "b"),
      gWire("wave", "Value", "factor", "a"),
      gWire("step", "out", "yaw-step", "a"),
      gWire("factor", "out", "yaw-step", "b"),
      gWire("yaw-step", "out", "yaw", "yaw"),
      gWire("spin-self", "out", "current", "target"),
      gWire("spin-self", "out", "turn", "target"),
      gWire("current", "out", "combined", "a"),
      gWire("yaw", "out", "combined", "b"),
      gWire("combined", "out", "turn", "rotation"),
    ],
    functionGraphs: {
      [COMPUTE_WAVE.id]: fnGraph(COMPUTE_WAVE, {
        nodes: [callStatic("wave-library", 400, 120, CLASS.mathLib, LIB_WAVE, { "default:Amplitude": 0.5 })],
        edges: [
          gWire(inputId(COMPUTE_WAVE), "exec", "wave-library", "exec"),
          gWire("wave-library", "then", outputId(COMPUTE_WAVE), "then"),
          gWire(inputId(COMPUTE_WAVE), "Time", "wave-library", "Time"),
          gWire("wave-library", "Value", outputId(COMPUTE_WAVE), "Value"),
        ],
      }, false),
      [describe.id]: fnGraph(describe, {
        nodes: [
          getVar("describe-config", config, 300, 240),
          gNode("describe-fields", "struct.break", 520, 240, structFields),
        ],
        edges: [
          gWire("describe-config", "value", "describe-fields", "in"),
          gWire("describe-fields", "Label", outputId(describe), "Label"),
        ],
      }),
    },
  });
  const ref = await saveClass(ctx, CLASS.spinner, "Actor", graph);
  return { ref, components };
}

/** Child Class: overrides `ComputeWave` (reverses periodically) and the interface `Describe`. */
async function saveSpinnerFast(ctx: FeatureTestContext, types: ScriptingTypes): Promise<void> {
  const wave = fnMember("ft-script-fn-compute-wave-fast", COMPUTE_WAVE.name, WAVE_PINS, {
    overrides: { classId: CLASS.spinner, name: COMPUTE_WAVE.name },
    category: "Spin",
  });
  const describe = describeMember("ft-script-fn-describe-fast", types.describable);
  const graph = classGraph({
    members: [wave, describe],
    functionGraphs: {
      [wave.id]: fnGraph(wave, {
        nodes: [
          gNode("fast-double", "math.mul", 300, 220, { "default:b": 2 }),
          gNode("fast-sin", "math.sin", 500, 220),
          gNode("fast-amplitude", "math.mul", 700, 220, { "default:b": 1.5 }),
        ],
        edges: [
          gWire(inputId(wave), "Time", "fast-double", "a"),
          gWire("fast-double", "out", "fast-sin", "in"),
          gWire("fast-sin", "out", "fast-amplitude", "a"),
          gWire("fast-amplitude", "out", outputId(wave), "Value"),
        ],
      }),
      [describe.id]: literalOutput(describe, "Label", "Fast Spinner (override)"),
    },
  });
  await saveClass(ctx, CLASS.spinnerFast, CLASS.spinner, graph);
}

/** Scene Subsystem: counts spawned scene actors, names Spawn Actor results, reports streaming. */
async function saveSceneWatcher(ctx: FeatureTestContext): Promise<void> {
  const spawnedActors = varMember("ft-game-var-spawned-actors", "SpawnedActors", "int", 0);
  const graph = classGraph({
    members: [spawnedActors],
    nodes: [
      gNode("spawned", "flow.event.sceneActorSpawned", 0, 0),
      getVar("get-spawned", spawnedActors, 0, 160),
      gNode("next-spawned", "math.add_int", 220, 160, { "default:b": 1 }),
      setVar("set-spawned", spawnedActors, 440, 0),
      cast("as-spawned", 680, 0, CLASS.spawned, "actorRef"),
      gNode("spawned-branch", "flow.branch", 920, 0),
      gNode("spawned-name", "actor.getName", 920, 180),
      format("spawned-text", 1140, 180, "Spawned {name}"),
      printText("spawned-print", 1360, 0, "ft-game-spawned"),
      gNode("streamed", "flow.event.streamedSceneLoaded", 0, 400),
      gNode("loader-name", "actor.getName", 220, 540),
      format("streamed-text", 440, 540, "Streamed scene loaded by {loader}"),
      printText("streamed-print", 660, 400, "ft-stream", undefined, 6),
      gNode("unstreamed", "flow.event.streamedSceneUnloaded", 0, 720),
      printText("unstreamed-print", 220, 720, "ft-stream", "Streamed scene unloaded", 6),
    ],
    edges: [
      gExec("spawned", "set-spawned"),
      gWire("get-spawned", "value", "next-spawned", "a"),
      gWire("next-spawned", "out", "set-spawned", "value"),
      gExec("set-spawned", "as-spawned"),
      gWire("spawned", "actor", "as-spawned", "object"),
      gExec("as-spawned", "spawned-branch"),
      gWire("as-spawned", "success", "spawned-branch", "condition"),
      gWire("spawned-branch", "true", "spawned-print", "execIn"),
      gWire("as-spawned", "result", "spawned-name", "target"),
      gWire("spawned-name", "out", "spawned-text", fmtArg("name")),
      gWire("spawned-text", "out", "spawned-print", "inString"),
      gExec("streamed", "streamed-print"),
      gWire("streamed", "streamingActor", "loader-name", "target"),
      gWire("loader-name", "out", "streamed-text", fmtArg("loader")),
      gWire("streamed-text", "out", "streamed-print", "inString"),
      gExec("unstreamed", "unstreamed-print"),
    ],
  });
  await saveClass(ctx, CLASS.sceneWatcher, "SceneSubsystem", graph);
}

/**
 * Game Instance (Project Settings): On Init flags Booted; On First Scene
 * Loaded prints the scene, spawns `FT_ScriptSpawned` when the Scripting zone
 * exists and runs the `ft_stats` console command.
 */
async function saveGameInstance(ctx: FeatureTestContext): Promise<void> {
  const graph = classGraph({
    members: [GI_BOOTED, GI_OBJECT_CLASS],
    nodes: [
      gNode("init", "flow.event.init", 0, 0),
      setVar("set-booted", GI_BOOTED, 220, 0, true),
      logLine("booted-log", 460, 0, "FT_GameInstance initialized"),
      gNode("first-scene", "flow.event.firstSceneLoaded", 0, 240),
      format("scene-text", 220, 400, "FeatureTest loaded {scene}"),
      printText("scene-print", 460, 240, "ft-game-scene", undefined, 6),
      delay("settle", 700, 240, 0.5),
      gNode("find-spinner", "actor.getOfClass", 700, 420, { "default:classId": CLASS.spinner }),
      gNode("has-scripting-zone", "actor.isValid", 940, 420),
      gNode("zone-branch", "flow.branch", 940, 240),
      gNode("spawn-pose", "struct.makeTransform", 1180, 420, {
        "default:location": vec(zonePoint("scripting", [0, 4, 5])),
        "default:rotation": ZERO_ROTATOR,
      }),
      gNode("spawn", "actor.spawn", 1180, 240, { "default:classId": CLASS.spawned }),
      delay("stats-delay", 1420, 240, 1),
      gNode("stats", "debug.executeConsoleCommand", 1660, 240, { "default:command": "ft_stats" }),
      printText("stats-print", 1900, 240, "ft-game-stats", undefined, 8),
    ],
    edges: [
      ...gChain("init", "set-booted", "booted-log"),
      ...gChain("first-scene", "scene-print", "settle", "zone-branch"),
      gWire("first-scene", "sceneName", "scene-text", fmtArg("scene")),
      gWire("scene-text", "out", "scene-print", "inString"),
      gWire("find-spinner", "out", "has-scripting-zone", "target"),
      gWire("has-scripting-zone", "out", "zone-branch", "condition"),
      gWire("zone-branch", "true", "spawn", "execIn"),
      gWire("spawn-pose", "out", "spawn", "transform"),
      ...gChain("spawn", "stats-delay", "stats", "stats-print"),
      gWire("stats", "output", "stats-print", "inString"),
    ],
  });
  await saveClass(ctx, CLASS.gameInstance, "GameInstance", graph);
}

/** Calls `Describe` on both Spinner Classes and reads Game Instance variables through a Cast. */
async function saveInterfaceProbe(
  ctx: FeatureTestContext,
  types: ScriptingTypes,
  font: string,
  materialGuid: string | null,
): Promise<PlacedClass> {
  const components = [
    scaledMesh("prefab-mesh", "sphere", 0.7, materialGuid),
    textLabel("prefab-label", "Interface Probe", font, [0, 1, 0]),
  ];
  const graph = classGraph({
    components,
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      delay("settle", 220, 0, 1),
      gNode("find-fast", "actor.getOfClass", 220, 180, { "default:classId": CLASS.spinnerFast }),
      gNode("find-base", "actor.getOfClass", 220, 300, { "default:classId": CLASS.spinner }),
      gNode("describe-fast", "interface.call", 460, 0, describeCall(types.describable)),
      gNode("describe-base", "interface.call", 700, 0, describeCall(types.describable)),
      gNode("game-instance", "gameInstance.get", 700, 220),
      cast("as-game-instance", 940, 0, CLASS.gameInstance, "objectRef"),
      getVarOn("get-booted", GI_BOOTED, CLASS.gameInstance, 1180, 220),
      getVarOn("get-object-class", GI_OBJECT_CLASS, CLASS.gameInstance, 1180, 340),
      format("report-text", 1400, 220, "Describe {fast} | {base} - Game Instance booted {booted}, object class {object}"),
      printText("report", 1640, 0, "ft-script-interface", undefined, 8),
    ],
    edges: [
      ...gChain("begin", "settle", "describe-fast", "describe-base", "as-game-instance", "report"),
      gWire("find-fast", "out", "describe-fast", "target"),
      gWire("find-base", "out", "describe-base", "target"),
      gWire("game-instance", "gameInstance", "as-game-instance", "object"),
      gWire("as-game-instance", "result", "get-booted", "target"),
      gWire("as-game-instance", "result", "get-object-class", "target"),
      gWire("describe-fast", "Label", "report-text", fmtArg("fast")),
      gWire("describe-base", "Label", "report-text", fmtArg("base")),
      gWire("get-booted", "value", "report-text", fmtArg("booted")),
      gWire("get-object-class", "value", "report-text", fmtArg("object")),
      gWire("report-text", "out", "report", "inString"),
    ],
  });
  const ref = await saveClass(ctx, CLASS.interfaceProbe, "Actor", graph);
  return { ref, components };
}

/** Read Data Entry `Weapons/Sword` + Break, and Get Data Children of `Weapons`. */
async function saveDataProbe(
  ctx: FeatureTestContext,
  types: ScriptingTypes,
  font: string,
  materialGuid: string | null,
): Promise<PlacedClass> {
  const components = [
    scaledMesh("prefab-mesh", "box", 0.6, materialGuid),
    textLabel("prefab-label", "Data Probe", font, [0, 1, 0]),
  ];
  const graph = classGraph({
    components,
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      gNode("read", "data.readEntry", 220, 160, {
        definitionGuid: types.itemStats,
        "default:tree": types.itemsTree,
        "default:entryPath": "Weapons/Sword",
      }),
      gNode("fields", "struct.break", 460, 160, { structGuid: types.itemStats, fields: ITEM_FIELDS }),
      gNode("children", "data.getChildren", 220, 400, { "default:tree": types.itemsTree, "default:entryPath": "Weapons" }),
      gNode("child-count", "array.length", 460, 400),
      format("text", 700, 160, "{label}: {damage} dmg, {weight} kg (found {found}, {weapons} weapons)"),
      printText("print", 940, 0, "ft-data-probe", undefined, 8),
    ],
    edges: [
      gExec("begin", "print"),
      gWire("read", "value", "fields", "in"),
      gWire("fields", "Label", "text", fmtArg("label")),
      gWire("fields", "Damage", "text", fmtArg("damage")),
      gWire("fields", "Weight", "text", fmtArg("weight")),
      gWire("read", "found", "text", fmtArg("found")),
      gWire("children", "paths", "child-count", "array"),
      gWire("child-count", "out", "text", fmtArg("weapons")),
      gWire("text", "out", "print", "inString"),
    ],
  });
  const ref = await saveClass(ctx, CLASS.dataProbe, "Actor", graph, DATA_FOLDER);
  return { ref, components };
}

/** Load Game, increment the Visits Save Field, Save Game; a Save Game Component keeps Visits. */
async function saveSaveProbe(ctx: FeatureTestContext, font: string, materialGuid: string | null): Promise<PlacedClass> {
  const visits = varMember("ft-data-var-visits", "Visits", "int", 0);
  const components = [
    scaledMesh("prefab-mesh", "box", 0.6, materialGuid),
    textLabel("prefab-label", "Save Probe", font, [0, 1, 0]),
    comp("prefab-save", "SaveGameComponent", { actorVariables: [visits.name] }),
  ];
  const graph = classGraph({
    members: [visits],
    components,
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      gNode("load", "saveGame.loadGame", 220, 0),
      gNode("stored-visits", "saveGame.getField", 220, 220, VISITS_FIELD),
      gNode("next-visits", "math.add_int", 440, 220, { "default:b": 1 }),
      setVar("set-visits", visits, 660, 0),
      gNode("store-visits", "saveGame.setField", 900, 0, VISITS_FIELD),
      gNode("save", "saveGame.saveGame", 1140, 0),
      format("saved-text", 1380, 220, "Saved visits {visits}"),
      printText("saved", 1620, 0, "ft-data-save", undefined, 8),
      format("failed-text", 1380, 380, "Save failed: {error}"),
      printText("save-failed", 1620, 220, "ft-data-save", undefined, 8),
      gNode("restored", "flow.event.gameLoaded", 0, 560),
      printText("restored-print", 220, 560, "ft-data-save-restored", "Save Game restored the Save Probe"),
    ],
    edges: [
      gExec("begin", "load"),
      gWire("load", "completed", "set-visits", "execIn"),
      gWire("load", "failed", "set-visits", "execIn"),
      gWire("stored-visits", "value", "next-visits", "a"),
      gWire("next-visits", "out", "set-visits", "value"),
      gExec("set-visits", "store-visits"),
      gWire("set-visits", "out", "store-visits", "value"),
      gExec("store-visits", "save"),
      gWire("save", "completed", "saved", "execIn"),
      gWire("save", "failed", "save-failed", "execIn"),
      gWire("set-visits", "out", "saved-text", fmtArg("visits")),
      gWire("saved-text", "out", "saved", "inString"),
      gWire("save", "errorMessage", "failed-text", fmtArg("error")),
      gWire("failed-text", "out", "save-failed", "inString"),
      gExec("restored", "restored-print"),
    ],
  });
  const ref = await saveClass(ctx, CLASS.saveProbe, "Actor", graph, DATA_FOLDER);
  return { ref, components };
}

/** Scene Streaming Actor Class: Begin Play waits, then Load Scene Async on itself. */
async function saveStreamLoader(ctx: FeatureTestContext): Promise<PlacedClass> {
  const components = createSceneStreamingActor("prefab").components;
  const graph = classGraph({
    components,
    nodes: [
      gNode("begin", "flow.event.beginPlay", 0, 0),
      delay("settle", 220, 0, STREAM_DELAY_SECONDS),
      gNode("self", "actor.getSelf", 220, 180),
      cast("as-streaming", 460, 0, "SceneStreamingActor", "actorRef"),
      gNode("load", "sceneStreaming.loadSceneAsync", 700, 0),
      gNode("scene-name", "sceneStreaming.getTargetSceneName", 700, 200),
      format("loading-text", 940, 200, "Streaming {scene}"),
      printText("loading", 1180, 0, "ft-stream-loader"),
    ],
    edges: [
      ...gChain("begin", "settle", "as-streaming", "load", "loading"),
      gWire("self", "out", "as-streaming", "object"),
      gWire("as-streaming", "result", "load", "target"),
      gWire("as-streaming", "result", "scene-name", "target"),
      gWire("scene-name", "out", "loading-text", fmtArg("scene")),
      gWire("loading-text", "out", "loading", "inString"),
    ],
  });
  const ref = await saveClass(ctx, CLASS.streamLoader, "SceneStreamingActor", graph);
  return { ref, components };
}

/** `ft_stats`: Score, Spinner and spawned counts. */
async function saveStatsCommand(ctx: FeatureTestContext): Promise<void> {
  const graph = classGraph({
    nodes: [
      commandRun("ft_stats", "Print FeatureTest scripting counters"),
      gNode("score-subsystem", "subsystem.get", 0, 200, { classId: CLASS.scoreSubsystem }),
      getVarOn("get-score", SCORE, CLASS.scoreSubsystem, 220, 200),
      gNode("spinners", "actor.getAllOfClass", 0, 340, { "default:classId": CLASS.spinner }),
      gNode("spinner-count", "array.length", 220, 340),
      gNode("spawned", "actor.getAllOfClass", 0, 460, { "default:classId": CLASS.spawned }),
      gNode("spawned-count", "array.length", 220, 460),
      format("stats-text", 460, 300, "FeatureTest score {score}, spinners {spinners}, spawned {spawned}"),
      report("report", 700, 0, true),
    ],
    edges: [
      gExec("run", "report"),
      gWire("score-subsystem", "subsystem", "get-score", "target"),
      gWire("get-score", "value", "stats-text", fmtArg("score")),
      gWire("spinners", "out", "spinner-count", "array"),
      gWire("spinner-count", "out", "stats-text", fmtArg("spinners")),
      gWire("spawned", "out", "spawned-count", "array"),
      gWire("spawned-count", "out", "stats-text", fmtArg("spawned")),
      gWire("stats-text", "out", "report", "output"),
    ],
  });
  await saveClass(ctx, CLASS.statsCommand, "BDebugCommand", graph);
}

/** `ft_spawn [count]`: For Loop of Spawn Actor in a 10 × 10 grid, stacked in layers. */
async function saveSpawnCommand(ctx: FeatureTestContext): Promise<void> {
  const origin = zonePoint("scripting", [-10, 3, 1]);
  const spacing = 1;
  const graph = classGraph({
    nodes: [
      commandRun("ft_spawn", "Spawn FT_ScriptSpawned actors in the Scripting zone", [
        { name: "count", type: "int", optional: true, defaultValue: SPAWN_COMMAND_DEFAULT_COUNT },
      ]),
      gNode("last-index", "math.sub_int", 220, 200, { "default:b": 1 }),
      gNode("loop", "flow.forLoop", 440, 0, { "default:firstIndex": 0 }),
      gNode("column", "math.mod_int", 680, 200, { "default:b": 10 }),
      gNode("row-raw", "math.div_int", 680, 320, { "default:b": 10 }),
      gNode("row", "math.mod_int", 880, 320, { "default:b": 10 }),
      gNode("layer", "math.div_int", 680, 440, { "default:b": 100 }),
      gNode("x-step", "math.mul", 1080, 200, { "default:b": spacing }),
      gNode("x", "math.add", 1280, 200, { "default:b": origin[0] }),
      gNode("y-step", "math.mul", 1080, 440, { "default:b": spacing }),
      gNode("y", "math.add", 1280, 440, { "default:b": origin[1] }),
      gNode("z-step", "math.mul", 1080, 320, { "default:b": spacing }),
      gNode("z", "math.add", 1280, 320, { "default:b": origin[2] }),
      gNode("location", "vector.make3", 1480, 320),
      gNode("pose", "struct.makeTransform", 1680, 320, { "default:rotation": ZERO_ROTATOR }),
      gNode("spawn", "actor.spawn", 1900, 0, { "default:classId": CLASS.spawned }),
      format("done-text", 680, 600, "Spawned {count} FT_ScriptSpawned"),
      report("report", 900, 560, true),
    ],
    edges: [
      gExec("run", "loop"),
      gWire("run", "count", "last-index", "a"),
      gWire("last-index", "out", "loop", "lastIndex"),
      gWire("loop", "loopBody", "spawn", "execIn"),
      gWire("loop", "completed", "report", "execIn"),
      gWire("loop", "index", "column", "a"),
      gWire("loop", "index", "row-raw", "a"),
      gWire("row-raw", "out", "row", "a"),
      gWire("loop", "index", "layer", "a"),
      gWire("column", "out", "x-step", "a"),
      gWire("x-step", "out", "x", "a"),
      gWire("layer", "out", "y-step", "a"),
      gWire("y-step", "out", "y", "a"),
      gWire("row", "out", "z-step", "a"),
      gWire("z-step", "out", "z", "a"),
      gWire("x", "out", "location", "x"),
      gWire("y", "out", "location", "y"),
      gWire("z", "out", "location", "z"),
      gWire("location", "out", "pose", "location"),
      gWire("pose", "out", "spawn", "transform"),
      gWire("run", "count", "done-text", fmtArg("count")),
      gWire("done-text", "out", "report", "output"),
    ],
  });
  await saveClass(ctx, CLASS.spawnCommand, "BDebugCommand", graph);
}

/** `ft_stream`: toggles the Stream Loader's room (Load / Unload Scene Async). */
async function saveStreamCommand(ctx: FeatureTestContext): Promise<void> {
  const graph = classGraph({
    nodes: [
      commandRun("ft_stream", "Toggle the streamed FT_StreamedRoom"),
      gNode("find-loader", "actor.getOfClass", 0, 200, { "default:classId": CLASS.streamLoader }),
      cast("as-streaming", 240, 0, "SceneStreamingActor", "actorRef"),
      gNode("found-branch", "flow.branch", 480, 0),
      gNode("is-loaded", "sceneStreaming.isSceneLoaded", 480, 200),
      gNode("loaded-branch", "flow.branch", 720, 0),
      gNode("unload", "sceneStreaming.unloadSceneAsync", 960, -80),
      report("report-unload", 1200, -80, true, `Unloading ${STREAMED_ROOM_NAME}`),
      gNode("load", "sceneStreaming.loadSceneAsync", 960, 80),
      report("report-load", 1200, 80, true, `Loading ${STREAMED_ROOM_NAME}`),
      report("report-missing", 720, 240, false, "No FT_StreamLoader in this scene"),
    ],
    edges: [
      gExec("run", "as-streaming"),
      gWire("find-loader", "out", "as-streaming", "object"),
      gExec("as-streaming", "found-branch"),
      gWire("as-streaming", "success", "found-branch", "condition"),
      gWire("found-branch", "true", "loaded-branch", "execIn"),
      gWire("found-branch", "false", "report-missing", "execIn"),
      gWire("as-streaming", "result", "is-loaded", "target"),
      gWire("is-loaded", "out", "loaded-branch", "condition"),
      gWire("loaded-branch", "true", "unload", "execIn"),
      gWire("loaded-branch", "false", "load", "execIn"),
      gWire("as-streaming", "result", "unload", "target"),
      gWire("as-streaming", "result", "load", "target"),
      gExec("unload", "report-unload"),
      gExec("load", "report-load"),
    ],
  });
  await saveClass(ctx, CLASS.streamCommand, "BDebugCommand", graph);
}

/** Editor Function Library (authored only) and the registered Editor Utility Object. */
async function saveEditorClasses(ctx: FeatureTestContext): Promise<void> {
  const double = fnMember("ft-editor-fn-double", "DoubleIt", [
    { name: "Value", typeId: "float", direction: "in" },
    { name: "Result", typeId: "float", direction: "out" },
  ]);
  await saveClass(ctx, CLASS.editorMath, "EditorFunctionLibrary", classGraph({
    members: [double],
    functionGraphs: {
      [double.id]: fnGraph(double, {
        nodes: [gNode("double-mul", "math.mul", 400, 220, { "default:b": 2 })],
        edges: [
          gWire(inputId(double), "Value", "double-mul", "a"),
          gWire("double-mul", "out", outputId(double), "Result"),
        ],
      }),
    },
  }), EDITOR_FOLDER);

  const saves = varMember("ft-editor-var-save-count", "SaveCount", "int", 0);
  await saveClass(ctx, CLASS.editorProbe, "EditorUtilityObject", classGraph({
    members: [saves],
    nodes: [
      gNode("startup", "flow.event.editorStartup", 0, 0),
      logLine("startup-log", 240, 0, "FeatureTest editor utility started"),
      gNode("scene-open", "flow.event.sceneOpen", 0, 160),
      logLine("open-log", 240, 160, "FeatureTest scene opened"),
      gNode("scene-saved", "flow.event.sceneSaved", 0, 320),
      getVar("get-saves", saves, 0, 480),
      gNode("next-saves", "math.add_int", 220, 480, { "default:b": 1 }),
      setVar("set-saves", saves, 440, 320),
      format("saved-text", 660, 480, "FeatureTest scene saved {count} times this session"),
      logLine("saved-log", 880, 320),
    ],
    edges: [
      gExec("startup", "startup-log"),
      gExec("scene-open", "open-log"),
      gExec("scene-saved", "set-saves"),
      gWire("get-saves", "value", "next-saves", "a"),
      gWire("next-saves", "out", "set-saves", "value"),
      gExec("set-saves", "saved-log"),
      gWire("set-saves", "out", "saved-text", fmtArg("count")),
      gWire("saved-text", "out", "saved-log", "message"),
    ],
  }), EDITOR_FOLDER);
}

// ---------------------------------------------------------------------------
// Prefab and streamed sub-scene

/** Logic-free Prefab: cylinder plus a 3D Text label. */
async function saveMarkerPrefab(
  ctx: FeatureTestContext,
  font: string,
  materialGuid: string | null,
): Promise<{ guid: string; components: SerializedComponent[] }> {
  const mesh = meshComp("prefab-mesh", "cylinder", { materialGuid });
  const components = [mesh, textLabel("prefab-label", "FT Prefab", font, [0, 1.1, 0], 0.3, mesh.id)];
  const guid = await saveDocumentGuid(ctx, "prefab", PREFAB_FOLDER, newAssetFileName("Prefab", "FT_ScriptMarker"), { components });
  return { guid, components };
}

/** `FT_StreamedRoom`: platform, pillars, sign and a scripted Spinner; no camera, sky or lights. */
async function addStreamedRoom(ctx: FeatureTestContext, spinner: PlacedClass, font: string): Promise<string> {
  const room = createDefaultScene("3d");
  room.name = STREAMED_ROOM_NAME;
  room.actors = [];
  room.settings.mainCameraActorId = null;
  room.settings.mainCameraComponentId = null;
  const add = (entry: SerializedActor) => ctx.addActor(entry, { scene: room });
  add(actor("ft-scripting-room-platform", "Room Platform", tf([0, 0.15, 0], { scale: [5, 0.2, 5] }), [
    meshComp("ft-scripting-room-platform-mesh", "box", { collision: "simple" }),
  ]));
  ([[-3, -3], [3, -3], [-3, 3], [3, 3]] as const).forEach(([x, z], index) => {
    const id = `ft-scripting-room-pillar-${index + 1}`;
    add(actor(id, `Room Pillar ${index + 1}`, tf([x, 1.05, z], { scale: [0.4, 1, 0.4] }), [
      meshComp(`${id}-mesh`, "cylinder"),
    ]));
  });
  add(actor("ft-scripting-room-sign", "Room Sign", tf([0, 2.6, 3.4]), [
    textLabel("ft-scripting-room-sign-text", "Streamed Room", font, [0, 0, 0], 0.45),
  ]));
  add(actor("ft-scripting-room-spinner", "Streamed Spinner", tf([0, 1.4, 0]),
    instanceComponents("ft-scripting-room-spinner", spinner.components),
    {
      classId: spinner.ref.classId,
      properties: { SpeedMode: "Fast", Config: { Label: "Streamed Spinner", Rate: 1.5 } },
    }));
  const saved = await ctx.addSceneDocument({
    kind: "scene",
    folder: SCENES_FOLDER,
    name: STREAMED_ROOM_NAME,
    content: room,
    order: SCENE_SAVE_ORDER.subScene,
  });
  return saved.guid;
}

// ---------------------------------------------------------------------------
// Placement

/**
 * Class instance rows: `prefab-<suffix>` becomes `<actorId>-<suffix>` with
 * `sourceId` kept. `overrides` are instance-owned properties (`overrideKeys`).
 */
function instanceComponents(
  actorId: string,
  templates: readonly SerializedComponent[],
  overrides: Record<string, Record<string, unknown>> = {},
): SerializedComponent[] {
  const idOf = (id: string) => `${actorId}-${id.replace(/^prefab-/, "")}`;
  return templates.map((template) => {
    const override = overrides[template.id];
    return {
      ...structuredClone(template),
      id: idOf(template.id),
      parentId: template.parentId ? idOf(template.parentId) : null,
      sourceId: template.id,
      ...(override
        ? { properties: { ...structuredClone(template.properties), ...override }, overrideKeys: Object.keys(override) }
        : {}),
    };
  });
}

function placeScriptingZone(ctx: FeatureTestContext, refs: ScriptingRefs, types: ScriptingTypes): void {
  const zone = ctx.zone("scripting");
  zone.floor();
  const folder = (suffix: string, name: string) => {
    const id = `${zone.folderId}-${suffix}`;
    ctx.mainScene.folders.push({ id, name, parentFolderId: zone.folderId });
    return id;
  };
  const spinnersFolder = folder("spinners", "Spinners");
  const probesFolder = folder("probes", "Probes");
  const prefabsFolder = folder("prefabs", "Prefabs");
  const add = (entry: SerializedActor, folderId: string) => {
    entry.folderId = folderId;
    return ctx.addActor(entry, { zone: "scripting" });
  };
  const placeClass = (
    id: string,
    name: string,
    placed: PlacedClass,
    position: Vec3,
    folderId: string,
    options: { classId?: string; properties?: Record<string, unknown>; overrides?: Record<string, Record<string, unknown>> } = {},
  ) => add(actor(id, name, tf(position), instanceComponents(id, placed.components, options.overrides), {
    classId: options.classId ?? placed.ref.classId,
    ...(options.properties ? { properties: options.properties } : {}),
  }), folderId);

  // Spinner grid: Speed Mode per row, an extra Perf.Heavy Tag on the last column.
  const { columns, rows, spacing } = SPINNER_GRID;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const properties: Record<string, unknown> = { SpeedMode: SPEED_MODES[row % SPEED_MODES.length] };
      if (column === columns - 1) properties.ActorTags = { Tags: [types.tags.scripting, types.tags.perfHeavy] };
      placeClass(
        `ft-scripting-spinner-${row + 1}-${column + 1}`,
        `Spinner ${row + 1}-${column + 1}`,
        refs.spinner,
        zone.at(-10 + column * spacing, 1.2, -10 + row * spacing),
        spinnersFolder,
        { properties },
      );
    }
  }
  const emissive = ctx.assets.materials.emissive;
  placeClass("ft-scripting-spinner-fast", "Fast Spinner", refs.spinner, zone.at(2, 1.2, -9), spinnersFolder, {
    classId: CLASS.spinnerFast,
    properties: { SpeedMode: "Fast" },
    overrides: emissive ? { "prefab-mesh": { materialGuid: emissive } } : {},
  });

  placeClass("ft-scripting-interface-probe", "Interface Probe", refs.interfaceProbe, zone.at(4.5, 0.6, -9), probesFolder);
  placeClass("ft-scripting-data-probe", "Data Probe", refs.dataProbe, zone.at(7, 0.45, -9), probesFolder);
  placeClass("ft-scripting-save-probe", "Save Probe", refs.saveProbe, zone.at(9.5, 0.45, -9), probesFolder);

  [3, 6, 9].forEach((x, index) => {
    const id = `ft-scripting-marker-${index + 1}`;
    add(actor(id, `Prefab Marker ${index + 1}`, tf(zone.at(x, 0.75, -3)),
      instanceComponents(id, refs.marker.components), { prefabGuid: refs.marker.guid }), prefabsFolder);
  });

  const font = requireRef(ctx.assets.fonts.facetype, "the facetype Font");
  add(actor("ft-scripting-console-sign", "Console Commands Sign", tf(zone.at(6, 2.4, 11)), [
    textLabel("ft-scripting-console-sign-text", "Console: ft_spawn 10 | ft_stream | ft_stats", font, [0, 0, 0], 0.4),
  ]), zone.folderId);
}

/** Stream Loader (Scene Streaming Actor Class) targeting `FT_StreamedRoom`. */
function placeStreamingZone(ctx: FeatureTestContext, refs: ScriptingRefs): void {
  const zone = ctx.zone("streaming");
  zone.floor();
  const id = "ft-scripting-stream-loader";
  const target = { sceneGuid: refs.roomGuid, sceneName: STREAMED_ROOM_NAME };
  ctx.addActor(actor(id, "Stream Loader", tf(zone.at(0, 0, -1)),
    instanceComponents(id, refs.streamLoader.components, {
      "prefab-scene-streaming": target,
      "prefab-scene-name": { text: STREAMED_ROOM_NAME },
    }),
    { classId: refs.streamLoader.ref.classId }), { zone: "streaming" });
}
