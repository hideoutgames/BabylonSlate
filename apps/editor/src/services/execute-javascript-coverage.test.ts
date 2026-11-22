import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDefaultAnimGraph } from "@haptic/anim-graph";
import { ASSET_TYPES, findExecuteJavaScriptNodes, normalizeEmbeddedScript, type SerializedGraph } from "@haptic/core";
import type { ScriptBundleEntry } from "@haptic/bridge";
import { createExtensionSettings, normalizeExtensionContributions } from "@haptic/assets";
import { compileAnimGraphScripts, compileGraphDocuments } from "./script-compiler";
import { syncExtensionNodes } from "./extension-nodes";
import { defaultNodeRegistry } from "./graph-validation";
import { EMBEDDED_SCRIPT_OWNER_TYPES, SCRIPT_ASSET_TYPES } from "./play-asset-sources";
import { trustGateFindings, untrustedNodesMessage } from "./trust-gate";

/**
 * The import scan (`findExecuteJavaScriptNodes`) and the Play and export gate (the compiler's
 * `trustGatedNodes`) must see the same Execute JavaScript in every asset type that holds a
 * script graph. Every asset type is listed here, either with a document carrying the node where its
 * editor stores it and the compile path Play and export use, or as holding no script graph; a new
 * type fails until it is placed.
 */
const ENTRY = { id: "begin", type: "flow.event.beginPlay", position: { x: 0, y: 0 }, data: {} };
const executeJavaScript = (id: string) =>
  ({ id, type: "debug.executeJavaScript", position: { x: 200, y: 0 }, data: { body: `ctx.log(${JSON.stringify(id)});`, inputs: [], outputs: [] } });
const wire = (source: string, target: string, sourceHandle = "execOut") =>
  ({ id: `${source}-${target}`, source, target, sourceHandle, targetHandle: "execIn" });
const scriptGraph = (nodeId: string): SerializedGraph => ({ nodes: [ENTRY, executeJavaScript(nodeId)], edges: [wire("begin", nodeId)] });

/** The Execute JavaScript nodes a compiled script's trust gate records. */
const executeJavaScriptIds = (script: ScriptBundleEntry) =>
  (script.trustGatedNodes ?? []).filter((node) => node.kind === "executeJavaScript").map((node) => node.nodeId);

type Fixture = { document: Record<string, unknown>; compile: (document: Record<string, unknown>) => string[] };

const compiledClass = (content: SerializedGraph, classId = "Hero") =>
  compileGraphDocuments([{ path: `assets/${classId}.class.hasset`, content, parentClassId: "Actor" }], { throwOnError: true })
    .flatMap(executeJavaScriptIds);
const embeddedScript = (document: Record<string, unknown>, classId: string) =>
  compiledClass(normalizeEmbeddedScript(document.script)!, classId);
const animationGraph = (dimension: "3d" | "2d"): Fixture => {
  const graph = createDefaultAnimGraph("Loco", { dimension });
  graph.animationObject = {
    ...graph.animationObject,
    nodes: [...graph.animationObject.nodes, executeJavaScript("animation")],
    edges: [wire("event-initialize", "animation")],
  };
  return {
    document: graph as unknown as Record<string, unknown>,
    compile: (document) => compileAnimGraphScripts([{ guid: "loco", path: "assets/Loco.hasset", document }], { throwOnError: true })
      .flatMap(executeJavaScriptIds),
  };
};

const SCRIPT_GRAPH_FIXTURES: Record<string, Fixture> = {
  Class: {
    document: {
      ...scriptGraph("event"),
      members: [{ id: "fn", kind: "function", name: "Fire", pins: [] }],
      functionGraphs: {
        fn: {
          nodes: [{ id: "entry", type: "flow.function.input", position: { x: 0, y: 0 }, data: {} }, executeJavaScript("inFunction")],
          edges: [wire("entry", "inFunction", "exec")],
        },
      },
    },
    compile: (document) => compiledClass(document as unknown as SerializedGraph),
  },
  Scene: { document: { actors: [], script: scriptGraph("scene") }, compile: (document) => embeddedScript(document, "Scene_level") },
  SceneLayer: { document: { actors: [], script: scriptGraph("layer") }, compile: (document) => embeddedScript(document, "SceneLayer_hud") },
  AnimationGraph3D: animationGraph("3d"),
  AnimationGraph2D: animationGraph("2d"),
};

/** Types whose documents hold no script graph: data, media, and Material, Particle and other non-script graphs. */
const NO_SCRIPT_GRAPH = [
  "Animation", "Audio", "AudioChannel", "AudioMixer", "BehaviourTree", "Blackboard", "BlendSpace", "CameraShake",
  "ColorCurve", "DataDefinition", "DataTree", "Enum", "FloatCurve", "Font", "GlobalParameterCollection", "InputAction",
  "InputAxis", "Material", "MaterialFunction", "MaterialInstance", "Model", "ParticleEmitter", "ParticleGraph",
  "ParticleSystem", "PluginSettings", "Prefab", "RenderTarget", "RenderTargetTexture", "SaveGame", "ScriptInterface",
  "Skeleton", "SkyboxCreator", "SoundAttenuation", "Sprite", "SpriteAnimation", "SpriteBlendSpace", "Structure",
  "Texture", "Tilemap", "Tileset", "Timeline", "TimelineClip2D", "TimelineClip3D", "Trace", "VectorCurve", "Water",
];

describe("Execute JavaScript coverage of script graph assets", () => {
  it("places every asset type, and gives every type the Play compile reads a script fixture", () => {
    expect([...Object.keys(SCRIPT_GRAPH_FIXTURES), ...NO_SCRIPT_GRAPH].sort()).toEqual([...ASSET_TYPES].sort());
    for (const type of [...SCRIPT_ASSET_TYPES, ...EMBEDDED_SCRIPT_OWNER_TYPES]) expect(Object.keys(SCRIPT_GRAPH_FIXTURES)).toContain(type);
  });

  it.each(Object.entries(SCRIPT_GRAPH_FIXTURES))("%s: the import scan finds each node the compiler ships", (_type, fixture) => {
    const compiled = fixture.compile(fixture.document);
    expect(compiled.length).toBeGreaterThan(0);
    expect(findExecuteJavaScriptNodes(fixture.document).map((node) => node.nodeId).sort()).toEqual([...compiled].sort());
  });
});

/**
 * Which nodes Workspace Trust gates is the user's decision: Execute JavaScript with a body, Open URL and
 * every Extension node; Copy To Clipboard and Execute Console Command are not gated.
 */
describe("Trust-gated nodes", () => {
  beforeAll(() => syncExtensionNodes(defaultNodeRegistry(), [{
    extensionGuid: "net-guid", folderName: "net", folderPath: "extensions/net", settingsPath: "extensions/net/extension.json",
    contentPath: "extensions/net/assets", source: "engine", readOnly: true,
    settings: { ...createExtensionSettings("Net Tools", "net-guid"), editorOnly: false, libraryName: "net",
      contributes: normalizeExtensionContributions({ nodes: [
      { id: "ping", title: "Ping Server", call: "ping" },
      // An author may title an Extension node like a built-in one.
      { id: "spoof", title: "Open URL", call: "spoof" },
    ] }) },
  }]));
  afterAll(() => syncExtensionNodes(defaultNodeRegistry(), []));

  it("gates exactly Execute JavaScript and Open URL among the built-in nodes", () => {
    const gated = defaultNodeRegistry().list().filter((definition) => definition.trustGate && !definition.id.startsWith("extension."));
    expect(gated.map((definition) => [definition.id, definition.trustGate]).sort()).toEqual([
      ["debug.executeJavaScript", "executeJavaScript"],
      ["system.openUrl", "openUrl"],
    ]);
  });

  it("records each gated node a Class compiles, and neither Copy To Clipboard nor Execute Console Command", () => {
    const chain = ["js", "url", "ext", "copy", "console"];
    const graph: SerializedGraph = {
      nodes: [
        ENTRY,
        executeJavaScript("js"),
        { id: "url", type: "system.openUrl", position: { x: 400, y: 0 }, data: { "default:url": "https://example.com/" } },
        { id: "ext", type: "extension.net-guid.ping", position: { x: 600, y: 0 }, data: {} },
        { id: "copy", type: "system.copyToClipboard", position: { x: 800, y: 0 }, data: { "default:text": "hi" } },
        { id: "console", type: "debug.executeConsoleCommand", position: { x: 1000, y: 0 }, data: { "default:command": "stat fps" } },
      ],
      edges: chain.map((id, index) => wire(index === 0 ? "begin" : chain[index - 1]!, id)),
    };
    const scripts = compileGraphDocuments([{ path: "assets/Hero.class.hasset", content: graph, parentClassId: "Actor" }], { throwOnError: true });
    expect(scripts.flatMap((script) => script.trustGatedNodes ?? [])).toEqual([
      { nodeId: "js", kind: "executeJavaScript", title: "Execute JavaScript" },
      { nodeId: "url", kind: "openUrl", title: "Open URL" },
      { nodeId: "ext", kind: "extension", title: "Ping Server" },
    ]);
    // Each node did compile into the module, so the record is not missing them for want of code.
    const source = scripts.map((script) => script.source).join("\n");
    expect(source).toContain("ctx.copyToClipboard(");
    expect(source).toContain("executeConsoleCommandAsync(");
  });

  it("keeps an Extension node titled like Open URL apart from the real Open URL, and names it as an Extension node", () => {
    const graph: SerializedGraph = {
      nodes: [
        ENTRY,
        { id: "url", type: "system.openUrl", position: { x: 200, y: 0 }, data: { "default:url": "https://example.com/" } },
        { id: "spoof", type: "extension.net-guid.spoof", position: { x: 400, y: 0 }, data: {} },
      ],
      edges: [wire("begin", "url"), wire("url", "spoof")],
    };
    const scripts = compileGraphDocuments([
      { path: "assets/Menu.class.hasset", content: graph, parentClassId: "Actor" },
      { path: "assets/Shop.class.hasset", content: graph, parentClassId: "Actor" },
    ], { throwOnError: true });
    const findings = trustGateFindings(scripts, () => undefined);
    expect(findings).toEqual([
      { kind: "openUrl", title: "Open URL", assets: ["Menu", "Shop"] },
      { kind: "extension", title: "Open URL", assets: ["Menu", "Shop"] },
    ]);
    expect(untrustedNodesMessage(findings)).toContain(
      "so the Open URL in Menu and Shop; the Extension node Open URL in Menu and Shop cannot run.");
  });
});
